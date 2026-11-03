// 回归测试套件: node test.mjs [port]
// 需要桥已在指定端口运行且上游可用。覆盖: 健康/模型列表/非流式/流式/工具(非流式+流式+回传闭环)/流中断韧性

const PORT = Number(process.argv[2] || process.env.BRIDGE_PORT || 3456);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = process.env.BRIDGE_API_KEY || 'sk-local';
const MODEL = process.env.TEST_MODEL || 'your-model-name'; // 活链测试需要真实模型名: TEST_MODEL=xxx node test.mjs

const H = { 'content-type': 'application/json', authorization: `Bearer ${KEY}` };
let pass = 0, failN = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { failN++; console.error(`  FAIL ${name} ${extra}`); }
};

const TOOLS = [{ type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];

async function chat(body) {
  const r = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

console.log(`=== openai-anthropic-bridge 测试套件 @ ${BASE} (model=${MODEL}) ===\n`);

// T1 健康
{
  const r = await fetch(`${BASE}/health`).then((x) => x.json());
  t('T1 health', r.ok === true);
}
// T2 models
{
  const r = await fetch(`${BASE}/v1/models`, { headers: H });
  const j = await r.json().catch(() => null);
  t('T2 models 列表', r.status === 200 && Array.isArray(j?.data), `status=${r.status}`);
}
// T3 非流式文本
{
  const { status, json } = await chat({ model: MODEL, stream: false, messages: [{ role: 'user', content: 'reply with exactly: OK' }] });
  const m = json?.choices?.[0]?.message;
  t('T3 非流式文本', status === 200 && typeof m?.content === 'string' && m.content.length > 0, JSON.stringify(json).slice(0, 120));
  t('T3.1 finish_reason', json?.choices?.[0]?.finish_reason === 'stop');
}
// T4 流式
{
  const r = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify({ model: MODEL, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'count 1 to 3' }] }), signal: AbortSignal.timeout(90000) });
  const text = await r.text();
  const lines = text.split('\n').filter((l) => l.startsWith('data: '));
  const chunks = lines.map((l) => l.slice(6).trim()).filter((d) => d !== '[DONE]').map((d) => { try { return JSON.parse(d); } catch { return null; } });
  const hasRole = chunks.some((c) => c?.choices?.[0]?.delta?.role === 'assistant');
  const hasContent = chunks.some((c) => typeof c?.choices?.[0]?.delta?.content === 'string' && c.choices[0].delta.content);
  const hasFinish = chunks.some((c) => c?.choices?.[0]?.finish_reason === 'stop');
  t('T4.1 流式 role 首块', hasRole);
  t('T4.2 流式内容增量', hasContent);
  t('T4.3 流式 finish_reason', hasFinish);
  t('T4.4 [DONE] 收尾', text.includes('data: [DONE]'));
}
// T5 工具-非流式
{
  const { status, json } = await chat({ model: MODEL, stream: false, messages: [{ role: 'user', content: 'Weather in Beijing? Use the tool.' }], tools: TOOLS, tool_choice: 'auto' });
  const tc = json?.choices?.[0]?.message?.tool_calls?.[0];
  t('T5 工具非流式', status === 200 && tc?.function?.name === 'get_weather' && JSON.parse(tc.function.arguments).city, JSON.stringify(json).slice(0, 150));
  t('T5.1 finish_reason=tool_calls', json?.choices?.[0]?.finish_reason === 'tool_calls');
}
// T6 工具-流式
{
  const r = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'user', content: 'Weather in Tokyo? Use the tool.' }], tools: TOOLS }), signal: AbortSignal.timeout(90000) });
  const text = await r.text();
  const chunks = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6).trim()).filter((d) => d !== '[DONE]').map((d) => { try { return JSON.parse(d); } catch { return null; } });
  const start = chunks.flatMap((c) => c?.choices?.[0]?.delta?.tool_calls || []).find((tc) => tc.id && tc.function?.name);
  const args = chunks.flatMap((c) => c?.choices?.[0]?.delta?.tool_calls || []).filter((tc) => tc.function?.arguments).map((tc) => tc.function.arguments).join('');
  t('T6.1 工具流式首块(id+name)', Boolean(start), text.slice(0, 200));
  let argsOk = false; try { argsOk = Boolean(JSON.parse(args).city); } catch { argsOk = false; }
  t('T6.2 工具流式参数拼接', argsOk, `args=${args}`);
  t('T6.3 finish_reason=tool_calls', chunks.some((c) => c?.choices?.[0]?.finish_reason === 'tool_calls'));
}
// T7 工具结果回传闭环
{
  const { status, json } = await chat({
    model: MODEL, stream: false,
    messages: [
      { role: 'user', content: 'Weather in Tokyo? Use the tool.' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_test1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } }] },
      { role: 'tool', tool_call_id: 'call_test1', content: '{"temp_c":18,"condition":"cloudy"}' },
    ],
    tools: TOOLS,
  });
  const content = json?.choices?.[0]?.message?.content || '';
  t('T7 工具回传闭环', status === 200 && /18|cloud|Cloud/i.test(content), JSON.stringify(json).slice(0, 150));
}
// T8 流中断韧性(桥不得崩溃)
{
  await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'user', content: 'write a 500-word essay' }] }), signal: AbortSignal.timeout(2000) }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) }).then((x) => x.json()).catch(() => null);
  t('T8 流中断后桥存活', r?.ok === true);
}

console.log(`\n结果: ${pass} 通过, ${failN} 失败`);
process.exit(failN ? 1 : 0);
