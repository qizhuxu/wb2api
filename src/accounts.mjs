// 多账号：枚举本机所有 WorkBuddy 会话文件（含桌面端 clean() 留下的备份），
// 解出每个账号的元数据，并支持把服务切到其中任意一个。
//
// 设计要点（读之前先看一眼，免得改坏）：
//   1. **绝不重写解密** —— 复用 src/creds.mjs 的 readAccountMetaFromFile（它又用 src/crypto.mjs），
//      本文件只负责「找文件 / 算元数据 / 出错降级」。
//   2. **单个文件坏掉不能让整次枚举失败** —— 老备份可能是旧格式、可能被截断，
//      解不开就在那条上标 `error`，其余照常返回。
//   3. **token 永不出现在返回值里** —— 这里只解 uid / uin / nickname / 到期时间；
//      accessToken / refreshToken 连明文都不碰（readAccountMetaFromFile 不解它们）。
//   4. **file 是唯一键** —— 同一个账号（uid 相同）可能有好几个文件（备份），
//      所以前端的 key、切换接口的参数一律用 `file`，不用 uid / 文件名。
import fs from 'node:fs';
import path from 'node:path';
import { resolveAuthFile, readActiveAccount, codebuddyAuthDir, isBackupAuthName } from './config.mjs';
import { readAccountMetaFromFile } from './creds.mjs';

/** 路径比较：Windows 大小写不敏感。 */
const samePath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** 枚举目录：默认就是本机的 auth 目录，测试可传 dir 覆盖。 */
export function authDirOf(cfg) {
  return cfg?.credentials?.authDir || codebuddyAuthDir();
}

/** 列出目录里所有 .info 会话文件（按文件名排序，结果稳定好断言）。 */
export function listAuthFiles(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // 目录不存在 = 没有账号，不是错误
  }
  const out = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.info')) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      out.push({ file, name, mtime: st.mtimeMs, size: st.size });
    } catch {
      /* 刚好被删/被锁：跳过这一条 */
    }
  }
  return out;
}

/**
 * 枚举所有账号。
 *
 * @returns {Promise<{dir: string, current: string, configFile: string, override: string|null, accounts: object[]}>}
 *   accounts[] 每项：file / name / isBackup / mtime / size / uid / uin / nickname /
 *   expiresAt / refreshExpiresAt / isCurrent / tokenValid / expired / error?（不含任何 token）
 */
export async function listAccounts(cfg, { logger = console, dir } = {}) {
  const authDir = dir || authDirOf(cfg);
  const current = resolveAuthFile(cfg) || '';
  const configFile = cfg?.credentials?.authFile || '';
  const entries = listAuthFiles(authDir);
  if (!entries.length) {
    return { dir: authDir, current, configFile, override: readActiveAccount(cfg)?.file ?? null, accounts: [] };
  }

  let meta = null;
  let metaError = null;
  try {
    // 解一次静态密钥就够，后面每个文件复用（getAtRestSecret 内部有磁盘缓存）
    meta = (file) => readAccountMetaFromFile(cfg, file);
  } catch (error) {
    // 连静态密钥都取不到（没装 WorkBuddy / 没登录过）→ 仍然给出文件清单，只是没有账号详情
    metaError = error.message;
    logger.warn?.(`[accounts] 取静态密钥失败，账号详情不可用：${error.message}`);
  }

  const accounts = entries.map((e) => {
    const base = {
      file: e.file,
      name: e.name,
      isBackup: isBackupAuthName(e.name),
      mtime: new Date(e.mtime).toISOString(),
      size: e.size,
      isCurrent: samePath(e.file, current),
      // 下面这些在解密失败时保持空值，前端按 error 字段显示
      uid: '',
      uin: '',
      nickname: '',
      domain: '',
      expiresAt: null,
      refreshExpiresAt: null,
      expired: null,
      tokenValid: null,
      error: null,
    };
    if (metaError) return { ...base, error: metaError };
    let m;
    try {
      m = meta(e.file);
    } catch (error) {
      // 关键约束：一个文件解不开，只标记它自己
      return { ...base, error: error.message };
    }
    return {
      ...base,
      uid: m.uid,
      uin: m.uin,
      nickname: m.nickname,
      domain: m.domain,
      expiresAt: m.expiresAt ? new Date(m.expiresAt).toISOString() : null,
      refreshExpiresAt: m.refreshExpiresAt ? new Date(m.refreshExpiresAt).toISOString() : null,
      // 这份快照当初是什么时候签发的（备份文件里就有这个时刻，UI 用来解释「为什么它是旧的」）
      issuedAt: m.issuedAt ? new Date(m.issuedAt).toISOString() : null,
      // 「access token 现在还能不能直接用」—— 备份文件基本都是 false
      tokenValid: m.expiresAt ? Date.now() < m.expiresAt : null,
      // 「连 refreshToken 都过期了」= 这份快照彻底没救（换票也换不动），只能重新登录拿新的
      expired: m.refreshExpiresAt ? Date.now() >= m.refreshExpiresAt : m.expiresAt ? Date.now() >= m.expiresAt : null,
    };
  });

  return {
    dir: authDir,
    current,
    // 配置（config.yaml / 环境变量）原本指向哪个文件 —— 用来在管理台区分「配置值」与「运行时覆盖」
    configFile,
    override: readActiveAccount(cfg)?.file ?? null,
    accounts,
  };
}

/**
 * 切换账号前的校验：只接受**枚举结果里出现过**的路径。
 *
 * 这是防路径穿越的唯一入口 —— 不直接信前端传来的 file，
 * 而是拿它去和真实枚举出来的文件列表逐字比对（解析绝对路径后比较），
 * 所以 `..\..\config.yaml`、大小写变体、UNC 路径都进不来。
 * 另外要求目标必须是本机 auth 目录下的 `.info` 文件。
 *
 * @returns {{ok: true, file: string} | {ok: false, status: number, error: string}}
 */
export function validateSwitchTarget(cfg, listed, file) {
  if (typeof file !== 'string' || !file.trim()) {
    return { ok: false, status: 400, error: '缺少 file（会话文件的绝对路径）' };
  }
  if (file.includes('\0')) return { ok: false, status: 400, error: 'file 含非法字符' };

  const dir = listed?.dir || authDirOf(cfg);
  const resolved = path.resolve(file);
  // 1) 必须是本机 auth 目录下的 .info 文件（挡掉 ../ 与任意路径）
  const rel = path.relative(path.resolve(dir), resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, status: 403, error: `只允许本机 auth 目录内的会话文件：${dir}` };
  }
  if (!resolved.toLowerCase().endsWith('.info')) {
    return { ok: false, status: 403, error: '只允许 .info 会话文件' };
  }
  // 2) 必须真的在枚举结果里（挡掉目录里的非会话文件、以及枚举后才出现的文件）
  const hit = (listed?.accounts || []).find((a) => samePath(a.file, resolved));
  if (!hit) return { ok: false, status: 403, error: '该文件不在账号枚举结果里，拒绝切换' };
  return { ok: true, file: hit.file, account: hit };
}
