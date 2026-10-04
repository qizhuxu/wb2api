// 凭证工具：node scripts/creds-cli.mjs [show|export|refresh]
//   show     看当前凭证状态（默认）
//   export   强制从桌面端会话文件重新解密，并覆盖 data/wb-session.json
//   refresh  用 refreshToken 换一份新的
import { loadConfig } from '../src/config.mjs';
import { Credentials, readSessionFromFile, refreshSession } from '../src/creds.mjs';

const cfg = loadConfig();
const creds = new Credentials(cfg, console);
const cmd = (process.argv[2] || 'show').toLowerCase();

const mask = (s, keep = 10) => (typeof s === 'string' && s.length > keep ? `${s.slice(0, keep)}…(${s.length} 字符)` : s);

function report(session) {
  console.log(`  uid            : ${session.uid || '(未知)'}`);
  console.log(`  uin            : ${session.uin || '-'}`);
  console.log(`  domain         : ${session.domain || '-'}`);
  console.log(`  来源           : ${session.source}`);
  console.log(`  accessToken    : ${mask(session.accessToken)}`);
  console.log(`  refreshToken   : ${mask(session.refreshToken, 8)}`);
  console.log(`  到期           : ${session.expiresAt ? new Date(session.expiresAt).toLocaleString() : '未知'}`);
  console.log(`  续期票到期     : ${session.refreshExpiresAt ? new Date(session.refreshExpiresAt).toLocaleString() : '未知'}`);
}

if (cmd === 'export') {
  const session = readSessionFromFile(cfg, { force: true });
  creds.save(session);
  console.log('已从桌面端会话文件重新解密并保存：');
  report(session);
} else if (cmd === 'refresh') {
  const base = creds.loadCached() || readSessionFromFile(cfg);
  const session = await refreshSession(cfg, base);
  creds.save(session);
  console.log('已续期并保存：');
  report(session);
} else {
  const session = await creds.ensure();
  console.log('当前可用凭证：');
  report(session);
  console.log(`\n缓存文件: ${cfg.paths.data}\\wb-session.json`);
}
