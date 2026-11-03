// openai-anthropic-bridge — 本地 OpenAI Chat Completions ↔ Anthropic Messages 协议转换代理
// 零依赖: Node >= 18 (内置 http + fetch)。仅监听 127.0.0.1，不对局域网开放。
// 配置优先级: 环境变量 > 同目录 config.json > 默认值
//   环境变量: JX_BRIDGE_UPSTREAM / JX_GATEWAY_API_KEY / JX_BRIDGE_PORT
//   config.json: { "upstream": "...", "apiKey": "...", "port": 3456 }  (已被 .gitignore 忽略)

import http from 'node:http';
import fs from 'node:fs';
import { startAnthropicServer } from './anthropic-serve.mjs';

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8')); } catch { /* 无配置文件 */ }

const UPSTREAM = (process.env.JX_BRIDGE_UPSTREAM || cfg.upstream || '').replace(/\/+$/, '');
const PORT = Number(process.env.JX_BRIDGE_PORT || cfg.port || 3456);
const API_KEY = process.env.JX_GATEWAY_API_KEY || cfg.apiKey || '';

// 反向桥(可选): 对外提供 Anthropic 协议，后端为 OpenAI 兼容服务
//   环境变量: BRIDGE_OPENAI_BACKEND / BRIDGE_OPENAI_KEY / BRIDGE_ANTHROPIC_PORT
//   config.json: { "openaiBackend": "http://127.0.0.1:3456/v1", "openaiBackendKey": "...", "anthropicPort": 4567 }
const OPENAI_BACKEND = (process.env.BRIDGE_OPENAI_BACKEND || cfg.openaiBackend || '').replace(/\/+$/, '');

const FORWARD_READY = !!(UPSTREAM && API_KEY);
const REVERSE_READY = !!OPENAI_BACKEND;
if (!FORWARD_READY && !REVERSE_READY) {
  console.error('[bridge] 缺少配置: 正向桥需要 upstream(Anthropic 兼容网关地址)+apiKey，反向桥需要 openaiBackend(OpenAI 兼容后端地址)，至少配一个。');
  console.error('[bridge] 方式一: 运行 node install.mjs 交互配置; 方式二: 环境变量(见文件头注释)');
  process.exit(1);
}
if (!FORWARD_READY) console.warn('[bridge] 未配置正向桥(upstream/apiKey)，仅启动反向桥。');

// 常驻进程保命：任何未捕获异常只记日志，绝不退出进程
process.on('uncaughtException', (err) => { console.error(`[bridge] uncaughtException: ${err?.stack || err}`); });
process.on('unhandledRejection', (err) => { console.error(`[bridge] unhandledRejection: ${err?.stack || err}`); });

// ---------------- OpenAI -> Anthropic 请求翻译 ----------------

