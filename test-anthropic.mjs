// 反向桥回归套件: node test-anthropic.mjs [anthropicPort]
// 前提: 反向桥已运行(默认4567), 且其 openaiBackend 指向一个可用的 OpenAI 兼容服务
// 测试链: Anthropic格式请求 → 反向桥(4567) → OpenAI后端 → Anthropic格式响应

const PORT = Number(process.argv[2] || process.env.BRIDGE_ANTHROPIC_PORT || 4567);
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL = process.env.TEST_MODEL || 'your-model-name'; // 活链测试需要真实模型名: TEST_MODEL=xxx node test-anthropic.mjs

const H = { 'content-type': 'application/json', 'x-api-key': 'sk-any', 'anthropic-version': '2023-06-01' };
let pass = 0, failN = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { failN++; console.error(`  FAIL ${name} ${extra}`); }
};

async function messages(body) {
  try {
    const r = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
    let json = null;
    try { json = await r.json(); } catch { /* body 非json */ }
    return { status: r.status, json };
  } catch (e) { return { status: 0, json: null, err: String(e?.cause?.code || e?.message || e) }; }
}

console.log(`=== 反向桥测试套件 @ ${BASE} (model=${MODEL}) ===\n`);

// A1 非流式纯文本
{
  const { status, json } = await messages({ model: MODEL, max_tokens: 1024, messages: [{ role: 'user', content: 'reply with exactly: OK' }] });
  const block = json?.content?.find?.((b) => b.type === 'text');
  t('A1 非流式文本: type=message + text块', status === 200 && json?.type === 'message' && json?.role === 'assistant' && typeof block?.text === 'string' && block.text.length > 0, JSON.stringify(json).slice(0, 200));
  t('A1.1 stop_reason=end_turn', json?.stop_reason === 'end_turn', `got=${json?.stop_reason}`);
  t('A1.2 usage 映射', typeof json?.usage?.input_tokens === 'number' && typeof json?.usage?.output_tokens === 'number');
}

// A2 流式: Anthropic SSE 事件序列
{
  const r = await fetch(`${BASE}/v1/messages`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: [{ role: 'user', content: 'reply with exactly: OK' }] }),
    signal: AbortSignal.timeout(90000),
  });
  const ctype = r.headers.get('content-type') || '';
  const text = await r.text();
  // 解析 SSE 事件流
  const events = [];
  for (const block of text.split('\n\n')) {
    const ev = { event: 'message', data: '' };
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) ev.event = line.slice(6).trim();
      else if (line.startsWith('data:')) ev.data += line.slice(5).trim();
    }
    if (ev.data) { try { ev.json = JSON.parse(ev.data); } catch { /* keep raw */ } events.push(ev); }
  }
  const types = events.map((e) => e.json?.type || e.event);
  const start = events.find((e) => e.json?.type === 'message_start');
  const textDeltas = events.filter((e) => e.json?.type === 'content_block_delta' && e.json?.delta?.type === 'text_delta');
  const assembled = textDeltas.map((e) => e.json.delta.text).join('');
  const msgDelta = events.find((e) => e.json?.type === 'message_delta');
  t('A2 SSE content-type', r.status === 200 && ctype.includes('text/event-stream'), `status=${r.status} ctype=${ctype}`);
  t('A2.1 message_start(role=assistant)', !!start && start.json?.message?.role === 'assistant' && Array.isArray(start.json?.message?.content));
  t('A2.2 text块序列(start→delta→stop)', types.includes('content_block_start') && textDeltas.length > 0 && assembled.length > 0 && types.includes('content_block_stop'), `assembled="${assembled.slice(0, 40)}"`);
  t('A2.3 message_delta(stop_reason)+message_stop', !!msgDelta?.json?.delta?.stop_reason && types.includes('message_stop'), `types=${types.join(',')}`);
}

