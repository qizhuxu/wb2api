// WorkBuddy 一方网关的调用层：身份头、模型表、流式聊天。
//
// 上游是 OpenAI 风格镜像，但有三个硬约束（都实测过）：
//   1. 必须带齐 X-Product / X-IDE-* / X-Private-Data / UA，缺了报 400 "check ua, get coding copilot version error"
//   2. /v2/chat/completions 只收 stream:true，stream:false 直接 400 code=11101
//   3. 身份头与 Authorization 必须成组出现，否则 401

function randomHex(bytes) {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  return Buffer.from(b).toString('hex');
}

/** 构造上游请求头（与 daemon-bootstrap.js!buildComputerUseVlmGatewayHeaders 同构）。 */
export function buildIdentityHeaders(cfg, session, extra = {}) {
  const version = cfg.upstream.appVersion;
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Product': cfg.upstream.productTag,
    'X-IDE-Type': cfg.upstream.ideName,
    'X-IDE-Name': cfg.upstream.ideName,
    'X-IDE-Version': version,
    'X-Private-Data': 'true',
    'x-requested-with': 'XMLHttpRequest',
    'User-Agent': `${cfg.upstream.ideName}/${version} ${cfg.upstream.ideName}/${version}`,
    ...extra,
  };
  if (session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;
  if (session?.uid) headers['X-User-Id'] = session.uid;
  if (session?.enterpriseId) {
    headers['X-Enterprise-Id'] = session.enterpriseId;
    headers['X-Tenant-Id'] = session.enterpriseId;
  }
  if (session?.domain) headers['X-Domain'] = session.domain;
  return headers;
}

function applyTrace(headers) {
  const traceId = randomHex(16);
  headers['X-Request-Id'] = randomHex(16);
  headers['X-Trace-ID'] = traceId;
  headers['X-B3-TraceId'] = traceId;
  headers['X-B3-SpanId'] = randomHex(8);
  headers['X-B3-Sampled'] = '1';
}

const url = (cfg, p) => `${cfg.upstream.endpoint.replace(/\/+$/, '')}${p}`;

/** 上游认的思考等级（顶层蛇形 reasoning_effort）。实测 `reasoning:{effort}` 会被忽略。 */
const EFFORT_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * 按需给上游请求注入思考参数。
 *
 * **为什么必须在这里注入**（实测结论，别删）：
 *   - 上游只认**顶层** `reasoning_effort`（蛇形）。传 `reasoning: {effort: "max"}`（客户端 SDK 形状）
 *     会被静默忽略 —— 实测同一问题带 `reasoning_effort:"max"` 出 158 字符 `reasoning_content`
 *     与 58 个 reasoning_tokens，而 `reasoning:{effort}` 是 0 字符 / 0 tokens。
 *   - DSH 直连本服务，中间没有 WorkBuddy 客户端那层 SDK→蛇形的转换，所以得我们补。
 *   - 不带这些字段时上游**完全不思考**（reasoning_tokens=0），而产品配置里
 *     `deepseek-v4.1-flash` 是 onlyReasoning 模型，等于白丢了能力。
 *
 * 优先级（高→低），保证「显式传的」永远赢：
 *   1. 客户端已带 `reasoning_effort`（合法值）→ 原样不动
 *   2. 客户端带了 `reasoning.effort`（OpenAI SDK 形状）→ 转成 `reasoning_effort`
 *   3. 客户端显式传 `reasoning: false` / `reasoning_effort: "off"|"none"` → 不注入（尊重关闭意图）
 *   4. 否则用配置的 `upstream.reasoningEffort`
 */
export function applyReasoning(cfg, body) {
  const level = cfg?.upstream?.reasoningEffort;
  const summary = cfg?.upstream?.reasoningSummary;

  // 1) 客户端已经给了合法的蛇形 effort
  if (typeof body.reasoning_effort === 'string') {
    if (EFFORT_LEVELS.has(body.reasoning_effort)) return body;
    // "off" / "none" / 垃圾值 → 视为明确不思考
    return body;
  }

  // 2) OpenAI SDK 形状 reasoning:{effort} → 转蛇形（上游不认它，必须转）
  const nested = body.reasoning;
  if (nested && typeof nested === 'object' && typeof nested.effort === 'string') {
    const out = { ...body };
    delete out.reasoning;
    out.reasoning_effort = nested.effort;
    if (summary && !out.reasoning_summary) out.reasoning_summary = summary;
    return out;
  }

  // 3) 显式关闭
  if (nested === false || nested === null) return body;
  if (typeof nested === 'string' && (nested === 'off' || nested === 'none')) return body;

  // 4) 用配置默认值
  if (!level || !EFFORT_LEVELS.has(level)) return body;
  const out = { ...body, reasoning_effort: level };
  if (summary && !out.reasoning_summary) out.reasoning_summary = summary;
  return out;
}

