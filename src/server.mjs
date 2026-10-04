// OpenAI 兼容 HTTP 层。
//
// 设计原则跟 xm2api 一致：**不改你的请求**（除了必须补的 stream:true），
// 上游 SSE 原样透传；只有客户端明确要 stream:false 时，才在这里把流聚合成一条 JSON。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { Credentials } from './creds.mjs';
import { listAccounts, validateSwitchTarget } from './accounts.mjs';
import {
  chatStream,
  fetchProductConfig,
  probeModel,
  forEachChunk,
  aggregate,
} from './upstream.mjs';
import { loadLocalProductConfig, mergeCatalog, catalogInfo, num } from './catalog.mjs';

export const VERSION = '0.1.0';

/**
 * 管理台（GET /ui）的静态资源目录。
 *
 * 只托管**显式白名单**里的文件：路径从 URL 里取，但绝不直接拼进文件系统，
 * 所以 /ui/../config.yaml 这类穿越请求只会落到 404，不会读到仓库里的别的东西。
 */
const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const UI_ASSETS = {
  'index.html': 'index.html',
  'style.css': 'style.css',
  'app.js': 'app.js',
};

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function openAIError(status, message, type = 'invalid_request_error', code = null) {
  return { error: { message, type, param: null, code } };
}

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** 浏览器访问根路径时给的状态页（自包含，无外部资源）。 */
function statusPage(info, base) {
  const login = info.login || {};
  const ok = !login.error;
  const rows = ok
    ? [
        ['账号 uid', login.uid],
        ['uin', login.uin],
        ['域', login.domain || '-'],
        ['凭证来源', login.source],
        ['access token 到期', login.expiresAt],
        ['refresh token 到期', login.refreshExpiresAt],
        ['可用模型', `${info.models.length} 个`],
      ]
    : [['凭证状态', `不可用：${login.error}`]];
  const endpoints = [
    ['POST', '/v1/chat/completions', '对话 / 工具调用（stream 真/假都支持）'],
    ['GET', '/v1/models', '模型目录（本地产品配置 + 上游 /v3/config 合并）'],
    ['GET', '/v1/models/{id}', '单个模型'],
    ['GET', '/ui', '**管理台**（账号 / 凭证 / 模型 / 自检 / 危险操作；静态资源，无构建/无外链）'],
    ['GET', '/__wb2api', '自检 JSON'],
    ['GET', '/?format=json', '本页的 JSON 版本'],
    ['GET', '/__wb2api/accounts', '本机所有账号（会话文件）与各自状态'],
    ['POST', '/__wb2api/accounts/switch', '切换当前账号（body {"file": "<绝对路径>"}）'],
    ['POST', '/__wb2api/creds/refresh', '重新解析凭证（?mode=token 走换票）'],
    ['POST', '/__wb2api/shutdown', '让服务退出（仅本机）'],
  ];
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>wb2api v${esc(info.version)}</title>
<style>
  :root{--bg:#f6f7f9;--fg:#1b1f24;--mut:#656d76;--card:#fff;--line:#dfe3e8;--ok:#1a7f37;--bad:#c0392b;--acc:#0969da}
  @media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#8b949e;--card:#161b22;--line:#30363d;--ok:#3fb950;--bad:#f85149;--acc:#58a6ff}}
  *{box-sizing:border-box} body{margin:0;padding:32px 20px;background:var(--bg);color:var(--fg);
    font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  main{max-width:780px;margin:0 auto} h1{font-size:22px;margin:0 0 4px} h2{font-size:15px;margin:28px 0 10px;color:var(--mut);font-weight:600}
  .sub{color:var(--mut);font-size:13px;margin-bottom:20px}
  .pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;
    background:${ok ? 'rgba(26,127,55,.12)' : 'rgba(192,57,43,.12)'};color:${ok ? 'var(--ok)' : 'var(--bad)'}}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px}
  table{width:100%;border-collapse:collapse;font-size:14px}
  td{padding:6px 0;border-bottom:1px solid var(--line);vertical-align:top}
  tr:last-child td{border-bottom:0}
  td:first-child{color:var(--mut);width:190px;white-space:nowrap}
  code{background:rgba(127,127,127,.15);padding:2px 6px;border-radius:5px;font:13px/1.5 ui-monospace,Consolas,monospace}
  pre{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow:auto;
    font:13px/1.6 ui-monospace,Consolas,monospace;margin:0}
  .warn{border-color:${ok ? 'var(--line)' : 'var(--bad)'}}
  a{color:var(--acc)}
</style></head><body><main>
  <h1>wb2api <span style="font-size:13px;color:var(--mut)">v${esc(info.version)}</span></h1>
  <div class="sub">把本机 WorkBuddy 的账号会话反代成 OpenAI 兼容入口（本机自用，勿暴露公网）</div>
  <span class="pill">${ok ? '运行中 · 凭证可用' : '运行中 · 凭证不可用'}</span>
  <div style="margin-top:14px"><a href="/ui">→ 打开管理台（账号 / 凭证 / 模型 / 自检 / 危险操作）</a></div>
  <div style="margin-top:18px" class="card${ok ? '' : ' warn'}">
    <table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
  </div>
  <h2>客户端接法</h2>
  <pre>from openai import OpenAI
client = OpenAI(base_url="${esc(base)}/v1", api_key="wb2api")  # key 会被忽略
client.chat.completions.create(model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "你好"}])</pre>
  <h2>端点</h2>
  <div class="card"><table>${endpoints
    .map(([m, path, desc]) => `<tr><td><code>${esc(m)}</code> <code>${esc(path)}</code></td><td>${esc(desc)}</td></tr>`)
    .join('')}</table></div>
  <h2>上游</h2>
  <div class="card"><table><tr><td>网关</td><td><code>${esc(info.endpoint)}</code></td></tr></table></div>
