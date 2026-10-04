// 生成「公开面快照」并自检：npm run public-snapshot
//
// 用途：本仓库将来可能公开。公开之前先跑这个，产出一个只含
// 「构建/运行必要源码 + 必要介绍文档」的目录，并逐项自检，
// 确认没有把开发资料或敏感信息带出去。
//
// 剔除规则写在 .gitattributes 的 export-ignore（§5.4），这里只做：
//   导出 → 自检 → 报告。自检不过就以非 0 退出，避免误发。
//
// 用法:
//   npm run public-snapshot              # 导出到 ../wb2api-public
//   npm run public-snapshot -- <目标目录>  # 自定义目标
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.resolve(process.argv[2] || path.join(ROOT, '..', 'wb2api-public'));

// === 公开面必须剔除的路径（与 .gitattributes 的 export-ignore 对应）===
const MUST_NOT_SHIP = [
  { re: /(^|\/)AGENTS\.md$/, why: '本文档不得公开（§5.4）' },
  { re: /(^|\/)test\//, why: '回归测试脚本，属开发资料' },
  { re: /(^|\/)docs\//, why: '内部调查报告（含上游踩坑与实测数据）' },
  { re: /(^|\/)scripts\/probe\.mjs$/, why: '自检脚本，含本机账号探测逻辑' },
  { re: /(^|\/)data\//, why: '密钥与会话缓存' },
  { re: /(^|\/)logs\//, why: '运行日志' },
  { re: /(^|\/)node_modules\//, why: '依赖目录' },
  { re: /(^|\/)\.git\//, why: 'git 元数据' },
];

// === 内容级敏感扫描 ===
// 说明：JWT 用「至少 2 段 base64url」判定，段长下限放到 8 ——
// 真实 token 常见 2~3 段且首段长度不定，原先要求 20+ 会漏掉短 token。
const SECRET_PATTERNS = [
  { re: /"(accessToken|refreshToken|id_token|client_secret|api[_-]?key)"\s*:\s*"[A-Za-z0-9._\-+/=]{16,}"/i, why: '疑似真实凭据字段' },
  { re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?/, why: '疑似 JWT' },
  { re: /(?:^|[^A-Za-z0-9])(sk|ak)-[A-Za-z0-9]{16,}/, why: '疑似 API key' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: '疑似私钥' },
];

let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { failed++; console.log(`  ✗ ${m}`); };

console.log(`wb2api 公开面快照\n  源: ${ROOT}\n  目标: ${target}\n`);

// 1) 干净导出（export-ignore 生效）
//
// 注意 `git archive HEAD` 读的是 **HEAD 里已提交的** .gitattributes，
// 工作区改了但没提交时两者不一致 —— 所以先比对，不一致就拒绝，
// 避免「按未提交的规则导出、却以为遵循了已提交的规则」这种假象通过。
const attrHead = execFileSync('git', ['show', 'HEAD:.gitattributes'], { cwd: ROOT, encoding: 'utf8' });
const attrPath = path.join(ROOT, '.gitattributes');
const attrWork = fs.existsSync(attrPath) ? fs.readFileSync(attrPath, 'utf8') : '';
const norm = (s) => s.replace(/\r\n/g, '\n').trim();
if (norm(attrHead) !== norm(attrWork)) {
  console.log('✗ .gitattributes 与 HEAD 不一致（有未提交改动）');
  console.log('  导出用的是 HEAD 版本；请先提交，或确认这不是你要发布的规则。');
  process.exitCode = 1;
  process.exit(1);
}
const ignoreCount = (attrHead.match(/export-ignore/g) || []).length;
if (ignoreCount === 0) {
  console.log('✗ .gitattributes 里没有任何 export-ignore —— 公开面不会被剔除');
  process.exitCode = 1;
  process.exit(1);
}
console.log(`.gitattributes 与 HEAD 一致（${ignoreCount} 条 export-ignore）`);

if (fs.existsSync(target)) {
  console.log(`目标已存在，先清空：${target}`);
  fs.rmSync(target, { recursive: true, force: true });
}
fs.mkdirSync(target, { recursive: true });
const archivePath = path.join(target, '..', `.wb2api-snapshot-${Date.now()}.tar`);
try {
  execFileSync('git', ['archive', '--format=tar', '-o', archivePath, 'HEAD'], { cwd: ROOT, stdio: 'pipe' });
  execFileSync('tar', ['-xf', archivePath, '-C', target], { cwd: ROOT, stdio: 'pipe' });
} finally {
  fs.rmSync(archivePath, { force: true });
}
console.log('已从 HEAD 导出（export-ignore 已应用）\n');

// 2) 收集导出后的全部文件
const walk = (dir, base = '') => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
};
const files = walk(target);
console.log(`导出文件数：${files.length}\n`);

// 3) 自检：不得出现的路径
console.log('公开面路径自检：');
for (const { re, why } of MUST_NOT_SHIP) {
  const hit = files.filter((f) => re.test(f));
  if (hit.length) bad(`出现了不该公开的路径（${why}）：${hit.slice(0, 5).join(', ')}${hit.length > 5 ? ` …共 ${hit.length} 个` : ''}`);
  else ok(`未包含 ${why}`);
}

// 4) 自检：内容级敏感信息
console.log('\n敏感内容扫描：');
const textExt = new Set(['.md', '.mjs', '.js', '.cjs', '.json', '.yaml', '.yml', '.txt', '.go', '.sh', '.bat', '.mod', '.sum', '.gitignore', '.gitattributes']);
// 本文件自身含检测规则与样本（虽然样本已改为运行时拼接），显式豁免，避免自我误报。
const SELF_EXEMPT = new Set(['scripts/public-snapshot.mjs']);
const found = [];
for (const f of files) {
  if (SELF_EXEMPT.has(f)) continue;
  if (!textExt.has(path.extname(f)) && !f.startsWith('.')) continue;
  let text;
  try { text = fs.readFileSync(path.join(target, f), 'utf8'); } catch { continue; }
  for (const { re, why } of SECRET_PATTERNS) {
    if (re.test(text)) found.push(`${f}（${why}）`);
  }
}
if (found.length) bad(`疑似敏感内容：${found.slice(0, 10).join(', ')}`);
else ok('未发现 token / API key / 私钥');

// 5) 自检：运行必需的源码都在
console.log('\n运行必需文件自检：');
const REQUIRED = ['package.json', 'server.mjs', 'config.yaml', 'README.md', 'src/server.mjs', 'src/upstream.mjs', 'src/catalog.mjs', 'src/config.mjs', 'src/creds.mjs', 'src/crypto.mjs', 'src/native/at-rest-key.cjs'];
for (const r of REQUIRED) {
  if (files.includes(r)) ok(r);
  else bad(`缺少运行必需文件：${r}`);
}

// 6) 自检：公开面里的**本地相对链接**必须指向存在的文件。
//
// 真实踩过：README 里有 5 个 `[text](docs/xxx.md)` 链接，而 docs/ 被
// export-ignore 排除 —— 本地读没问题，公开后就全是死链。
// 只检查相对路径；http(s)/mailto/锚点不检查。
console.log('\n本地相对链接自检：');
const mdFiles = files.filter((f) => f.endsWith('.md'));
const broken = [];
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;
for (const md of mdFiles) {
  let text;
  try { text = fs.readFileSync(path.join(target, md), 'utf8'); } catch { continue; }
  const dir = path.posix.dirname(md);
  for (const m of text.matchAll(LINK_RE)) {
    const href = m[1];
    if (/^(https?:|mailto:|#|data:)/i.test(href)) continue;
    const clean = href.split('#')[0];
    if (clean === '') continue;
    // 去掉可能的行号/查询，解析相对路径
    const resolved = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, decodeURIComponent(clean)));
    if (!files.includes(resolved) && !files.some((f) => f.startsWith(`${resolved.replace(/\/$/, '')}/`))) {
      broken.push(`${md} → ${href}`);
    }
  }
}
if (broken.length) {
  bad(`公开面存在死链（目标不在快照里）：${broken.slice(0, 8).join('; ')}${broken.length > 8 ? ` …共 ${broken.length} 条` : ''}`);
} else ok(`${mdFiles.length} 个 Markdown 里的本地链接全部有效`);

// 7) 检测器自测：确认上面的规则**真的会命中**，而不是永远返回通过。
//
// 样本在运行时拼接（`['a','b'].join('')`），不写成字面量 ——
// 否则本文件会被自己的规则扫中（真实踩过：脚本扫自己导致永远误报）。
// 另外扫描阶段用 SELF_EXEMPT 显式豁免本文件，双重保险。
console.log('\n检测器自测（反向用例，必须全部命中）：');
const NEGATIVE = [
  { name: 'AGENTS.md 路径', re: MUST_NOT_SHIP[0].re, sample: 'AGENTS' + '.md' },
  { name: 'test/ 路径', re: MUST_NOT_SHIP[1].re, sample: 'test' + '/creds.test.mjs' },
  { name: 'docs/ 路径', re: MUST_NOT_SHIP[2].re, sample: 'docs' + '/architecture.md' },
  { name: 'probe.mjs 路径', re: MUST_NOT_SHIP[3].re, sample: 'scripts' + '/probe.mjs' },
];
for (const c of NEGATIVE) {
  if (c.re.test(c.sample)) ok(`路径规则能命中：${c.name}`);
  else bad(`路径规则失效（漏检）：${c.name}`);
}
const JWT_HEAD = 'eyJhbGciOiJIUzUxMiJ9';
const JWT_BODY = 'eyJleHAiOjE3OTUzMjA4NDN9';
const SECRET_SAMPLES = [
  { name: 'token 字段', re: SECRET_PATTERNS[0].re, sample: '{"access' + 'Token":"abcdefghijklmnopqrstuvwxyz123456"}' },
  { name: 'refreshToken 字段', re: SECRET_PATTERNS[0].re, sample: '"refresh' + 'Token": "' + JWT_HEAD + '.abc"' },
  { name: 'JWT（三段）', re: SECRET_PATTERNS[1].re, sample: [JWT_HEAD, JWT_BODY, 'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'].join('.') },
  { name: 'JWT（两段，真实短形态）', re: SECRET_PATTERNS[1].re, sample: [JWT_HEAD, JWT_BODY].join('.') },
  { name: 'API key', re: SECRET_PATTERNS[2].re, sample: 'sk' + '-abcdefghijklmnopqrstuvwx' },
  { name: '私钥块', re: SECRET_PATTERNS[3].re, sample: '-----BEGIN RSA ' + 'PRIVATE KEY-----' },
];
for (const c of SECRET_SAMPLES) {
  if (c.re.test(c.sample)) ok(`敏感规则能命中：${c.name}`);
  else bad(`敏感规则失效（漏检）：${c.name}`);
}

// 误报检查：正常源码不该被当成秘密
console.log('\n误报检查（正常内容不应命中）：');
const FALSE_POSITIVES = [
  { name: 'README 里的 apiKey 占位符', sample: 'apiKey: wb2api' },
  { name: 'config 里的 apiKeyEnv 引用', sample: 'apiKeyEnv: WB2API_API_KEY' },
  { name: '代码里的字段名字符串', sample: "headers['X-API-Key'] = key" },
  { name: '空 token 字段', sample: '"accessToken": ""' },
];
for (const c of FALSE_POSITIVES) {
  const hit = SECRET_PATTERNS.some((p) => p.re.test(c.sample));
  if (hit) bad(`正常内容被误判为秘密：${c.name}`);
  else ok(`未误报：${c.name}`);
}

console.log(failed ? `\n${failed} 项未通过 —— 不要公开这个快照` : `\n全部通过 —— 快照可安全公开：${target}`);
process.exitCode = failed ? 1 : 0;
