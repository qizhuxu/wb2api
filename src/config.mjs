// 配置加载：config.yaml + 环境变量覆盖。
// 环境变量：WB2API_PORT / WB2API_HOST / WB2API_ENDPOINT / WB2API_WORKBUDDY_EXE / WB2API_AUTH_FILE
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = path.join(ROOT, 'config.yaml');

const DEFAULTS = {
  server: { host: '127.0.0.1', port: 18788, apiKey: 'wb2api', maxBodyBytes: 32 * 1024 * 1024 },
  upstream: {
    endpoint: 'https://copilot.tencent.com',
    chatPath: '/v2/chat/completions',
    configPath: '/v3/config',
    refreshPath: '/v2/plugin/auth/token/refresh',
    appVersion: '0.0.0',
    productTag: 'SaaS',
    ideName: 'WorkBuddy',
    timeoutMs: 300000,
    // 思考等级：注入顶层 `reasoning_effort`（上游只认这个蛇形字段，
    // `reasoning:{effort}` 会被静默忽略 —— 实测见 src/upstream.mjs!applyReasoning）。
    // 取值 minimal|low|medium|high|xhigh|max；留空 = 不注入（上游完全不思考）。
    // 客户端自己传了 reasoning_effort / reasoning.effort 时以客户端为准。
    reasoningEffort: 'max',
    // 同时要思考摘要（上游支持 "auto"）；留空则不注入。
    reasoningSummary: 'auto',
  },
  credentials: {
    workbuddyExe: 'D:\\workbuddy\\WorkBuddy.exe',
    authFile: '',
    dataDir: 'data',
    refreshBeforeSec: 600,
  },
  models: {
    // 本地产品配置（桌面端同源，含 52 个模型与完整元数据）作为权威目录。
    // 置 false 则只认上游 /v3/config 下发的 37 个。
    useLocalCatalog: true,
    // 留空则自动发现：%ACC_PRODUCT_CONFIG_PATH% → ~/.workbuddy/cache/acc-product-config-v3.json
    productConfigPath: '',
    // 兜底候选 id：两个目录都没有、但确实可路由的模型（探活通过才显示）。
    extraIds: [],
    // 兜底条目的元数据（id → {name, contextLength, maxOutputTokens, vendor, supports*}）。
    // 必填：DSH 的「获取可用模型」只读 context_length / max_output_tokens / name，
    // 缺了会掉进它自己的 262144 / 32768 默认值。
    extraMeta: {},
    probeIntervalSec: 43200,
  },
  logging: { capture: false, captureDir: 'logs', dir: 'logs' },
};

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

export function loadConfig() {
  let raw = {};
  if (fs.existsSync(CONFIG_PATH)) {
    raw = YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  }
  const cfg = merge(DEFAULTS, raw);

  const env = process.env;
  if (env.WB2API_HOST) cfg.server.host = env.WB2API_HOST;
  if (env.WB2API_PORT) cfg.server.port = Number(env.WB2API_PORT);
  if (env.WB2API_ENDPOINT) cfg.upstream.endpoint = env.WB2API_ENDPOINT;
  // 思考等级：设为空串 = 关掉注入；WB2API_REASONING_EFFORT=off 同样表示不思考
  if (env.WB2API_REASONING_EFFORT !== undefined) {
    const v = env.WB2API_REASONING_EFFORT.trim();
    cfg.upstream.reasoningEffort = v === 'off' || v === 'none' ? '' : v;
  }
  if (env.WB2API_REASONING_SUMMARY !== undefined) cfg.upstream.reasoningSummary = env.WB2API_REASONING_SUMMARY.trim();
  if (env.WB2API_WORKBUDDY_EXE) cfg.credentials.workbuddyExe = env.WB2API_WORKBUDDY_EXE;
  if (env.WB2API_AUTH_FILE) cfg.credentials.authFile = env.WB2API_AUTH_FILE;
  if (env.WB2API_EXTRA_MODELS) {
    cfg.models.extraIds = env.WB2API_EXTRA_MODELS.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (env.WB2API_PRODUCT_CONFIG) cfg.models.productConfigPath = env.WB2API_PRODUCT_CONFIG;
  if (env.WB2API_NO_LOCAL_CATALOG) cfg.models.useLocalCatalog = false;
  if (env.WB2API_PROBE_INTERVAL) cfg.models.probeIntervalSec = Number(env.WB2API_PROBE_INTERVAL) || cfg.models.probeIntervalSec;

  cfg.server.port = Number(cfg.server.port) || 18788;
  cfg.paths = {
    root: ROOT,
    data: path.isAbsolute(cfg.credentials.dataDir) ? cfg.credentials.dataDir : path.join(ROOT, cfg.credentials.dataDir),
    logs: path.isAbsolute(cfg.logging.dir) ? cfg.logging.dir : path.join(ROOT, cfg.logging.dir),
  };
  return cfg;
}

/** WorkBuddy 的共享数据根（basePath）：auth 文件就在它下面。 */
export function codebuddyBasePath() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CodeBuddyExtension');
}