/** GET /v3/config —— 模型清单、产品配置都在里面。 */
export async function fetchProductConfig(cfg, session, { signal } = {}) {
  const headers = buildIdentityHeaders(cfg, session);
  applyTrace(headers);
  const res = await fetch(url(cfg, cfg.upstream.configPath), { headers, signal });
  const text = await res.text();
  if (!res.ok) throw new UpstreamError(res.status, text, '拉取产品配置失败');
  const json = JSON.parse(text);
  if (json?.code !== 0 && json?.code !== undefined) throw new UpstreamError(res.status, text, `上游返回 code=${json.code} ${json.msg || ''}`);
  return json.data ?? json;
}

/**
 * 把**上游 /v3/config 单独一份**模型表映射成 OpenAI /v1/models 形状。
 *
 * ⚠️ 已不是 /v1/models 的主路径：上游只下发 37 个，而真实目录是 52 个，
 * 现在由 `src/catalog.mjs!mergeCatalog` 合并「本地产品配置 + 上游目录」产出。
 * 这里保留是因为它仍适合「只想看上游那一份」的调用方，且字段映射是合并逻辑的参考实现。
 */
export function toOpenAIModels(data) {
  const list = Array.isArray(data?.models) ? data.models : [];
  return list.map((m) => ({
    id: m.id,
    object: 'model',
    created: 0,
    owned_by: m.vendor || 'workbuddy',
    // 额外信息不影响 OpenAI 客户端，保留下来便于选模型
    name: m.name,
    context_length: m.maxInputTokens ?? m.maxAllowedSize ?? null,
    max_output_tokens: m.maxOutputTokens ?? null,
    supports_images: !!m.supportsImages,
    supports_tools: !!m.supportsToolCall,
    supports_reasoning: !!m.supportsReasoning,
    is_default: !!m.isDefault,
  }));
}

/**
 * 发起一次流式聊天。**总是**以 stream:true 打上游，非流式由上层聚合。
 * 返回原始 Response（body 是 SSE 流）。
 */
export async function chatStream(cfg, session, body, { signal } = {}) {
  const headers = buildIdentityHeaders(cfg, session);
  applyTrace(headers);
  // 补思考参数（上游认顶层 reasoning_effort，见 applyReasoning 注释）
  const payload = { ...applyReasoning(cfg, body), stream: true };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('上游超时')), cfg.upstream.timeoutMs);
  if (signal?.aborted) ac.abort(signal.reason);
  else signal?.addEventListener('abort', () => ac.abort(signal.reason), { once: true });
  const res = await fetch(url(cfg, cfg.upstream.chatPath), {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: ac.signal,
  }).finally(() => clearTimeout(timer));
  return res;
}

/**
 * 给某个模型 id 发一个 1-token 的探活请求，确认网关真的能路由它。
 * 用于「上游列表不下发、但实际可调用」的补充模型（如 deepseek-v4.1-flash）。
 *
 * 注意：上游经常把 `: heartbeat` 当**首片**发，所以不能只看第一片，
 * 要一直读到出现真正的 data 帧为止（有截止时间），否则会把可用模型误判为不可用。
 */
