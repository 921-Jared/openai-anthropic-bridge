// 反向桥: 对外提供 Anthropic Messages 协议(/v1/messages)，后端走 OpenAI 兼容服务(/chat/completions)
// 用途: 让只认 Anthropic 协议的客户端(如 Claude Code)接入任意 OpenAI 兼容后端
// 由 server.mjs 在配置了 openaiBackend 时启动，与正向桥同进程

import http from 'node:http';

// OpenAI finish_reason -> Anthropic stop_reason
const FINISH_TO_STOP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'end_turn' };

// thinking 块的假签名: Anthropic 签名只在真 Anthropic 后端回放时校验，
// 本桥后端是 OpenAI 兼容服务，没有任何人会验签，给一个形似 base64 的固定占位即可
const FAKE_SIGNATURE = `bridge-${Buffer.from('openai-anthropic-bridge fake signature').toString('base64')}`;

function anthropicError(res, status, type, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

// Anthropic 请求 -> OpenAI 请求
// 支持: system(字符串/块数组) / text / tool_use->tool_calls / tool_result->role:tool / tools / tool_choice / modelMap
export function anthropicToOpenAI(body, modelMap = {}) {
  const messages = [];
  const systemText = typeof body.system === 'string'
    ? body.system
    : Array.isArray(body.system) ? body.system.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n\n') : '';
  if (systemText) messages.push({ role: 'system', content: systemText });

  const blockText = (blocks) => blocks.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('');

  for (const m of body.messages || []) {
    const c = m.content;
    const blocks = Array.isArray(c) ? c : null;

    if (m.role === 'assistant') {
      const text = blocks ? blockText(blocks) : (typeof c === 'string' ? c : '');
      const toolUses = blocks ? blocks.filter((b) => b?.type === 'tool_use') : [];
      // thinking 块在历史里丢弃: OpenAI 后端不认（reasoning_content 仅是输出概念）
      if (toolUses.length) {
        messages.push({
          role: 'assistant',
          content: text || null,
          tool_calls: toolUses.map((u) => ({
            id: u.id || `call_bridge_${Math.random().toString(36).slice(2)}`,
            type: 'function',
            function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) },
          })),
        });
      } else if (text) {
        messages.push({ role: 'assistant', content: text });
      }
      continue;
    }

    if (m.role === 'user' && blocks) {
      // tool_result 每个 -> 一条 role:tool 消息；剩余 text -> 一条 user 消息
      for (const tr of blocks.filter((b) => b?.type === 'tool_result')) {
        const content = Array.isArray(tr.content)
          ? tr.content.filter((p) => p?.type === 'text').map((p) => String(p.text ?? '')).join('')
          : String(tr.content ?? '');
        messages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content });
      }
      const text = blockText(blocks);
      if (text) messages.push({ role: 'user', content: text });
      continue;
    }

    // 普通字符串/数组内容
    if (typeof c === 'string') messages.push({ role: m.role, content: c });
    else if (blocks) {
      const text = blockText(blocks);
      if (text) messages.push({ role: m.role, content: text });
    } else messages.push({ role: m.role, content: String(c ?? '') });
  }

  const maxTokens = Number(body.max_tokens) > 0 ? Math.floor(Number(body.max_tokens)) : 4096;
  const out = { model: modelMap[body.model] || body.model, messages, max_tokens: maxTokens };
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (body.tools?.length) {
    out.tools = body.tools
      .filter((tt) => tt?.name)
      .map((tt) => ({ type: 'function', function: { name: tt.name, description: tt.description || '', parameters: tt.input_schema || { type: 'object' } } }));
    const tc = body.tool_choice;
    if (tc?.type === 'any') out.tool_choice = 'required';
    else if (tc?.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } };
    else if (tc?.type === 'auto' || !tc) out.tool_choice = 'auto';
  }
  return out;
}

