// 模型目录发现：把「上游 /v3/config」与「WorkBuddy 本地产品配置」合并成一份完整模型表。
//
// 为什么需要这个模块（实测结论，别凭直觉改）：
//   1. 上游 /v3/config 只下发 **37 个**模型 —— copilot.tencent.com 与 www.workbuddy.cn 都是 37，
//      换 X-IDE-Version（5.6.2/5.6.3/5.7.0/latest）也不变；/v3/models、/v3/product-config 等
//      候选路径全部 404。
//   2. 但桌面端显示 **52 个**。多的 15 个来自它本地缓存的产品配置：
//      ~/.workbuddy/cache/acc-product-config-v3.json（顶层就是完整产品配置，含 date/commit/genieVersion）。
//      **实测该文件的 models[] 恰好 52 条**，与桌面端一致。
//   3. 上游那份 37 的响应是完整产品配置的**子集**：它缺 models 之外的大量顶层键
//      （modelTiers / modelPromotions / fillToolCallContentModelWhitelist / relatedModels 等），
//      而模型条目本身在两边**同构**（都带 maxInputTokens / maxOutputTokens / contextWindow /
//      supportsToolCall / vendor …）。
//
// 所以本模块的策略是：
//   - 本地产品配置存在 → 用它作为**权威目录**（52 个），拿它的字段当元数据（含 1M 上下文）。
//   - 上游 /v3/config 作为**兜底与增量**：本地没装的模型（上游新增/灰度）照样并入。
//   - 两边同一 id 冲突时以**本地产品配置为准**（它字段更全，且桌面端就是按它显示的）。
//   - 都不覆盖、但确实能路由的 id（如将来的新模型）→ 交给 server.mjs 探活后补入。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** WorkBuddy 本地缓存的产品配置路径（可用 ACC_PRODUCT_CONFIG_PATH 覆盖，与桌面端同款环境变量）。 */
export function productConfigCandidates() {
  const home = os.homedir();
  const cands = [];
  const fromEnv = process.env.ACC_PRODUCT_CONFIG_PATH;
  if (fromEnv) cands.push(fromEnv);
  cands.push(path.join(home, '.workbuddy', 'cache', 'acc-product-config-v3.json'));
  return cands;
}

/**
 * 读本地产品配置。
 * 返回 { models, source, date, commit, genieVersion }；读不到就返回 null（不抛，调用方走上游兜底）。
 *
 * 注意：这个文件是桌面端自己写的缓存，**可能不存在**（没装桌面端 / 没登录过），
 * 也可能**格式变**。所以任何异常都降级成 null，绝不能让 /v1/models 挂掉。
 */
export function loadLocalProductConfig(explicitPath = '') {
  const cands = explicitPath ? [explicitPath] : productConfigCandidates();
  for (const p of cands) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      // 兼容两种形状：顶层直接是配置，或包在 data 里
      const cfg = raw?.data && typeof raw.data === 'object' ? raw.data : raw;
      const models = extractModels(cfg);
      if (!models.length) continue;
      return {
        models,
        source: p,
        date: cfg.date ?? null,
        commit: cfg.commit ?? null,
        genieVersion: cfg.genieVersion ?? null,
        mtimeMs: fs.statSync(p).mtimeMs,
      };
    } catch {
      // 单个候选失败就试下一个
    }
  }
  return null;
}

/** 从产品配置对象里抽出模型数组（models 可能是数组，也可能是 id->entry 的映射）。 */
function extractModels(cfg) {
  const m = cfg?.models;
  if (Array.isArray(m)) return m.filter((x) => x && typeof x === 'object' && x.id);
  if (m && typeof m === 'object') {
    // 映射形状：键是请求 id，条目可能自带不同的 id（与 pi-ai 发现逻辑同款处理）
    return Object.entries(m)
      .filter(([, v]) => v && typeof v === 'object')
      .map(([k, v]) => ({ ...v, id: v.id || k }));
  }
  return [];
}

/**
 * 合并「本地产品配置」与「上游目录」，产出 OpenAI /v1/models 形状的列表。
 *
 * 合并规则（顺序即优先级，先到先得）：
 *   1. 本地产品配置的 52 个（元数据权威）
 *   2. 上游 /v3/config 独有的（本地没有的，补进来）
 *
 * @param {object|null} local   loadLocalProductConfig() 的结果
 * @param {object} upstreamData 上游 /v3/config 的 data
 */
export function mergeCatalog(local, upstreamData) {
  const out = [];
  const seen = new Set();

  const push = (m, origin) => {
    const id = m?.id;
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(toEntry(m, origin));
  };

  for (const m of local?.models ?? []) push(m, 'local');
  for (const m of extractModels(upstreamData ?? {})) push(m, 'upstream');

  return out;
}

/**
 * 产品配置条目 → OpenAI 模型对象。
 *
 * 容量字段的取值优先级（实测字段名）：
 *   maxInputTokens / maxAllowedSize → context_length（两者通常相同；v4.1 系列都是 1000000）
 *   maxOutputTokens                → max_output_tokens
 *   contextWindow.defaultLength    → 上游页面默认展示的档位（300000），**不是**上限，只作参考
 *
 * 兼容上游 /v3/config 的旧字段拼写（maxInputTokens 等大小写差异）。
 */
export function toEntry(m, origin = 'upstream') {
  const ctx = m.contextWindow;
  const ctxDefault = ctx && typeof ctx === 'object' ? ctx.defaultLength ?? null : null;
  const ctxSupported = ctx && typeof ctx === 'object' && Array.isArray(ctx.supportedLengths) ? ctx.supportedLengths : null;
  // 上限：优先 maxInputTokens，其次 maxAllowedSize
  const contextLength = num(m.maxInputTokens) ?? num(m.maxAllowedSize) ?? null;

  return {
    id: m.id,
    object: 'model',
    created: 0,
    owned_by: m.vendor || 'workbuddy',
    name: m.name ?? m.id,
    context_length: contextLength,
    // 上游页面「默认档位」与可选档位，保留下来便于上层选长度
    context_default: ctxDefault,
    context_supported: ctxSupported,
    max_output_tokens: num(m.maxOutputTokens) ?? null,
    supports_images: !!m.supportsImages,
    supports_tools: !!m.supportsToolCall,
    supports_reasoning: !!m.supportsReasoning,
    is_default: !!m.isDefault,
    // 来源标记：local=本地产品配置（桌面端同源）、upstream=上游 /v3/config 下发
    catalog: origin,
  };
}

/** 只接受有限数字，其余（含 undefined/NaN/字符串）一律 null。 */
export function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 产品配置的「新鲜度」摘要，给状态页 / 自检看。 */
export function catalogInfo(local) {
  if (!local) return { source: null, models: 0, note: '本地产品配置不可用，仅用上游 /v3/config' };
  return {
    source: local.source,
    models: local.models.length,
    date: local.date,
    commit: local.commit,
    genieVersion: local.genieVersion,
  };
}
