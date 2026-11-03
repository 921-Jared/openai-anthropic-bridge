// openai-anthropic-bridge 卸载器: node uninstall.mjs [--keep-workbuddy]
// ① 删开机自启 ② 停桥/看门狗进程 ③(可选)移除 WorkBuddy 自定义模型条目 ④ config.json 保留(含key, 删目录即彻底清除)

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const KEEP_WB = args.includes('--keep-workbuddy');
const YES = args.includes('--yes');

const rl = process.stdout.isTTY && !YES ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
const ask = async (q) => (rl ? (await rl.question(`${q} `)).trim().toLowerCase() : ''); // 非交互默认不动用户配置

console.log('=== openai-anthropic-bridge 卸载器 ===\n');

// 1. 开机自启
const startupDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const bat = path.join(startupDir, 'openai-anthropic-bridge-autostart.bat');
if (fs.existsSync(bat)) { fs.unlinkSync(bat); console.log('  [OK] 已删除开机自启'); }
else console.log('  [--] 无开机自启');

// 2. 停进程：优先按端口杀（最可靠），再按本目录路径兜底
let cfgPort = 3456;
let cfgAnthropicPort = null;
try {
  const c = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
  cfgPort = c.port || 3456;
  if (c.openaiBackend) cfgAnthropicPort = c.anthropicPort || 4567; // 反向桥端口
} catch { /* 用默认 */ }
// Windows 命令行里的路径斜杠方向随 spawn 方式变化，两种形式都匹配
const dirRe = DIR.replace(/\\/g, '/').replace(/'/g, "''").replace(/"/g, '\\"');
const dirAlt = DIR.replace(/\\/g, '\\\\');
const ps = [
  `$pids = @()`,
  ...[cfgPort, cfgAnthropicPort].filter(Boolean).map((p) => `try { $pids += (Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction Stop).OwningProcess } catch {}`),
  `$pids += (Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "node.exe" -and ($_.CommandLine -match "${dirRe}" -or $_.CommandLine -match "${dirAlt}") } | ForEach-Object { $_.ProcessId })`,
  `$pids = $pids | Sort-Object -Unique`,
  `if ($pids) { $pids | ForEach-Object { Stop-Process -Id $_ -Force; "stopped PID $_" } }`,
].join('; ');
// 只按两个精确边界杀: 本安装的端口 + 本目录绝对路径。
// 不做任何按文件名的全局匹配——多实例/其他工具(如 mcp-server.mjs)会被误杀
execFile('powershell', ['-NoProfile', '-Command', ps], (err, stdout) => {
  if (err) console.error(`  [WARN] 停进程出错: ${err.message}`);
  console.log(stdout.trim() ? `  [OK] ${stdout.trim()}` : '  [--] 无运行中的进程');

  // 3. WorkBuddy 条目
  (async () => {
    const mj = path.join(os.homedir(), '.workbuddy', 'models.json');
    if (!KEEP_WB && fs.existsSync(mj)) {
      const ans = await ask('同时移除 WorkBuddy 里的自定义模型条目? (y/N):');
      if (ans === 'y') {
        try {
          let cfgPort = 3456;
          try { cfgPort = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')).port || 3456; } catch { /* 用默认 */ }
          const needle = `127.0.0.1:${cfgPort}`; // 只清本安装(同端口)写入的条目，不误删其他实例
          let list = JSON.parse(fs.readFileSync(mj, 'utf8'));
          const before = list.length;
          list = (Array.isArray(list) ? list : []).filter((e) => !(typeof e.url === 'string' && e.url.includes(needle)));
          fs.writeFileSync(mj, JSON.stringify(list, null, 2));
          console.log(`  [OK] 已移除 ${before - list.length} 个条目 (匹配 ${needle})`);
        } catch (e) { console.error(`  [WARN] 改 models.json 失败: ${e.message}`); }
      }
    }
    if (rl) rl.close();
    console.log('\n卸载完成。config.json(含key)仍在目录中，删除整个目录即彻底清除。');
  })();
});