// OpenAI 响应 -> Anthropic message JSON（支持: thinking / 文本 / tool_calls）
export function openaiToAnthropicMessage(resp, requestedModel) {
  const choice = resp.choices?.[0] || {};
  const text = choice.message?.content;
  const reasoning = choice.message?.reasoning_content;
  const content = [];
  if (typeof reasoning === 'string' && reasoning) content.push({ type: 'thinking', thinking: reasoning, signature: FAKE_SIGNATURE });
  if (typeof text === 'string' && text) content.push({ type: 'text', text });
  for (const tc of choice.message?.tool_calls || []) {
    let input = {};
    try { input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; }
    catch { input = { _raw: tc.function?.arguments }; }
    content.push({ type: 'tool_use', id: tc.id || `toolu_bridge_${Date.now()}`, name: tc.function?.name, input });
  }
  return {
    id: resp.id || `msg-bridge-${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: FINISH_TO_STOP[choice.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
    },
  };
}

// ---------------- 后端 SSE 解析(OpenAI chunks) ----------------

async function* openaiChunks(res) {
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
        const dataLines = [];
        for (const line of raw.split('\n')) if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        if (dataLines.length) yield dataLines.join('\n');
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

// ---------------- 流式翻译: OpenAI chunks -> Anthropic SSE ----------------

function writeAnthropicEvent(res, obj) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
}

async function streamAnthropicToClient(res, upstreamRes, model) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const msgId = `msg-bridge-${Date.now()}`;

  writeAnthropicEvent(res, {
    type: 'message_start',
    message: { id: msgId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  });

  let nextIndex = 0;
  let thinkBlockIdx = -1;
  let textBlockIdx = -1;
  const toolBlocks = new Map(); // openai工具index -> { idx, id, name, started, argsBuf }
  let finish = null;
  const usage = { prompt_tokens: 0, completion_tokens: 0 };

  try {
    for await (const data of openaiChunks(upstreamRes)) {
      if (data === '[DONE]') break;
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.usage) {
        usage.prompt_tokens = chunk.usage.prompt_tokens ?? usage.prompt_tokens;
        usage.completion_tokens = chunk.usage.completion_tokens ?? usage.completion_tokens;
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const d = choice.delta || {};
      if (typeof d.reasoning_content === 'string' && d.reasoning_content) {
        if (thinkBlockIdx < 0) {
          thinkBlockIdx = nextIndex++;
          writeAnthropicEvent(res, { type: 'content_block_start', index: thinkBlockIdx, content_block: { type: 'thinking', thinking: '', signature: null } });
        }
        writeAnthropicEvent(res, { type: 'content_block_delta', index: thinkBlockIdx, delta: { type: 'thinking_delta', thinking: d.reasoning_content } });
      }
      if (typeof d.content === 'string' && d.content) {
        if (textBlockIdx < 0) {
          textBlockIdx = nextIndex++;
          writeAnthropicEvent(res, { type: 'content_block_start', index: textBlockIdx, content_block: { type: 'text', text: '' } });
        }
        writeAnthropicEvent(res, { type: 'content_block_delta', index: textBlockIdx, delta: { type: 'text_delta', text: d.content } });
      }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const oi = tc.index ?? 0;
          if (!toolBlocks.has(oi)) toolBlocks.set(oi, { idx: nextIndex++, id: '', name: '', started: false, argsBuf: '' });
          const st = toolBlocks.get(oi);
          if (tc.id) st.id = tc.id;
          if (tc.function?.name) st.name = tc.function.name;
          if (tc.function?.arguments) st.argsBuf += tc.function.arguments;
          if (!st.started && st.name) {
            st.started = true;
            writeAnthropicEvent(res, { type: 'content_block_start', index: st.idx, content_block: { type: 'tool_use', id: st.id, name: st.name, input: {} } });
            if (st.argsBuf) {
              writeAnthropicEvent(res, { type: 'content_block_delta', index: st.idx, delta: { type: 'input_json_delta', partial_json: st.argsBuf } });
              st.argsBuf = '';
            }
          } else if (st.started && tc.function?.arguments) {
            writeAnthropicEvent(res, { type: 'content_block_delta', index: st.idx, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
          }
        }
      }
      if (choice.finish_reason) finish = FINISH_TO_STOP[choice.finish_reason] || 'end_turn';
    }
  } catch (err) {
    if (!res.writableEnded) {
      writeAnthropicEvent(res, { type: 'error', error: { type: 'api_error', message: String(err?.message || err) } });
    }
  } finally {
    try {
      if (!res.writableEnded) {
        if (thinkBlockIdx >= 0) {
          writeAnthropicEvent(res, { type: 'content_block_delta', index: thinkBlockIdx, delta: { type: 'signature_delta', signature: FAKE_SIGNATURE } });
          writeAnthropicEvent(res, { type: 'content_block_stop', index: thinkBlockIdx });
        }
        if (textBlockIdx >= 0) writeAnthropicEvent(res, { type: 'content_block_stop', index: textBlockIdx });
        for (const st of toolBlocks.values()) {
          if (st.started) writeAnthropicEvent(res, { type: 'content_block_stop', index: st.idx });
        }
        writeAnthropicEvent(res, { type: 'message_delta', delta: { stop_reason: finish || 'end_turn', stop_sequence: null }, usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens } });
        writeAnthropicEvent(res, { type: 'message_stop' });
        res.end();
      }
    } catch { /* 客户端已断开，忽略 */ }
  }
}

export function startAnthropicServer({ backend, backendKey, port, modelMap = {} }) {
  const server = http.createServer(async (req, res) => {
    const path = req.url.split('?')[0].replace(/\/+$/, '') || '/';
    const isMessages = (path === '/v1/messages' || path === '/messages') && req.method === 'POST';
    const isCountTokens = (path === '/v1/messages/count_tokens' || path === '/messages/count_tokens') && req.method === 'POST';
    if (req.method === 'GET' && (path === '/health' || path === '/healthz')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, backend, mode: 'anthropic' }));
      return;
    }
    if (!isMessages && !isCountTokens) {
      anthropicError(res, 404, 'not_found_error', `反向桥只提供 POST /v1/messages 与 /v1/messages/count_tokens，收到 ${req.method} ${path}`);
      return;
    }

    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 32 * 1024 * 1024) {
        anthropicError(res, 413, 'request_too_large', 'payload too large');
        return;
      }
      chunks.push(c);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { anthropicError(res, 400, 'invalid_request_error', 'invalid json body'); return; }

    const model = body.model || 'unknown';

    if (isCountTokens) {
      // 桩实现: OpenAI 后端没有 token 计数接口，用 chars/4 估算（对上下文预算足够）
      const text = JSON.stringify({ system: body.system ?? '', messages: body.messages ?? [] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: Math.max(1, Math.ceil(text.length / 4)) }));
      return;
    }

    console.log(`[reverse] ${new Date().toISOString()} POST /v1/messages model=${model} stream=${!!body.stream} msgs=${body.messages?.length ?? 0}`);

    const payload = anthropicToOpenAI(body, modelMap);
    const wantStream = !!body.stream;
    if (wantStream) {
      payload.stream = true;
      payload.stream_options = { include_usage: true };
    }
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 300000);
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });

    let upstreamRes;
    try {
      upstreamRes = await fetch(`${backend}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${backendKey}` },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (res.writableEnded || res.destroyed) return;
      console.error(`[reverse] 后端连接失败: ${err?.message || err}`);
      anthropicError(res, 502, 'api_error', `backend fetch failed: ${err?.message || err}`);
      return;
    }
    if (!upstreamRes.ok) {
      clearTimeout(timeout);
      const text = await upstreamRes.text().catch(() => '');
      console.error(`[reverse] 后端 ${upstreamRes.status}: ${text.slice(0, 300)}`);
      anthropicError(res, 502, 'api_error', `backend ${upstreamRes.status}: ${text.slice(0, 500)}`);
      return;
    }
    clearTimeout(timeout);

    if (wantStream) {
      await streamAnthropicToClient(res, upstreamRes, model);
      return;
    }

    let j;
    try { j = await upstreamRes.json(); }
    catch (err) {
      anthropicError(res, 502, 'api_error', `backend returned invalid json: ${err?.message || err}`);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(openaiToAnthropicMessage(j, model)));
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[reverse] 监听 http://127.0.0.1:${port} (Anthropic协议)  ->  ${backend} (OpenAI兼容)`);
  });
  return server;
}
