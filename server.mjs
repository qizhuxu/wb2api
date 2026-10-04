// 前台启动入口：npm run serve / node server.mjs
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './src/config.mjs';
import { createServer, VERSION } from './src/server.mjs';

const cfg = loadConfig();
if (!fs.existsSync(cfg.paths.logs)) fs.mkdirSync(cfg.paths.logs, { recursive: true });

const { server } = createServer(cfg);

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[wb2api] 端口 ${cfg.server.port} 已被占用。改 config.yaml 的 server.port，或先停掉占用者。`);
    process.exit(2);
  }
  console.error(`[wb2api] 启动失败：${error.stack || error.message}`);
  process.exit(1);
});

server.listen(cfg.server.port, cfg.server.host, () => {
  const pidFile = path.join(cfg.paths.data, 'server.pid');
  fs.mkdirSync(cfg.paths.data, { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid), 'utf8');
  const base = `http://${cfg.server.host}:${cfg.server.port}`;
  console.log(`[wb2api] v${VERSION} 已启动 ${base}`);
  console.log(`[wb2api] OpenAI base_url: ${base}/v1   （api_key 随便填）`);
  console.log(`[wb2api] 自检: GET ${base}/__wb2api`);
});

const bye = () => {
  try {
    fs.unlinkSync(path.join(cfg.paths.data, 'server.pid'));
  } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