function translateRequest(body) {
  const systemParts = [];
  const msgs = [];
  let lastRole = null;

  const pushMsg = (role, content) => {
    // Anthropic 要求 user/assistant 严格交替，连续同角色合并
    if (msgs.length && msgs[msgs.length - 1].role === role && role === lastRole) {
      msgs[msgs.length - 1].content.push(...content);
    } else {
      msgs.push({ role, content });
    }
    lastRole = role;
  };

  const textPartsToBlocks = (content) => {
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    if (Array.isArray(content)) {
      return content.map((p) => {
        if (p?.type === 'text') return { type: 'text', text: String(p.text ?? '') };
        if (p?.type === 'image_url' && p.image_url?.url) {
          const u = p.image_url.url;
          if (u.startsWith('data:image/')) {
            const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(u);
            if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
          }
          return { type: 'text', text: '[不支持的图片引用]' };
        }
        return { type: 'text', text: '[未知内容块]' };
      });
    }
    return [{ type: 'text', text: String(content ?? '') }];
  };

  for (const m of body.messages || []) {
    if (m.role === 'system' || m.role === 'developer') {
      if (typeof m.content === 'string') systemParts.push(m.content);
      else if (Array.isArray(m.content)) {
        for (const p of m.content) if (p?.type === 'text') systemParts.push(String(p.text ?? ''));
      }
      continue;
    }
    if (m.role === 'user') {
      pushMsg('user', textPartsToBlocks(m.content));
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      // OpenAI 客户端回传的思考(DeepSeek 风格 reasoning_content 或 reasoning) -> thinking 块
      const reasoning = m.reasoning_content ?? m.reasoning;
      if (typeof reasoning === 'string' && reasoning) blocks.push({ type: 'thinking', thinking: reasoning, signature: '' });
      if (m.content) {
        if (typeof m.content === 'string' && m.content) blocks.push({ type: 'text', text: m.content });
        else if (Array.isArray(m.content)) {
          for (const p of m.content) if (p?.type === 'text' && p.text) blocks.push({ type: 'text', text: p.text });
        }
      }
      for (const tc of m.tool_calls || []) {
        let input = {};
        try { input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; }
        catch { input = { _raw: tc.function?.arguments }; }
        blocks.push({ type: 'tool_use', id: tc.id || `call_${Math.random().toString(36).slice(2)}`, name: tc.function?.name, input });
      }
      // 部分网关(如思考模式的 glm/deepseek 档)要求带工具调用的 assistant 消息必须回传 thinking，
      // 而 OpenAI 客户端多数不回传 -> 补空占位(实测空 thinking 即可通过存在性校验)
      if (m.tool_calls?.length && !blocks.some((b) => b.type === 'thinking')) {
        blocks.unshift({ type: 'thinking', thinking: '', signature: '' });
      }
      if (blocks.length) pushMsg('assistant', blocks);
      continue;
    }
    if (m.role === 'tool') {
      let content;
      if (typeof m.content === 'string') content = [{ type: 'text', text: m.content }];
      else if (Array.isArray(m.content)) {
        content = m.content
          .filter((p) => p?.type === 'text')
          .map((p) => ({ type: 'text', text: String(p.text ?? '') }));
        if (!content.length) content = [{ type: 'text', text: '(空)' }];
      } else content = [{ type: 'text', text: String(m.content ?? '') }];
      pushMsg('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content }]);
      continue;
    }
  }

  const out = { model: body.model, messages: msgs, max_tokens: clampMaxTokens(body) };
  if (systemParts.length) out.system = systemParts.join('\n\n');
  if (body.tools?.length && body.tool_choice !== 'none') {
    out.tools = body.tools
      .filter((t) => t?.type === 'function' && t.function?.name)
      .map((t) => {
        const schema = { ...(t.function.parameters || { type: 'object' }) };
        delete schema.strict;
        return { name: t.function.name, description: t.function.description || '', input_schema: schema };
      });
    const tc = body.tool_choice;
    if (tc === 'required') out.tool_choice = { type: 'any' };
    else if (tc && typeof tc === 'object' && tc.function?.name) out.tool_choice = { type: 'tool', name: tc.function.name };
  }
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  return out;
}

function clampMaxTokens(body) {
  const raw = body.max_completion_tokens ?? body.max_tokens;
  const n = Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : 4096;
  return Math.min(Math.max(Math.floor(n), 1), 64000);
}

// ---------------- Anthropic -> OpenAI 响应翻译 ----------------

const STOP_MAP = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', refusal: 'stop' };

function extractText(blocks) {
  return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
}
function extractReasoning(blocks) {
  return blocks.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('');
}
function extractToolCalls(blocks) {
  return blocks
    .filter((b) => b.type === 'tool_use')
    .map((b, i) => ({
      id: b.id, type: 'function', index: i,
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }));
}

function translateNonStream(resp, model) {
  const blocks = resp.content || [];
  const message = { role: 'assistant', content: extractText(blocks) };
  const reasoning = extractReasoning(blocks);
  if (reasoning) message.reasoning_content = reasoning;
  const toolCalls = extractToolCalls(blocks);
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: resp.id || 'chatcmpl-bridge', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message, finish_reason: STOP_MAP[resp.stop_reason] || 'stop' }],
    usage: {
      prompt_tokens: resp.usage?.input_tokens ?? 0,
      completion_tokens: resp.usage?.output_tokens ?? 0,
      total_tokens: (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0),
    },
  };
}

// ---------------- 上游 SSE 解析 ----------------

async function* sseEvents(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        const dataLines = [];
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length) yield { event, data: dataLines.join('\n') };
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

// ---------------- 流式翻译并下发 ----------------

