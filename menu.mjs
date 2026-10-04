// 交互式控制台：npm run menu（或双击 start.bat）
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig } from './src/config.mjs';

const cfg = loadConfig();
const BASE = `http://${cfg.server.host}:${cfg.server.port}`;
const ROOT = cfg.paths.root;

const rl = readline.createInterface({ input, output });

/** 包一层：管道/重定向把 stdin 读空时 rl 会抛 ERR_USE_AFTER_CLOSE，直接当作「退出」。 */
async function ask(prompt) {
  try {
    return (await rl.question(prompt)).trim();
  } catch {
    return '0';
  }
}

function run(args, { capture = true } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true });
    let out = '';
    if (capture) {
      child.stdout.on('data', (d) => (out += d.toString()));
      child.stderr.on('data', (d) => (out += d.toString()));
    } else {
      child.stdout.pipe(output);
      child.stderr.pipe(output);
    }
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function selfCheck(timeout = 3000) {
  try {
    const r = await fetch(`${BASE}/__wb2api`, { signal: AbortSignal.timeout(timeout) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function showStatus() {
  const info = await selfCheck();
  if (!info) {
    console.log(`\n  服务：未运行 (${BASE})`);
    return;
  }
  const l = info.login || {};
  console.log(`\n  服务：运行中 ${BASE}  v${info.version}`);
  console.log(`  上游：${info.endpoint}`);
  console.log(`  账号：${l.uid || '(未知)'}   uin=${l.uin || '-'}   domain=${l.domain || '-'}`);
  console.log(`  凭证：来源 ${l.source || '-'}   到期 ${l.expiresAt || '-'}`);
  console.log(`  模型：${info.models?.length ?? 0} 个`);
}

async function askOnce() {
  const q = await ask('\n  问题（回车取消）: ');
  if (!q) return;
  const info = await selfCheck(6000);
  const model = info?.models?.find((m) => m === 'deepseek-v4-flash') || info?.models?.[0] || 'auto';
  process.stdout.write(`  [${model}] `);
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true, max_tokens: 1024, messages: [{ role: 'user', content: q }] }),
  });
  if (!res.ok) {
    console.log(`失败 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let printed = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const d = JSON.parse(payload).choices?.[0]?.delta ?? {};
        const piece = d.content || d.reasoning_content || '';
        if (piece) {
          process.stdout.write(piece);
          printed = true;
        }
      } catch {}
    }
  }
  console.log(printed ? '\n' : '(空回复)\n');
}

async function listModels() {
  const r = await fetch(`${BASE}/v1/models`);
  const j = await r.json();
  if (!j.data) {
    console.log('  拉取失败：', JSON.stringify(j).slice(0, 200));
    return;
  }
  console.log('');
  for (const m of j.data) {
    const flags = [m.supports_tools ? 'tools' : '', m.supports_images ? 'image' : '', m.supports_reasoning ? 'reason' : ''].filter(Boolean).join('/');
    console.log(`  ${m.id.padEnd(28)} ${(m.name || '').padEnd(26)} ${flags}${m.is_default ? '  [默认]' : ''}`);
  }
}

async function tailLog() {
  const file = path.join(cfg.paths.logs, 'requests.jsonl');
  if (!fs.existsSync(file)) {
    console.log('  还没有抓包日志（config.yaml 里 logging.capture 打开后才会记录）。');
    return;
  }
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-15);
  console.log('');
  for (const l of lines) console.log(`  ${l}`);
}

async function menu() {
  for (;;) {
    console.log(`
   1  启动服务            2  停止服务
   3  重启                4  状态 / 凭证
   5  刷新凭证（重解密）   6  健康检查
   7  试问一句            8  模型列表
   9  查看请求日志        0  退出
`);
    const choice = await ask('  选择: ');
    if (choice === '0') break;
    if (choice === '1') console.log((await run(['scripts/daemon.mjs', 'start'])).out.trim());
    else if (choice === '2') console.log((await run(['scripts/daemon.mjs', 'stop'])).out.trim());
    else if (choice === '3') console.log((await run(['scripts/daemon.mjs', 'restart'])).out.trim());
    else if (choice === '4') await showStatus();
    else if (choice === '5') {
      try {
        const r = await fetch(`${BASE}/__wb2api/creds/refresh`, { method: 'POST' });
        console.log('  ' + JSON.stringify(await r.json()));
      } catch {
        console.log((await run(['scripts/creds-cli.mjs', 'export'])).out.trim());
      }
    } else if (choice === '6') console.log((await run(['scripts/probe.mjs'])).out.trim());
    else if (choice === '7') {
      if (!(await selfCheck())) console.log('  服务没在跑，先选 1。');
      else await askOnce();
    } else if (choice === '8') {
      if (!(await selfCheck())) console.log('  服务没在跑，先选 1。');
      else await listModels();
    } else if (choice === '9') await tailLog();
    else console.log('  没这个选项。');
  }
  rl.close();
}

console.log('wb2api 控制台 —— 把本机 WorkBuddy 会话反代成 OpenAI 兼容入口');
await menu();
