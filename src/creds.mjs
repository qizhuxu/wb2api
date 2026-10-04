// 凭证链路：静态密钥 → AES-GCM 解出 accessToken / refreshToken → 自动续期 → 落盘缓存。
//
// 三条来源，优先级从高到低：
//   1. data/wb-session.json（上次解出来或续期得到的会话）
//   2. 本机加密会话文件（%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info）
// 续期走 POST /v2/plugin/auth/token/refresh（X-Refresh-Token 头），不碰桌面端的文件。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { keyFromSecret, keyIdOf, openField } from './crypto.mjs';
import { buildIdentityHeaders } from './upstream.mjs';
import { discoverAuthFile, resolveWorkbuddyExe } from './config.mjs';

const NATIVE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'native', 'at-rest-key.cjs');

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

/**
 * 取静态密钥（atRestSecretKey）。它由 WorkBuddy.exe 的原生绑定给出，
 * 同一台机器/同一份安装是稳定的，所以缓存起来，避免每次都拉子进程。
 */
export function getAtRestSecret(cfg, { force = false } = {}) {
  const cacheFile = path.join(cfg.paths.data, 'at-rest-key.json');
  if (!force) {
    const cached = readJson(cacheFile);
    if (cached?.atRestSecretKey) return cached;
  }
  const exe = resolveWorkbuddyExe(cfg);
  if (!exe) {
    throw new Error('找不到 WorkBuddy.exe，请在 config.yaml 的 credentials.workbuddyExe 里填绝对路径');
  }
  const tmpOut = path.join(cfg.paths.data, `.at-rest-key.${process.pid}.tmp`);
  fs.mkdirSync(cfg.paths.data, { recursive: true });
  const res = spawnSync(exe, [NATIVE_SCRIPT, tmpOut], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
    windowsHide: true,
    timeout: 30000,
  });
  let raw = '';
  try {
    raw = fs.readFileSync(tmpOut, 'utf8');
  } catch {
    /* 下面统一报错 */
  } finally {
    try {
      fs.unlinkSync(tmpOut);
    } catch {}
  }
  if (!raw) {
    throw new Error(
      `从 WorkBuddy.exe 取静态密钥失败（exit=${res.status ?? res.signal ?? '?'}）。` +
        '确认路径正确，且该版本仍暴露 electron_browser_workbuddy_storage 原生绑定。',
    );
  }
  const parsed = JSON.parse(raw);
  if (!parsed?.atRestSecretKey) throw new Error('原生绑定返回的 payload 里没有 atRestSecretKey');
  const record = {
    version: parsed.version ?? 1,
    atRestSecretKey: parsed.atRestSecretKey,
    keyId: keyIdOf(keyFromSecret(parsed.atRestSecretKey)),
    extractedAt: Date.now(),
    source: exe,
  };
  writeJson(cacheFile, record);
  return record;
}

/** 直接读桌面端的加密会话文件并解密。 */
export function readSessionFromFile(cfg, { force = false } = {}) {
  const file = cfg.credentials.authFile || discoverAuthFile();
  if (!file || !fs.existsSync(file)) {
    throw new Error('找不到 WorkBuddy 会话文件；请先在 WorkBuddy 里登录一次，或显式配置 credentials.authFile');
  }
  const secret = getAtRestSecret(cfg, { force });
  const key = keyFromSecret(secret.atRestSecretKey);
  const raw = readJson(file);
  if (!raw?.auth) throw new Error(`会话文件结构不认识：${file}`);
  const dec = (wrapper) => (wrapper && wrapper.$wbEncrypted ? openField(key, wrapper).toString('utf8') : wrapper);
  const accessToken = dec(raw.auth.accessToken);
  const refreshToken = dec(raw.auth.refreshToken);
  if (typeof accessToken !== 'string' || !accessToken) throw new Error('会话文件里的 accessToken 解不出来');
  return {
    uid: raw.account?.uid ?? '',
    uin: raw.account?.uin ?? '',
    domain: raw.auth.domain ?? '',
    tokenType: raw.auth.tokenType ?? 'Bearer',
    scope: raw.auth.scope ?? '',
    accessToken,
    refreshToken: typeof refreshToken === 'string' ? refreshToken : '',
    expiresAt: Number(raw.auth.expiresAt) || 0,
    refreshExpiresAt: Number(raw.auth.refreshExpiresAt) || 0,
    source: 'file',
    authFile: file,
    savedAt: Date.now(),
  };
}

