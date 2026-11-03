// openai-anthropic-bridge 看门狗：定期健康检查，桥挂了就自动拉起（无窗口）
// 运行: node watchdog.mjs   （环境变量 WATCHDOG_INTERVAL_MS 调巡检间隔，默认 60s）
// 配置读取与 server.mjs 一致: 环境变量 > 同目录 config.json

import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const INTERVAL = Number(process.env.WATCHDOG_INTERVAL_MS || 60000);
const LOG = path.join(DIR, 'guard.log');

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')); } catch { /* 无配置文件 */ }
// 与 server.mjs 同一套配置语义: 正向(OpenAI客户端->Anthropic网关) + 反向(Anthropic客户端->OpenAI后端)
const FORWARD_PORT = Number(process.env.BRIDGE_PORT || cfg.port || 3456);
const FORWARD_ON = !!(cfg.upstream || process.env.BRIDGE_UPSTREAM);
const REVERSE_PORT = Number(process.env.BRIDGE_ANTHROPIC_PORT || cfg.anthropicPort || 4567);
const REVERSE_ON = !!(cfg.openaiBackend || process.env.BRIDGE_OPENAI_BACKEND);

function log(msg) {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 200 * 1024) fs.writeFileSync(LOG, '');
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* 磁盘问题不影响看门狗 */ }
}

async function probe(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

// 所有已启用的端口探针都通过才算健康
async function healthy() {
  const checks = [];
  if (FORWARD_ON) checks.push(probe(FORWARD_PORT).then((ok) => ({ port: FORWARD_PORT, ok })));
  if (REVERSE_ON) checks.push(probe(REVERSE_PORT).then((ok) => ({ port: REVERSE_PORT, ok })));
  if (!checks.length) return true; // 没有任何探针目标(理论上 server 自身会拒绝启动), 不拉起
  const results = await Promise.all(checks);
  return results.every((r) => r.ok);
}

async function tick() {
  if (await healthy()) return;
  log(`bridge down (forward:${FORWARD_ON ? FORWARD_PORT : 'off'} reverse:${REVERSE_ON ? REVERSE_PORT : 'off'}), starting...`);
  const child = spawn(process.execPath, [path.join(DIR, 'server.mjs')], { // 绝对路径，便于按目录识别进程
    cwd: DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

process.on('uncaughtException', (e) => log(`watchdog uncaught: ${e?.stack || e}`));
process.on('unhandledRejection', (e) => log(`watchdog rejection: ${e?.stack || e}`));

log(`watchdog v2 started, interval=${INTERVAL}ms, forward=${FORWARD_ON ? FORWARD_PORT : 'off'}, reverse=${REVERSE_ON ? REVERSE_PORT : 'off'}`);
tick().catch((e) => log(`tick error: ${e}`)); // 启动立即巡检一次，不留 60s 空窗
setInterval(() => { tick().catch((e) => log(`tick error: ${e}`)); }, INTERVAL);