export async function probeModel(cfg, session, modelId) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('probe timeout')), 25000);
  try {
    const res = await fetch(url(cfg, cfg.upstream.chatPath), {
      method: 'POST',
      headers: { ...buildIdentityHeaders(cfg, session), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        stream: true,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      await res.body?.cancel?.().catch(() => {});
      return false;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let acc = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return false;
        // 注释行（: heartbeat）不是数据帧，继续读
        acc += decoder.decode(value, { stream: true });
        if (acc.includes('"choices"') && /(^|\n)data:\s*\{/.test(acc)) return true;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export class UpstreamError extends Error {
  constructor(status, text, message) {
    let detail = text?.slice(0, 500) ?? '';
    try {
      const j = JSON.parse(text);
      detail = `${j.code ?? ''} ${j.msg ?? ''}`.trim() || detail;
    } catch {}
    super(`${message}（HTTP ${status}${detail ? `: ${detail}` : ''}）`);
    this.status = status;
    this.raw = text;
  }
}

/**
 * 逐行解析上游 SSE。
 *
 * 上游会掺 `: heartbeat` 注释行；OpenAI 客户端按规范会忽略注释，但聚合器要跳过它们。
 * 回调拿到已解析的 chunk 对象（[DONE] 单独用 done 标记）。
 */
export async function forEachChunk(response, onChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let sawDone = false;
  let parseErrors = 0;

  const handleLine = async (rawLine) => {
    let line = rawLine;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line.startsWith('data:')) return; // 空行 / `: heartbeat` 之类的注释行
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      sawDone = true;
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      // 不能静默丢：非流式路径会变成「200 + 内容被截断」，流式路径客户端也察觉不到。
      // 计数交给调用方决定是报错还是继续。
      parseErrors++;
      return;
    }
    await onChunk(chunk);
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      await handleLine(line);
    }
  }
  // 收尾：最后一个事件可能没有换行结尾（含 usage 的那条，丢了会少 token 统计）
  buffer += decoder.decode();
  if (buffer.trim()) await handleLine(buffer);
  return { sawDone, parseErrors };
}

/** 把一堆流式 chunk 合成一条非流式 completion（OpenAI 形状）。 */
export function aggregate(chunks) {
  const first = chunks[0];
  const out = {
    id: first?.id ?? `chatcmpl-${randomHex(8)}`,
    object: 'chat.completion',
    created: first?.created ?? Math.floor(Date.now() / 1000),
    model: first?.model ?? '',
    choices: [],
    usage: null,
  };
  const byIndex = new Map();
  for (const chunk of chunks) {
    if (chunk.usage) out.usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      const i = choice.index ?? 0;
      if (!byIndex.has(i)) {
        byIndex.set(i, {
          index: i,
          message: { role: 'assistant', content: '' },
          finish_reason: null,
          // tool_calls 用 Map 而不是稀疏数组：上游缺 index 时要顺序补号，
          // index 从 1 起时也不能产出 null 洞（严格客户端会校验失败）。
          toolCalls: new Map(),
          toolCallsById: new Map(),
          nextToolIndex: 0,
        });
      }
      const acc = byIndex.get(i);
      const d = choice.delta ?? {};
      if (d.role) acc.message.role = d.role;
      if (typeof d.content === 'string' && d.content) acc.message.content += d.content;
      if (typeof d.reasoning_content === 'string' && d.reasoning_content) {
        acc.message.reasoning_content = (acc.message.reasoning_content || '') + d.reasoning_content;
      }
      if (typeof d.refusal === 'string' && d.refusal) acc.message.refusal = (acc.message.refusal || '') + d.refusal;
      if (Array.isArray(d.tool_calls) && d.tool_calls.length) {
        for (const tc of d.tool_calls) {
          // 上游正常会带 index；缺 index 时按 id 归位，再不行才新开一槽。
          // 直接用数组长度当槽号会把「工具B」拼进「工具A」里。
          let ti;
          if (Number.isFinite(tc.index)) ti = tc.index;
          else if (tc.id && acc.toolCallsById.has(tc.id)) ti = acc.toolCallsById.get(tc.id);
          else ti = acc.nextToolIndex++;
          if (tc.id) acc.toolCallsById.set(tc.id, ti);
          if (ti >= acc.nextToolIndex) acc.nextToolIndex = ti + 1;
          if (!acc.toolCalls.has(ti)) {
            acc.toolCalls.set(ti, { id: tc.id ?? '', type: 'function', function: { name: '', arguments: '' } });
          }
          const slot = acc.toolCalls.get(ti);
          if (tc.id) slot.id = tc.id;
          if (tc.type) slot.type = tc.type;
          if (tc.function?.name) slot.function.name += tc.function.name;
          if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
        }
      }
      if (choice.finish_reason) acc.finish_reason = choice.finish_reason;
    }
  }
  out.choices = [...byIndex.values()]
    .sort((a, b) => a.index - b.index)
    .map((acc) => {
      const message = { ...acc.message };
      if (acc.toolCalls.size) {
        message.tool_calls = [...acc.toolCalls.keys()].sort((a, b) => a - b).map((k) => acc.toolCalls.get(k));
      }
      return { index: acc.index, message, finish_reason: acc.finish_reason ?? 'stop' };
    });
  if (!out.choices.length) {
    out.choices = [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }];
  }
  // OpenAI 恒返回 usage 对象；上游偶尔不上报，缺省补零，免得客户端读 total_tokens 直接炸
  if (!out.usage) out.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return out;
}