// A3/A4 确定性 mock 组: 自带 mock OpenAI 后端(支持 thinking/工具 canned 输出 + /last 回显翻译后请求)
{
  const { spawn } = await import('node:child_process');
  const REPO = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const BJ = '北京'; // 北京, mock 侧避免非 ASCII

  // mock 后端
  const mock = spawn(process.execPath, ['-e', `
    const http = require('node:http');
    let lastBody = null;
    http.createServer((req, res) => {
      if (req.url.includes('/last')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(lastBody)); return; }
      if (req.url.includes('/chat/completions')) {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const b = JSON.parse(body); lastBody = b;
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const send = (o) => res.write('data: ' + JSON.stringify(o) + '\\n\\n');
          const TOOL_ARGS = '{\\"city\\":\\"${BJ}\\"}';
          if (!b.stream) {
            if (b.tools?.length) {
              res.end(JSON.stringify({ id: 'mock-3', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_mock_1', type: 'function', function: { name: 'get_weather', arguments: '{\\"city\\":\\"${BJ}\\"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 7 } }));
              return;
            }
            res.end(JSON.stringify({ id: 'mock-1', choices: [{ index: 0, message: { role: 'assistant', content: 'Final answer.', reasoning_content: 'Let me think.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } }));
            return;
          }
          const id = 'mock-2';
          send({ id, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
          if (b.tools?.length) {
            send({ id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] });
            send({ id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{\\"city\\"' } }] }, finish_reason: null }] });
            send({ id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':\\"${BJ}\\"}' } }] }, finish_reason: null }] });
            send({ id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
          } else {
            send({ id, choices: [{ index: 0, delta: { reasoning_content: 'Let me ' }, finish_reason: null }] });
            send({ id, choices: [{ index: 0, delta: { reasoning_content: 'think.' }, finish_reason: null }] });
            send({ id, choices: [{ index: 0, delta: { content: 'Final ' }, finish_reason: null }] });
            send({ id, choices: [{ index: 0, delta: { content: 'answer.' }, finish_reason: null }] });
            send({ id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          }
          send({ id, choices: [], usage: { prompt_tokens: 5, completion_tokens: 7 } });
          res.write('data: [DONE]\\n\\n'); res.end();
        });
      } else { res.writeHead(404); res.end(); }
    }).listen(4599, '127.0.0.1');
  `], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));

  // 反向桥实例指向 mock（带 modelMap）
  const rev = spawn(process.execPath, [`${REPO}server.mjs`], {
    env: { ...process.env, BRIDGE_OPENAI_BACKEND: 'http://127.0.0.1:4599/v1', BRIDGE_OPENAI_KEY: 'sk-mock', BRIDGE_ANTHROPIC_PORT: '4568', BRIDGE_MODEL_MAP: '{"claude-test-alias":"mapped-model"}' },
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 800));

  try {
    const RB = 'http://127.0.0.1:4568';
    const parseSSE = (raw) => {
      const events = [];
      for (const block of raw.split('\n\n')) {
        for (const line of block.split('\n')) {
          if (line.startsWith('data:')) { try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* raw */ } }
        }
      }
      return events;
    };

    // A3 非流式: reasoning_content -> thinking 块在前, text 块在后, signature 非空
    {
      const r = await fetch(`${RB}/v1/messages`, { method: 'POST', headers: H, body: JSON.stringify({ model: 'mock-model', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }) });
      const j = await r.json();
      const think = j?.content?.find?.((b) => b.type === 'thinking');
      const text = j?.content?.find?.((b) => b.type === 'text');
      t('A3 非流式 thinking块在前+signature', r.status === 200 && think?.thinking === 'Let me think.' && typeof think?.signature === 'string' && think.signature.length > 0, JSON.stringify(j?.content));
      t('A3.1 非流式 text块在后', text?.text === 'Final answer.', JSON.stringify(j?.content));
    }
    // A3.2 流式: thinking 块序列(index0) + text 块(index1)
    {
      const r = await fetch(`${RB}/v1/messages`, { method: 'POST', headers: H, body: JSON.stringify({ model: 'mock-model', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
      const events = parseSSE(await r.text());
      const thinkStart = events.find((e) => e.type === 'content_block_start' && e.content_block?.type === 'thinking');
      const thinkAssembled = events.filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta').map((e) => e.delta.thinking).join('');
      const textStart = events.find((e) => e.type === 'content_block_start' && e.content_block?.type === 'text');
      const textAssembled = events.filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'text_delta').map((e) => e.delta.text).join('');
      t('A3.2 流式 thinking块(index0)+delta累积', thinkStart?.index === 0 && thinkAssembled === 'Let me think.', `assembled="${thinkAssembled}"`);
      t('A3.3 流式 text块(index1)在thinking后', textStart?.index === 1 && textAssembled === 'Final answer.', `text="${textAssembled}" idx=${textStart?.index}`);
    }

    // A4 工具调用: 请求方向翻译 + 响应方向 tool_use
    const TOOL_REQ = {
      model: 'mock-model', max_tokens: 64,
      tools: [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
      tool_choice: { type: 'auto' },
      messages: [
        { role: 'user', content: '北京天气?' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_mock_1', name: 'get_weather', input: { city: '北京' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_mock_1', content: [{ type: 'text', text: '晴 25度' }] }, { type: 'text', text: '谢谢' }] },
      ],
    };
    // A4 非流式: tool_use 块 + stop_reason=tool_use
    {
      const r = await fetch(`${RB}/v1/messages`, { method: 'POST', headers: H, body: JSON.stringify(TOOL_REQ) });
      const j = await r.json();
      const tu = j?.content?.find?.((b) => b.type === 'tool_use');
      t('A4 非流式 tool_use块(id/name/input)', r.status === 200 && tu?.id === 'call_mock_1' && tu?.name === 'get_weather' && tu?.input?.city === '北京', JSON.stringify(j?.content));
      t('A4.1 非流式 stop_reason=tool_use', j?.stop_reason === 'tool_use', `got=${j?.stop_reason}`);
    }
    // A4.2 请求方向翻译(tools/tool_choice/tool_use->tool_calls/tool_result->role:tool)
    {
      const last = await (await fetch('http://127.0.0.1:4599/last')).json();
      const fn = last?.tools?.[0];
      const asst = last?.messages?.find?.((m) => m.role === 'assistant');
      const toolMsg = last?.messages?.find?.((m) => m.role === 'tool');
      const userAfter = last?.messages?.filter?.((m) => m.role === 'user').pop();
      const tcOk = fn?.type === 'function' && fn?.function?.name === 'get_weather' && fn?.function?.description === '查天气' && !!fn?.function?.parameters?.properties?.city;
      const asstOk = Array.isArray(asst?.tool_calls) && asst.tool_calls[0]?.id === 'toolu_mock_1' && asst.tool_calls[0]?.function?.name === 'get_weather' && JSON.parse(asst.tool_calls[0]?.function?.arguments || '{}')?.city === '北京';
      const toolOk = toolMsg?.tool_call_id === 'toolu_mock_1' && toolMsg?.content === '晴 25度';
      const userOk = userAfter?.content === '谢谢';
      t('A4.2 tools+tool_choice 翻译', tcOk && last?.tool_choice === 'auto', JSON.stringify(last?.tools));
      t('A4.3 tool_use->tool_calls', asstOk, JSON.stringify(asst));
      t('A4.4 tool_result->role:tool + text->user', toolOk && userOk, `tool=${JSON.stringify(toolMsg)} user=${JSON.stringify(userAfter)}`);
    }
    // A4.5 流式: tool_use 块 start + input_json_delta 累积 + stop_reason
    {
      const r = await fetch(`${RB}/v1/messages`, { method: 'POST', headers: H, body: JSON.stringify({ ...TOOL_REQ, stream: true }) });
      const events = parseSSE(await r.text());
      const tuStart = events.find((e) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use');
      const argsAssembled = events.filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta').map((e) => e.delta.partial_json).join('');
      const msgDelta = events.find((e) => e.type === 'message_delta');
      const argsOk = (() => { try { return JSON.parse(argsAssembled)?.city === '北京'; } catch { return false; } })();
      t('A4.5 流式 tool_use块(id/name/input:{})', tuStart?.content_block?.id === 'call_mock_1' && tuStart?.content_block?.name === 'get_weather' && tuStart?.content_block?.input && typeof tuStart.content_block.input === 'object', JSON.stringify(tuStart));
      t('A4.6 流式 input_json_delta 累积', argsOk, `assembled="${argsAssembled}"`);
      t('A4.7 流式 stop_reason=tool_use', msgDelta?.delta?.stop_reason === 'tool_use', JSON.stringify(msgDelta));
    }

    // A7 反向桥健康探针(watchdog 依赖)
    {
      const r = await fetch(`${RB}/health`);
      const j = await r.json().catch(() => null);
      t('A7 GET /health -> ok+backend', r.status === 200 && j?.ok === true && typeof j?.backend === 'string', JSON.stringify(j));
    }

    // A5 Claude Code 兼容项: system数组/cache_control剥离/count_tokens/modelMap
    {
      // A5.1+A5.2 system 数组形态 + cache_control 全剥 + modelMap
      const r = await fetch(`${RB}/v1/messages`, {
        method: 'POST', headers: H,
        body: JSON.stringify({
          model: 'claude-test-alias', max_tokens: 32,
          system: [{ type: 'text', text: 'You are terse.', cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }] }],
        }),
      });
      await r.json();
      const last = await (await fetch('http://127.0.0.1:4599/last')).json();
      const sys = last?.messages?.find?.((m) => m.role === 'system');
      t('A5.1 system数组形态 -> system消息', sys?.content === 'You are terse.', JSON.stringify(last?.messages?.[0]));
      t('A5.2 cache_control 全部剥离', !JSON.stringify(last).includes('cache_control'), JSON.stringify(last).slice(0, 150));
      t('A5.3 modelMap 模型名映射', last?.model === 'mapped-model', `got=${last?.model}`);
    }
    // A5.4 count_tokens 桩: input_tokens = chars/4 量级
    {
      const r = await fetch(`${RB}/v1/messages/count_tokens`, {
        method: 'POST', headers: H,
        body: JSON.stringify({ model: 'claude-test-alias', messages: [{ role: 'user', content: '12345678123456781234567812345678' }] }),
      });
      const j = await r.json();
      // 32字符正文/4=8 为下限; JSON包装开销约2x 为上限(41)
      t('A5.4 count_tokens 返回量级正确', r.status === 200 && typeof j?.input_tokens === 'number' && j.input_tokens >= 8 && j.input_tokens <= 41, JSON.stringify(j));
    }
  } finally {
    mock.kill(); rev.kill();
  }
}

// A6 错误契约锁定: Anthropic 风格错误体(对活链4567, 行为由 S2 起已实现, 此处防回归)
{
  const r1 = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'sk-any' }, body: '{invalid json' });
  const j1 = await r1.json();
  t('A6 非法JSON -> 400 Anthropic错误体', r1.status === 400 && j1?.type === 'error' && j1?.error?.type === 'invalid_request_error' && typeof j1?.error?.message === 'string', JSON.stringify(j1));
  const r2 = await fetch(`${BASE}/v1/unknown`, { method: 'POST', headers: H });
  const j2 = await r2.json();
  t('A6.1 未知路径 -> 404 not_found_error', r2.status === 404 && j2?.type === 'error' && j2?.error?.type === 'not_found_error', JSON.stringify(j2));
}

console.log(`\n结果: ${pass} 通过, ${failN} 失败`);
process.exit(failN ? 1 : 0);