/** WorkBuddy 的 auth 目录：所有 .info 会话文件（含 clean() 备份）都在这里。 */
export function codebuddyAuthDir() {
  return path.join(codebuddyBasePath(), 'Data', 'Public', 'auth');
}

/** 备份文件判定：clean() 重命名时会插入 ISO 时间戳（<id>.<2026-10-01T16-13-22-792Z>.<pid>.<uuid>.info）。 */
export function isBackupAuthName(name) {
  return /\d{4}-\d{2}-\d{2}T/.test(String(name));
}

/**
 * 自动发现加密会话文件。
 *
 * 目录形如 <base>/Data/Public/auth/workbuddy-desktop.info，
 * 同目录还可能有 clean() 产生的备份：<id>.<时间戳>.<pid>.<uuid>.info —— 按“名字里没有时间戳”优先，
 * 其次取最新修改的。
 */
export function discoverAuthFile() {
  const dir = codebuddyAuthDir();
  if (!fs.existsSync(dir)) return '';
  const entries = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.info'))
    .map((n) => {
      const full = path.join(dir, n);
      return { full, name: n, backup: isBackupAuthName(n), mtime: fs.statSync(full).mtimeMs };
    });
  if (!entries.length) return '';
  entries.sort((a, b) => Number(a.backup) - Number(b.backup) || b.mtime - a.mtime);
  return entries[0].full;
}

export function resolveWorkbuddyExe(cfg) {
  const cands = [
    cfg.credentials.workbuddyExe,
    'D:\\workbuddy\\WorkBuddy.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
    'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  return '';
}

/* ---------------------------------------------------------------- 运行时账号覆盖 */

/**
 * 运行时账号覆盖文件（`data/active-account.json`）。
 *
 * 管理台上「切换账号」**不写 config.yaml** —— 那份文件是用户手写的、带注释，
 * 程序改写会把注释和排版全冲掉。改用这个运行时文件记「当前选中的会话文件」，
 * 优先级高于 `credentials.authFile`，删掉它即回到配置值。
 */
export function activeAccountPath(cfg) {
  const dataDir = cfg?.paths?.data;
  return dataDir ? path.join(dataDir, 'active-account.json') : '';
}

/** 读运行时覆盖；文件不存在/坏了都返回 null（坏了要当没覆盖，而不是让服务起不来）。 */
export function readActiveAccount(cfg) {
  const file = activeAccountPath(cfg);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof raw?.file === 'string' && raw.file ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 解析当前该用哪个会话文件。优先级：
 *   1. 运行时覆盖 `data/active-account.json`（管理台切换的结果，带 existsSync 校验）
 *   2. `credentials.authFile`（配置 / 环境变量 WB2API_AUTH_FILE）
 *   3. 自动发现（非备份优先 → mtime 最新）
 * `ignoreOverride` 供管理台显示「配置原本指向哪个文件」用。
 */
export function resolveAuthFile(cfg, { ignoreOverride = false } = {}) {
  if (!ignoreOverride) {
    const override = readActiveAccount(cfg);
    // 覆盖指向的文件被删/被 clean() 改名时静默回退，不让服务卡在一个不存在的路径上
    if (override?.file && fs.existsSync(override.file)) return override.file;
  }
  return cfg?.credentials?.authFile || discoverAuthFile();
}
