// openai-anthropic-bridge 一键安装器
// 交互式: node install.mjs
// 脚本式: node install.mjs --upstream https://gw.example.com --key sk-xxx --model my-model [--port 3456] [--yes] [--skip-autostart] [--skip-workbuddy]
// 做的事: ①连通性测试上游 ②写 config.json ③启动桥+看门狗 ④(可选)注册开机自启 ⑤(可选)自动写入 WorkBuddy 自定义模型配置

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline/promises';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------- 参数解析 ----------
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(`--${name}`);

const cfg = {
  upstream: (flag('upstream') || process.env.JX_BRIDGE_UPSTREAM || '').replace(/\/+$/, ''),
  apiKey: flag('key') || process.env.JX_GATEWAY_API_KEY || '',
  port: Number(flag('port') || process.env.JX_BRIDGE_PORT || 3456),
  model: flag('model') || '',
};
const YES = has('yes');

const rl = process.stdout.isTTY && !YES ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
const ask = async (q, def) => {
  if (!rl) return def;
  const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
  return a || def || '';
};

const ok = (m) => console.log(`  [OK] ${m}`);
const fail = (m) => { console.error(`  [FAIL] ${m}`); process.exit(1); };

console.log('=== openai-anthropic-bridge 安装器 ===\n');

// ---------- 1. 收集配置 ----------
if (!cfg.upstream) cfg.upstream = await ask('Anthropic 兼容网关地址 (如 https://gw.example.com)', 'https://aiproxy.example.com');
if (!cfg.apiKey) cfg.apiKey = await ask('API Key', '');
if (!cfg.apiKey) fail('API Key 不能为空');

// ---------- 2. 连通性测试 + 拉模型列表 ----------
console.log(`\n[1/5] 测试上游 ${cfg.upstream} ...`);
let models = [];
try {
  const r = await fetch(`${cfg.upstream}/v1/models`, {
    headers: { 'x-api-key': cfg.apiKey, authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) fail(`上游返回 HTTP ${r.status}（检查地址和 key）`);
  const j = await r.json();
  models = (j.data || []).map((m) => m.id).filter(Boolean);
  ok(`连通正常，可用模型: ${models.join(', ') || '(列表为空，稍后手动填模型名)'}`);
} catch (e) {
  fail(`连不上上游: ${e.message}`);
}

const DEFAULT_MODEL = cfg.model || models.find((m) => /^jx-|alias/.test(m)) || models[0] || '';
if (!cfg.model) cfg.model = await ask('默认模型名称（WorkBuddy 里填的那个）', DEFAULT_MODEL);
if (!cfg.model) fail('模型名称不能为空');

// ---------- 3. 写 config.json ----------
console.log('\n[2/5] 写入 config.json（含 key，已被 .gitignore 忽略，不会误提交）...');
fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({ upstream: cfg.upstream, apiKey: cfg.apiKey, port: cfg.port }, null, 2));
ok(`upstream=${cfg.upstream} port=${cfg.port}`);

// ---------- 4. 启动桥 + 看门狗 ----------
console.log('\n[3/5] 启动桥与看门狗...');
let running = false;
try {
  const r = await fetch(`http://127.0.0.1:${cfg.port}/health`, { signal: AbortSignal.timeout(2000) });
  running = r.ok;
} catch { running = false; }

if (running) {
  ok(`端口 ${cfg.port} 已有桥在跑，跳过启动`);
} else {
  for (const f of ['server.mjs', 'watchdog.mjs']) {
    // 用绝对路径启动，保证进程命令行可被 uninstall.mjs 按目录识别
    const c = spawn(process.execPath, [path.join(DIR, f)], { cwd: DIR, detached: true, stdio: 'ignore', windowsHide: true });
    c.unref();
  }
  await new Promise((r) => setTimeout(r, 2500));
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.port}/health`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`health HTTP ${r.status}`);
    ok(`桥已启动: http://127.0.0.1:${cfg.port} -> ${cfg.upstream}`);
  } catch (e) {
    fail(`桥启动失败: ${e.message}（手动运行 node server.mjs 看报错）`);
  }
}

// ---------- 5. 开机自启 ----------
if (has('skip-autostart')) {
  console.log('\n[4/5] 按参数跳过开机自启');
} else {
  console.log('\n[4/5] 注册开机自启（启动文件夹，任务管理器-启动应用里可见可禁用）...');
  const startupDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const bat = path.join(startupDir, 'openai-anthropic-bridge-autostart.bat');
  fs.mkdirSync(startupDir, { recursive: true });
  fs.writeFileSync(bat, `@echo off\nrem openai-anthropic-bridge 开机自启（看门狗守护桥进程）\nstart "oai-anthro-watchdog" /min node "${path.join(DIR, 'watchdog.mjs')}"\n`);
  ok(`已写入 ${bat}`);
}

// ---------- 6. WorkBuddy 自动配置 ----------
if (has('skip-workbuddy')) {
  console.log('\n[5/5] 按参数跳过 WorkBuddy 配置');
} else {
  console.log('\n[5/5] WorkBuddy 自动配置...');
  const mj = path.join(os.homedir(), '.workbuddy', 'models.json');
  if (!fs.existsSync(mj)) {
    console.log('  未检测到 ~/.workbuddy/models.json（没装 WorkBuddy？跳过）');
  } else {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(mj, 'utf8')); if (!Array.isArray(list)) list = []; } catch { list = []; }
    fs.copyFileSync(mj, `${mj}.bak-${Date.now()}`);
    const entry = {
      id: cfg.model, name: cfg.model, vendor: 'Custom',
      url: `http://127.0.0.1:${cfg.port}/v1`,
      apiKey: 'sk-local',
      supportsToolCall: true, supportsImages: false, supportsReasoning: false, useCustomProtocol: false,
    };
    const i = list.findIndex((e) => e.id === cfg.model);
    if (i >= 0) list[i] = entry; else list.push(entry);
    fs.writeFileSync(mj, JSON.stringify(list, null, 2));
    ok(`已写入自定义模型 "${cfg.model}"（原文件已备份）。重启 WorkBuddy 后在模型列表选择它`);
  }
}

if (rl) rl.close();
console.log(`
=== 安装完成 ===
接口地址: http://127.0.0.1:${cfg.port}/v1
模型名称: ${cfg.model}
状态: 桥运行中 + 看门狗每 60 秒自愈${has('skip-autostart') ? '' : ' + 开机自启'}
验证: curl http://127.0.0.1:${cfg.port}/health
`);
