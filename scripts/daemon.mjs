// 后台启停：npm start / npm stop / npm status
//
// 与 xm2api 同思路：停止优先让服务自己退（POST /__wb2api/shutdown），失败才退回 pid + kill，
// 所以 pid 文件丢了也能停干净；端口上如果是别的程序，只报告、不动手。
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';

const cfg = loadConfig();
const ROOT = cfg.paths.root;
const PID_FILE = path.join(cfg.paths.data, 'server.pid');
const BASE = `http://${cfg.server.host}:${cfg.server.port}`;

function portBusy(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

async function selfCheck() {
  try {
    const res = await fetch(`${BASE}/__wb2api`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function cmdStart() {
  if (await portBusy(cfg.server.port, cfg.server.host)) {
    const info = await selfCheck();
    if (info?.service === 'wb2api') {
      console.log(`已经在跑了：${BASE}（pid 文件 ${fs.existsSync(PID_FILE) ? fs.readFileSync(PID_FILE, 'utf8').trim() : '未知'}）`);
      return;
    }
    console.error(`端口 ${cfg.server.port} 被别的程序占用，未启动。换端口或先处理占用者。`);
    process.exitCode = 2;
    return;
  }
  fs.mkdirSync(cfg.paths.logs, { recursive: true });
  const out = fs.openSync(path.join(cfg.paths.logs, 'server-stdout.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const info = await selfCheck();
    if (info) {
      console.log(`已启动 ${BASE}（pid=${child.pid}）`);
      return;
    }
  }
  console.error('启动超时，看 logs/server-stdout.log');
  process.exitCode = 1;
}

async function cmdStop() {
  const info = await selfCheck();
  if (!info) {
    console.log('服务没在跑（或端口上不是本服务）。');
    cleanupPid();
    return;
  }
  try {
    await fetch(`${BASE}/__wb2api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3000) });
  } catch {}
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (!(await portBusy(cfg.server.port, cfg.server.host))) {
      console.log('已停止。');
      cleanupPid();
      return;
    }
  }
  const pid = readPid();
  if (pid) {
    console.log(`自杀失败，退回 kill pid=${pid}`);
    try {
      process.kill(pid, 'SIGTERM');
    } catch (e) {
      console.error(`kill 失败：${e.message}`);
    }
  }
  cleanupPid();
}

async function cmdStatus() {
  const info = await selfCheck();
  if (!info) {
    console.log(`未运行（${BASE}）。`);
    return;
  }
  console.log(`运行中 ${BASE}`);
  console.log(`  版本: ${info.version}   上游: ${info.endpoint}`);
  const login = info.login || {};
  console.log(`  账号: ${login.uid || '(未知)'}  uin=${login.uin || '-'}  domain=${login.domain || '-'}`);
  console.log(`  token 来源: ${login.source || '-'}   到期: ${login.expiresAt || '-'}`);
  console.log(`  模型数: ${info.models?.length ?? 0}`);
}

function readPid() {
  try {
    return Number(fs.readFileSync(PID_FILE, 'utf8').trim()) || 0;
  } catch {
    return 0;
  }
}
function cleanupPid() {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {}
}

const cmd = process.argv[2] || 'status';
const table = { start: cmdStart, stop: cmdStop, status: cmdStatus, restart: async () => (await cmdStop(), cmdStart()) };
if (!table[cmd]) {
  console.error(`用法: node scripts/daemon.mjs <start|stop|status|restart>`);
  process.exit(2);
}
await table[cmd]();