</main></body></html>`;
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return; // 超限后继续把剩余字节读完，避免把 socket 掐死导致 413 发不出去
      total += c.length;
      if (total > maxBytes) {
        failed = true;
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (!failed) reject(error);
    });
  });
}

export function createServer(cfg = loadConfig(), logger = console) {
  const creds = new Credentials(cfg, logger);
  const modelsCache = { at: 0, data: null };
  const extraIds = [...(cfg.models?.extraIds ?? [])];

  if (!fs.existsSync(cfg.paths.logs)) fs.mkdirSync(cfg.paths.logs, { recursive: true });
  const logLine = (obj) => {
    if (!cfg.logging.capture) return;
    try {
      fs.appendFileSync(path.join(cfg.paths.logs, 'requests.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...obj })}\n`);
    } catch {}
  };

  // 补充模型的探活状态：id -> true(通)/false(不通)/undefined(还没探)
  const extraStatus = new Map();
  let extraProbeAt = 0;
  let extraProbeRun = null;

  async function verifyExtras(force = false) {
    if (!extraIds.length) return;
    const probeMs = (cfg.models?.probeIntervalSec ?? 43200) * 1000;
    if (!force && Date.now() - extraProbeAt < probeMs) return;
    if (extraProbeRun) return extraProbeRun;
    extraProbeAt = Date.now();
    extraProbeRun = (async () => {
      let session = null;
      try {
        session = await creds.ensure();
      } catch (e) {
        logger.warn?.(`[server] 探活跳过（凭证不可用）：${e.message}`);
        return;
      }
      // 逐个串行探，避免对上游打并发突击；读到真正的 data 帧即算可用
      let changed = false;
      for (const id of extraIds) {
        const ok = await probeModel(cfg, session, id);
        if (extraStatus.get(id) !== ok) changed = true;
        extraStatus.set(id, ok);
        if (ok) logger.info?.(`[server] 补充模型探活通过：${id}`);
        else logger.warn?.(`[server] 补充模型探活失败（不出现在列表）：${id}`);
      }
      // 探活结果变了就作废模型缓存，否则要等 5 分钟才会反映到 /v1/models
      if (changed) modelsCache.data = null;
    })().finally(() => {
      extraProbeRun = null;
    });
    return extraProbeRun;
  }

  // 启动后立刻在后台探一次，/v1/models 首次调用前大概率已就绪
  verifyExtras().catch(() => {});

  async function getModels(force = false) {
    if (!force && modelsCache.data && Date.now() - modelsCache.at < 5 * 60 * 1000) return modelsCache.data;
    const session = await creds.ensure();
    const data = await fetchProductConfig(cfg, session);
    // 上游 /v3/config 只下发 37 个；本地产品配置（桌面端同源）有 52 个。
    // 两者合并才是网关实际可路由的完整目录：以本地为准（字段最全），上游补齐。
    const local = cfg.models?.useLocalCatalog === false ? null : loadLocalProductConfig(cfg.models?.productConfigPath);
    const list = mergeCatalog(local, data);
    modelsCache.localInfo = catalogInfo(local);
    // 把两个来源都没下发、但探活通过的补充模型并进列表。
    //
    // 这些条目**必须自带能力与容量**：DSH 的「获取可用模型」只读
    // context_length / max_output_tokens / name（逐行核对过 pi-ai discovery 解析器），
    // 缺了就采纳成空值 → 掉进它自己 262144/32768 的默认值。
    // （modality 它压根不读，所以 supports_images 只对别的客户端有意义，仍如实声明。）
    if (extraIds.length) {
      const known = new Set(list.map((m) => m.id));
      for (const id of extraIds) {
        if (known.has(id)) continue;
        if (extraStatus.get(id) === false) continue; // 探活失败的不显示
        const meta = cfg.models?.extraMeta?.[id] ?? {};
        list.push({
          id,
          object: 'model',
          created: 0,
          owned_by: meta.vendor ?? 'workbuddy',
          name: meta.name ?? id,
          context_length: num(meta.contextLength),
          max_output_tokens: num(meta.maxOutputTokens),
          supports_images: meta.supportsImages !== false,
          supports_tools: meta.supportsTools !== false,
          supports_reasoning: meta.supportsReasoning !== false,
          catalog: 'probe', // 标记：不在任何目录里，靠探活确认可路由
          extra: true,
        });
      }
    }
    modelsCache.data = list;
    modelsCache.at = Date.now();
    return modelsCache.data;
  }

  /** /__wb2api 与首页共用的一份自检数据。 */
  async function buildSelfCheck() {
    let session = null;
    let error = null;
    try {
      session = await creds.ensure();
    } catch (e) {
      error = e.message;
    }
    let models = [];
    try {
      models = (await getModels()).map((m) => m.id);
    } catch (e) {
      error = error ?? e.message;
    }
    return {
      service: 'wb2api',
      version: VERSION,
      endpoint: cfg.upstream.endpoint,
      login: session
        ? {
            uid: session.uid,
            uin: session.uin,
            domain: session.domain,
            source: session.source,
            // 当前凭证来自哪个会话文件（管理台用它给「账号」视图标出当前账号）
            authFile: session.authFile ?? '',
            expiresAt: session.expiresAt ? new Date(session.expiresAt).toISOString() : null,
            refreshExpiresAt: session.refreshExpiresAt ? new Date(session.refreshExpiresAt).toISOString() : null,
          }
        : { error },
      models,
    };
  }

  async function handleChat(req, res) {
    let body;
    try {
      const raw = await readBody(req, cfg.server.maxBodyBytes);
      body = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      const status = error.status || 400;
      if (status === 413) {
        // 响应写完后才掐连接：先 end 再 destroy，客户端必须能读到 413
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
        res.end(JSON.stringify(openAIError(413, '请求体超过 server.maxBodyBytes')));
        res.on('finish', () => req.destroy());
        return;
      }
      return json(res, status, openAIError(status, `请求体不可解析：${error.message}`));
    }
    if (!Array.isArray(body?.messages) || !body.messages.length) {
      return json(res, 400, openAIError(400, '缺少 messages'));
    }
    const wantsStream = body.stream === true;
    const model = body.model || 'auto';
    const startedAt = Date.now();

    // 客户端提前断开（取消 / 超时）→ 立刻中止上游，否则上游会把整轮 token 烧完
    const clientGone = new AbortController();
    res.on('error', () => {}); // 断开后的写入失败不该抛到顶层
    res.on('close', () => {
      if (!res.writableEnded) clientGone.abort(new Error('客户端已断开'));
    });

    const sendUpstream = async () => {
      let s = await creds.ensure();
      let up = await chatStream(cfg, s, body, { signal: clientGone.signal });
      if (up.status === 401) {
        // 上游拒票 → 换一份凭证再打一次（与桌面端 VLM 代理同一策略）
        logger.warn?.('[server] 上游 401，强制换凭证后重试一次');
        s = await creds.renew();
        up = await chatStream(cfg, s, body, { signal: clientGone.signal });
      }
      return up;
    };

    let upstream;
    let handshakeRetried = false;
    for (;;) {
      try {
        upstream = await sendUpstream();
        break;
      } catch (error) {
        // 还没往客户端写任何东西，握手失败可以安全重试一次（上游偶发掐连接）
        if (!handshakeRetried && !clientGone.signal.aborted) {
          handshakeRetried = true;
          logger.warn?.(`[server] 上游握手失败，重试一次：${error.message}`);
          continue;
        }
        logLine({ path: req.url, model, ok: false, error: error.message });
        if (res.destroyed || clientGone.signal.aborted) return;
        return json(res, 502, openAIError(502, `上游不可达：${error.message}`, 'upstream_error'));
      }
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      logLine({ path: req.url, model, ok: false, status: upstream.status, body: text.slice(0, 300) });
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {}
      const message = parsed?.msg || parsed?.error_msg || text.slice(0, 300) || `上游 HTTP ${upstream.status}`;
      // 状态码要能表达「该不该重试」：401/403 与 429/5xx 原样透传，其余归 400。
      // 全压成 400 会让客户端把限流和上游故障当成自己的请求错误而不退避重试。
      const status = upstream.status;
      const outStatus = status === 401 || status === 403 || status === 429 || status >= 500 ? status : 400;
      const retryAfter = upstream.headers.get('retry-after');
      if (outStatus === 429 && retryAfter) res.setHeader('Retry-After', retryAfter);
      return json(res, outStatus, openAIError(status, message, 'upstream_error', parsed?.code ?? null));
    }

    // 上游有时用 200 + JSON 业务错误码回包（桌面端各处也是按 resp.code !== 0 判错的），
    // 不挡住的话会被当成「空流」返回 200，客户端只看到空回复、看不出错。
    const ctype = (upstream.headers.get('content-type') || '').toLowerCase();
    if (!ctype.includes('text/event-stream')) {
      const text = await upstream.text().catch(() => '');
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {}
      if (parsed && parsed.code !== undefined && parsed.code !== 0) {
        logLine({ path: req.url, model, ok: false, businessCode: parsed.code });
        return json(res, 400, openAIError(400, parsed.msg || `上游返回 code=${parsed.code}`, 'upstream_error', parsed.code));
      }
      logLine({ path: req.url, model, ok: false, nonSse: true, body: text.slice(0, 200) });
      return json(res, 502, openAIError(502, `上游未返回 SSE 流：${text.slice(0, 200) || '(空响应)'}`, 'upstream_error'));
    }

    if (wantsStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      let broken = null;
      let parseErrors = 0;
      let wrote = false; // 是否已经往客户端写过分片
      let retried = false;
      for (;;) {
        try {
          // forEachChunk 会把上游的 [DONE] 当成结束标记吃掉，这里统一补一条，
          // 保证客户端无论上游收尾与否都能看到规范的终止事件。
          const r = await forEachChunk(upstream, async (chunk) => {
            wrote = true;
            if (!res.destroyed) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          });
          parseErrors = r.parseErrors;
          broken = null;
          break;
        } catch (error) {
          broken = error;
          // 一个分片都还没发出去时，重试是幂等安全的：上游偶发在首片前掐连接（undici 报 terminated）
          if (wrote || retried || clientGone.signal.aborted) break;
          retried = true;
          logger.warn?.(`[server] 上游在首片前中断，重试一次：${error.message}`);
          try {
            upstream = await sendUpstream();
          } catch (retryError) {
            broken = retryError;
            break;
          }
          if (!upstream.ok) {
            broken = new Error(`重试后上游 HTTP ${upstream.status}`);
            break;
          }
        }
      }
      if (res.destroyed) return; // 客户端已经走了，没必要再写
      if (broken || parseErrors) {
        // 截断必须能与「正常完成」区分：发一条 error 事件，且**不发** [DONE]
        const reason = broken ? `上游流中断：${broken.message}` : `上游有 ${parseErrors} 个 SSE 帧无法解析`;
        res.write(`data: ${JSON.stringify(openAIError(502, reason, 'upstream_error'))}\n\n`);
      } else {
        res.write('data: [DONE]\n\n');
      }
      res.end();
      logLine({ path: req.url, model, stream: true, ok: !broken && !parseErrors, parseErrors, ms: Date.now() - startedAt });
      return;
    }

    const chunks = [];
    let parseErrors = 0;
    try {
      const r = await forEachChunk(upstream, async (chunk) => {
        chunks.push(chunk);
      });
      parseErrors = r.parseErrors;
    } catch (error) {
      if (res.destroyed) return;
      return json(res, 502, openAIError(502, `上游流读取失败：${error.message}`, 'upstream_error'));
    }
    if (parseErrors) {
      // 静默丢帧会让「200 + 内容被截断」看起来像成功，这里必须报出来
      logLine({ path: req.url, model, ok: false, parseErrors });
      return json(res, 502, openAIError(502, `上游有 ${parseErrors} 个 SSE 帧无法解析，内容不完整`, 'upstream_error'));
    }
    const completion = aggregate(chunks);
    if (!completion.model) completion.model = model;
    logLine({ path: req.url, model, stream: false, ok: true, ms: Date.now() - startedAt });
    return json(res, 200, completion);
  }

  async function handle(req, res) {
    const u = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const p = u.pathname;

    if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/route/chat/completions')) {
      return handleChat(req, res);
    }

    if (req.method === 'GET' && p === '/v1/models') {
      try {
        const force = u.searchParams.has('refresh');
        if (force) verifyExtras(true).catch(() => {}); // 顺带重探补充模型（不阻塞本次响应）
        return json(res, 200, { object: 'list', data: await getModels(force) });
      } catch (error) {
        return json(res, 502, openAIError(502, error.message, 'upstream_error'));
      }
    }

    if (req.method === 'GET' && p.startsWith('/v1/models/')) {
      const id = decodeURIComponent(p.slice('/v1/models/'.length));
      try {
        const list = await getModels();
        const hit = list.find((m) => m.id === id);
        if (hit) return json(res, 200, hit);
        return json(res, 404, openAIError(404, `未知模型 ${id}`, 'invalid_request_error', 'model_not_found'));
      } catch (error) {
        return json(res, 502, openAIError(502, error.message, 'upstream_error'));
      }
    }

    if (req.method === 'GET' && p === '/__wb2api') {
      return json(res, 200, await buildSelfCheck());
    }

    if (req.method === 'GET' && (p === '/' || p === '/index.html' || p === '/health')) {
      const info = await buildSelfCheck();
      const accept = req.headers.accept || '';
      // 浏览器给 HTML 状态页（不再一进来就看见 {"error":"no route"}）；脚本/客户端给 JSON
      if (u.searchParams.get('format') === 'json' || !accept.includes('text/html')) {
        return json(res, 200, info);
      }
      const html = statusPage(info, `http://${cfg.server.host}:${cfg.server.port}`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
      return res.end(html);
    }

    if (req.method === 'POST' && p === '/__wb2api/creds/refresh') {
      // mode=file（默认）：直接从会话文件重新解密；mode=token：用 refreshToken 换票
      const mode = u.searchParams.get('mode') === 'token' ? 'token' : 'file';
      try {
        const session = mode === 'token' ? await creds.renew() : await creds.ensure({ force: true });
        modelsCache.data = null;
        return json(res, 200, { ok: true, mode, uid: session.uid, expiresAt: session.expiresAt, source: session.source });
      } catch (error) {
        return json(res, 500, { ok: false, mode, error: error.message });
      }
    }

    // 多账号：列出本机所有会话文件（含桌面端 clean() 的备份）与各自状态。
    // 返回体里**没有任何 token**：只有 uid / uin / 昵称 / 到期时间 / 文件元信息。
    if (req.method === 'GET' && p === '/__wb2api/accounts') {
      try {
        const listed = await listAccounts(cfg, { logger });
        return json(res, 200, { ok: true, ...listed });
      } catch (error) {
        return json(res, 500, { ok: false, error: `枚举账号失败：${error.message}` });
      }
    }

    // 切换当前账号：只写运行时覆盖 data/active-account.json（**不改 config.yaml**，
    // 那份文件是用户手写的、带注释），然后立刻重解凭证 —— 热生效，下一次请求就用新账号。
    if (req.method === 'POST' && p === '/__wb2api/accounts/switch') {
      let body;
      try {
        const raw = await readBody(req, cfg.server.maxBodyBytes);
        body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      } catch (error) {
        return json(res, 400, { ok: false, error: `请求体不可解析：${error.message}` });
      }
      let listed;
      try {
        listed = await listAccounts(cfg, { logger });
      } catch (error) {
        return json(res, 500, { ok: false, error: `枚举账号失败：${error.message}` });
      }
      // 防路径穿越：file 必须逐字命中枚举结果（详见 src/accounts.mjs!validateSwitchTarget）
      const verdict = validateSwitchTarget(cfg, listed, body?.file);
      if (!verdict.ok) return json(res, verdict.status, { ok: false, error: verdict.error });
      if (verdict.account.error) {
        return json(res, 409, { ok: false, error: `该会话文件解不开，无法切换：${verdict.account.error}` });
      }
      try {
        const session = await creds.useAccount(verdict.file);
        modelsCache.data = null; // 换了账号，模型目录（可能随套餐不同）重新拉
        logger.info?.(`[server] 已切换账号 → ${path.basename(verdict.file)}（uid=${session.uid}）`);
        return json(res, 200, {
          ok: true,
          hot: true,
          file: verdict.file,
          name: verdict.account.name,
          uid: session.uid,
          uin: session.uin,
          source: session.source,
          expiresAt: session.expiresAt,
          note: '已切换并立即重新解析凭证，下一次请求即用新账号（无需重启）。config.yaml 未被修改。',
        });
      } catch (error) {
        return json(res, 500, { ok: false, file: verdict.file, error: `切换后重解凭证失败：${error.message}` });
      }
    }

    if (req.method === 'POST' && p === '/__wb2api/shutdown') {
      // 只认本机、且拒绝带 Origin 的浏览器请求（防 CSRF 式误关）
      const remote = req.socket.remoteAddress || '';
      const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
      if (!isLocal) return json(res, 403, { ok: false, error: 'only localhost' });
      if (req.headers.origin) return json(res, 403, { ok: false, error: 'origin not allowed' });
      json(res, 200, { ok: true, message: 'shutting down' });
      setTimeout(() => process.exit(0), 50);
      return;
    }

    if (req.method === 'GET' && p === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    // 管理台：纯静态资源（ui/ 目录，无构建、无外链）。只有 GET，只从固定白名单取文件，
    // 不做目录穿越；文件缺失或读失败一律 404/500，不让异常冒到顶层吞掉响应。
    if (req.method === 'GET' && (p === '/ui' || p === '/ui/' || p.startsWith('/ui/'))) {
      const asset = UI_ASSETS[p === '/ui' || p === '/ui/' ? 'index.html' : p.slice('/ui/'.length)];
      if (!asset) return json(res, 404, { error: { message: `no ui asset: ${p}`, type: 'invalid_request_error' } });
      let body;
      try {
        body = await fs.promises.readFile(path.join(UI_DIR, asset));
      } catch (error) {
        logger.error?.(`[server] 读取管理台资源失败 ${asset}：${error.message}`);
        return json(res, 500, openAIError(500, `管理台资源读取失败：${error.message}`, 'internal_error'));
      }
      res.writeHead(200, {
        'Content-Type': asset.endsWith('.css') ? 'text/css; charset=utf-8' : asset.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
        'Content-Length': body.length,
        // 本地管理台：禁用缓存，改完刷新就见效（避免调样式时被 304 骗到）
        'Cache-Control': 'no-store',
      });
      return res.end(body);
    }

    return json(res, 404, {
      error: {
        message: 'no route',
        type: 'invalid_request_error',
        root: '/',
        endpoints: [
          'GET /',
          'GET /ui',
          'POST /v1/chat/completions',
          'GET /v1/models',
          'GET /v1/models/{id}',
          'GET /__wb2api',
          'GET /__wb2api/accounts',
          'POST /__wb2api/accounts/switch',
        ],
      },
    });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      logger.error?.(`[server] 未捕获错误：${error.stack || error.message}`);
      if (!res.headersSent) json(res, 500, openAIError(500, error.message, 'internal_error'));
      else res.end();
    });
  });

  return { server, creds, getModels, cfg };
}