/** 用 refreshToken 换新的 accessToken（上游会同时轮换 refreshToken，一并存下）。 */
export async function refreshSession(cfg, session) {
  if (!session?.refreshToken) throw new Error('没有 refreshToken，无法续期');
  const url = `${cfg.upstream.endpoint.replace(/\/+$/, '')}${cfg.upstream.refreshPath}`;
  // 身份头与聊天链路共用同一份构造，避免两处 UA / 版本号漂移
  const res = await fetch(url, {
    method: 'POST',
    headers: buildIdentityHeaders(cfg, session, {
      'X-Refresh-Token': session.refreshToken,
      'X-Auth-Refresh-Source': 'plugin',
    }),
    body: '{}',
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`续期失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`续期返回不是 JSON: ${text.slice(0, 200)}`);
  }
  const data = json?.data?.data ?? json?.data;
  if (!data?.accessToken) throw new Error(`续期返回里没有 accessToken: ${text.slice(0, 300)}`);
  const now = Date.now();
  return {
    ...session,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || session.refreshToken,
    tokenType: data.tokenType || session.tokenType,
    domain: data.domain || session.domain,
    expiresAt: data.expiresIn ? now + Number(data.expiresIn) * 1000 : 0,
    refreshExpiresAt: data.refreshExpiresIn ? now + Number(data.refreshExpiresIn) * 1000 : session.refreshExpiresAt,
    lastRefreshTime: now,
    source: session.source === 'file' ? 'file+refresh' : 'cache+refresh',
    savedAt: now,
  };
}

const sessionFile = (cfg) => path.join(cfg.paths.data, 'wb-session.json');

export class Credentials {
  constructor(cfg, logger = console) {
    this.cfg = cfg;
    this.logger = logger;
    this.session = null;
    this.ensureInflight = null;
    this.renewInflight = null;
  }

  /** 读缓存（不解密、不联网）。 */
  loadCached() {
    const cached = readJson(sessionFile(this.cfg));
    if (cached?.accessToken) this.session = cached;
    return this.session;
  }

  save(session) {
    this.session = session;
    writeJson(sessionFile(this.cfg), session);
  }

  get isExpiring() {
    const s = this.session;
    if (!s?.accessToken) return true;
    if (!s.expiresAt) return false; // 没有过期信息就先用着，401 再说
    return s.expiresAt - Date.now() < this.cfg.credentials.refreshBeforeSec * 1000;
  }

  /**
   * 拿到一份可用会话。
   *   force=false：缓存 → 快过期就先续期 → 还不行才回落到解文件（同一个调用去重）
   *   force=true ：跳过缓存与去重，直接从会话文件重新解密（换账号 / 客户端刚登录时用）
   */
  async ensure({ force = false } = {}) {
    // force 必须绕过 single-flight：否则并发期间会拿到「进行中那份」的旧账号/旧 token
    if (force) return this.#ensure(true);
    if (this.ensureInflight) return this.ensureInflight;
    this.ensureInflight = this.#ensure(false).finally(() => {
      this.ensureInflight = null;
    });
    return this.ensureInflight;
  }

  async #ensure(force) {
    if (!force) {
      if (!this.session) this.loadCached();
      if (this.session?.accessToken && !this.isExpiring) return this.session;
      if (this.session?.refreshToken) {
        try {
          const refreshed = await refreshSession(this.cfg, this.session);
          this.save(refreshed);
          this.logger.info?.(`[creds] 已续期，新 token 有效期至 ${new Date(refreshed.expiresAt).toLocaleString()}`);
          return refreshed;
        } catch (error) {
          this.logger.warn?.(`[creds] 续期失败：${error.message}，改用会话文件`);
        }
      }
    }
    // 只重读会话文件；at-rest 静态密钥是稳定的，不该每次都重新拉一遍 WorkBuddy.exe
    const fromFile = readSessionFromFile(this.cfg);
    this.save(fromFile);
    this.logger.info?.(`[creds] 已从本机会话文件解出凭证（uid=${fromFile.uid}）`);
    return fromFile;
  }

  /**
   * 上游 401 时调用：优先用 refreshToken 换票，换不动才重读会话文件。
   * 同样做 single-flight —— 并发 401 各打一次续期会用同一个 refreshToken，
   * 上游轮换时必然有一次作废，后写还会覆盖先写。
   */
  async renew() {
    if (this.renewInflight) return this.renewInflight;
    this.renewInflight = this.#renew().finally(() => {
      this.renewInflight = null;
    });
    return this.renewInflight;
  }

  async #renew() {
    const base = this.session ?? this.loadCached();
    if (base?.refreshToken) {
      try {
        const refreshed = await refreshSession(this.cfg, base);
        // 换了票却拿到同一个 token（或根本没换）→ 换票不解决问题，改走重读文件
        if (refreshed.accessToken && refreshed.accessToken !== base.accessToken) {
          this.save(refreshed);
          this.logger.info?.('[creds] 401 后已换票');
          return refreshed;
        }
        this.logger.warn?.('[creds] 换票后 token 未变化，改为重读会话文件');
      } catch (error) {
        this.logger.warn?.(`[creds] 401 换票失败：${error.message}，改为重读会话文件`);
      }
    }
    this.session = null;
    return this.#ensure(true);
  }

  invalidate() {
    this.session = null;
  }
}
