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
const PORT = Number(process.env.JX_BRIDGE_PORT || cfg.port || 3456);

function log(msg) {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 200 * 1024) fs.writeFileSync(LOG, '');
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* 磁盘问题不影响看门狗 */ }
}

async function healthy() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

async function tick() {
  if (await healthy()) return;
  log(`bridge down on :${PORT}, starting...`);
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

log(`watchdog started, interval=${INTERVAL}ms, port=${PORT}`);
tick().catch((e) => log(`tick error: ${e}`)); // 启动立即巡检一次，不留 60s 空窗
setInterval(() => { tick().catch((e) => log(`tick error: ${e}`)); }, INTERVAL);