function writeSSE(res, obj) {
  if (res.destroyed || res.writableEnded) return; // 客户端已断开，静默丢弃
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

async function streamToClient(res, upstreamRes, model, wantUsage) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const id = `chatcmpl-bridge-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: 'chat.completion.chunk', created, model };
  let emittedRole = false;
  let toolIndex = -1;   // 仅统计 tool_use 块
  let sawToolUse = false;
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  let finish = 'stop';

  const roleChunk = () => {
    if (emittedRole) return;
    emittedRole = true;
    writeSSE(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  };

  try {
    for await (const { event, data } of sseEvents(upstreamRes)) {
      if (event === 'ping') continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }

      switch (ev.type) {
        case 'message_start':
          roleChunk();
          if (ev.message?.usage) usage.prompt_tokens = ev.message.usage.input_tokens ?? 0;
          break;
        case 'content_block_start':
          if (ev.content_block?.type === 'tool_use') {
            sawToolUse = true;
            toolIndex += 1;
            roleChunk();
            writeSSE(res, {
              ...base,
              choices: [{
                index: 0,
                delta: { tool_calls: [{ index: toolIndex, id: ev.content_block.id, type: 'function', function: { name: ev.content_block.name, arguments: '' } }] },
                finish_reason: null,
              }],
            });
          }
          break;
        case 'content_block_delta': {
          const d = ev.delta || {};
          if (d.type === 'text_delta' && d.text) {
            roleChunk();
            writeSSE(res, { ...base, choices: [{ index: 0, delta: { content: d.text }, finish_reason: null }] });
          } else if (d.type === 'thinking_delta' && d.thinking) {
            roleChunk();
            writeSSE(res, { ...base, choices: [{ index: 0, delta: { reasoning_content: d.thinking }, finish_reason: null }] });
          } else if (d.type === 'input_json_delta' && d.partial_json) {
            writeSSE(res, {
              ...base,
              choices: [{ index: 0, delta: { tool_calls: [{ index: toolIndex, function: { arguments: d.partial_json } }] }, finish_reason: null }],
            });
          }
          break;
        }
        case 'message_delta':
          if (ev.delta?.stop_reason) finish = STOP_MAP[ev.delta.stop_reason] || 'stop';
          if (ev.usage) usage.completion_tokens = ev.usage.output_tokens ?? usage.completion_tokens;
          break;
        case 'message_stop':
          writeSSE(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: sawToolUse ? 'tool_calls' : finish }] });
          if (wantUsage) {
            writeSSE(res, {
              ...base, choices: [],
              usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
            });
          }
          break;
        case 'error':
          writeSSE(res, { error: { message: ev.error?.message || 'upstream error', type: 'upstream_error', code: ev.error?.type } });
          break;
        default:
          break;
      }
    }
  } catch (err) {
    if (!res.writableEnded) {
      writeSSE(res, { error: { message: String(err?.message || err), type: 'bridge_stream_error' } });
    }
  } finally {
    try {
      if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
    } catch { /* 客户端已断开，忽略 */ }
  }
}

// ---------------- HTTP 服务 ----------------

const server = http.createServer(async (req, res) => {
  const path = req.url.split('?')[0].replace(/\/+$/, '') || '/';
  const log = `${new Date().toISOString()} ${req.method} ${path}`;

  if (req.method === 'GET' && (path === '/health' || path === '/healthz')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstream: UPSTREAM }));
    return;
  }

  if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
    try {
      const r = await fetch(`${UPSTREAM}/v1/models`, { headers: { 'x-api-key': API_KEY } });
      const j = await r.json();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(j));
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(err?.message || err) } }));
    }
    return;
  }

  const isChat = (path === '/v1/chat/completions' || path === '/chat/completions') && req.method === 'POST';
  if (!isChat) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `bridge: 不支持的路径 ${req.method} ${path}（本代理只提供 /v1/chat/completions）` } }));
    return;
  }

  // 读取请求体
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 32 * 1024 * 1024) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'payload too large' } }));
      return;
    }
    chunks.push(c);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid json body' } }));
    return;
  }

  const model = body.model || 'unknown';
  const wantStream = !!body.stream;
  const wantUsage = !!(body.stream_options?.include_usage);
  console.log(`${log} model=${model} stream=${wantStream} msgs=${body.messages?.length ?? 0} tools=${body.tools?.length ?? 0}`);

  const payload = translateRequest(body);
  payload.stream = wantStream;
  const ac = new AbortController();
  // 客户端断开才中止上游（req 的 close 在请求体读完即触发，不能用作断开信号）
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });

  let upstreamRes;
  try {
    upstreamRes = await fetch(`${UPSTREAM}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
  } catch (err) {
    if (ac.signal.aborted) return;
    console.error(`${log} 上游连接失败: ${err?.message || err}`);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `upstream fetch failed: ${err?.message || err}`, type: 'bridge_upstream_error' } }));
    return;
  }

  if (!upstreamRes.ok) {
    const text = await upstreamRes.text().catch(() => '');
    console.error(`${log} 上游 ${upstreamRes.status}: ${text.slice(0, 300)}`);
    res.writeHead(upstreamRes.status === 401 || upstreamRes.status === 403 ? 502 : upstreamRes.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `upstream ${upstreamRes.status}: ${text.slice(0, 500)}`, type: 'upstream_error' } }));
    return;
  }

  if (wantStream) {
    try {
      await streamToClient(res, upstreamRes, model, wantUsage);
    } catch (err) {
      console.error(`${log} 流式下发异常: ${err?.message || err}`);
      try { if (!res.writableEnded) res.end(); } catch { /* ignore */ }
    }
  } else {
    let j;
    try { j = await upstreamRes.json(); }
    catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `upstream returned invalid json: ${err?.message || err}` } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(translateNonStream(j, model)));
  }
});

if (FORWARD_READY) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[bridge] 正向桥监听 http://127.0.0.1:${PORT}  ->  ${UPSTREAM}`);
    console.log(`[bridge] 客户端(如 WorkBuddy)接口地址填: http://127.0.0.1:${PORT}/v1`);
  });
}

if (REVERSE_READY) {
  let modelMap = { ...(cfg.modelMap || {}) };
  if (process.env.BRIDGE_MODEL_MAP) {
    try { modelMap = { ...modelMap, ...JSON.parse(process.env.BRIDGE_MODEL_MAP) }; }
    catch { console.warn('[bridge] BRIDGE_MODEL_MAP 不是合法 JSON，已忽略'); }
  }
  startAnthropicServer({
    backend: OPENAI_BACKEND,
    backendKey: process.env.BRIDGE_OPENAI_KEY || cfg.openaiBackendKey || 'sk-anonymous',
    port: Number(process.env.BRIDGE_ANTHROPIC_PORT || cfg.anthropicPort || 4567),
    modelMap,
  });
}
