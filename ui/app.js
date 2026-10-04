/* wb2api 管理台前端：零框架、零依赖、零外链。
 *
 * 设计约束（照抄任务要求，改代码前先读一遍）：
 *   1. 服务只在回环地址监听、**没有鉴权** —— 所以这里不发明任何密钥/登录机制，
 *      只做「危险操作二次确认」这类防误触，不假装有安全边界。
 *   2. 所有网络失败必须有可见反馈（banner / toast），不允许静默失败。
 *   3. 渲染一律走 DOM API + textContent，不拼 innerHTML，避免把上游返回的
 *      模型名/错误信息当 HTML 执行。
 */
'use strict';

/* ---------------------------------------------------------------- 小工具 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** 建 DOM：h('div', {class:'x', onclick:fn}, '文本', 子节点) */
function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

/** 清空并重新填充。 */
function fill(host, ...kids) {
  if (!host) return;
  host.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
}

const pad = (n) => String(n).padStart(2, '0');

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 相对剩余时长（中文）。 */
function humanLeft(iso) {
  if (!iso) return { text: '—', state: 'none' };
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return { text: String(iso), state: 'none' };
  let ms = t - Date.now();
  const past = ms < 0;
  ms = Math.abs(ms);
  const d = Math.floor(ms / 86400000);
  const hr = Math.floor((ms % 86400000) / 3600000);
  const mi = Math.floor((ms % 3600000) / 60000);
  let core;
  if (d) core = `${d} 天 ${hr} 小时`;
  else if (hr) core = `${hr} 小时 ${mi} 分`;
  else core = `${mi} 分`;
  return { text: past ? `已过期 ${core}` : `剩余 ${core}`, state: past ? 'bad' : d >= 1 ? 'ok' : hr >= 1 ? 'warn' : 'bad' };
}

/** 千分位；null 显示占位符。 */
function fmtNum(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('en-US') : '—';
}

function fmtBytes(n) {
  if (typeof n !== 'number') return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** Windows 路径取文件名（两种分隔符都认）。 */
function baseName(p) {
  return String(p ?? '').split(/[\\/]/).pop() || '';
}

/* ---------------------------------------------------------------- 状态 */

const THEME_KEY = 'wb2api.ui.theme';

const state = {
  info: null,          // GET /__wb2api
  models: null,        // GET /v1/models 的 data
  accounts: null,      // GET /__wb2api/accounts 的 accounts
  accountsMeta: null,  // 同上的 dir / current / configFile / override
  accountsAt: 0,
  accountsErr: null,
  infoAt: 0,
  modelsAt: 0,
  infoErr: null,
  modelsErr: null,
  loading: false,
  filter: { q: '', src: '', img: false, tool: false },
  sort: { key: 'id', dir: 'asc' },
  expanded: new Set(),
  log: [],
};

// GET 自检时服务端错误信息的正常形态（服务不在跑 / 网络断了），不该弹「失败」吐司
const ERR_RE = /^GET \/__wb2api 失败：/;

/* ---------------------------------------------------------------- 网络 */
/* 所有请求都相对当前源 —— 界面本身就是本服务的静态资源，不需要可配置的后端地址。 */

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function api(method, path, { timeoutMs = 60000, body } = {}) {
  const init = { method, headers: {}, cache: 'no-store' };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (timeoutMs) init.signal = AbortSignal.timeout(timeoutMs);

  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    // 网络层失败（服务没在跑 / 超时 / 连接被掐）—— 这里最容易「静默」，必须报出来
    const why = e.name === 'TimeoutError' ? `请求超时（${timeoutMs / 1000}s）` : e.message;
    throw new ApiError(`${method} ${path} 失败：${why}`, 0, null);
  }

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON（例如上游 502 的 HTML）—— 下面按原文报错 */
  }

  if (!res.ok) {
    const msg =
      json?.error?.message ||      // OpenAI 形状
      json?.error ||               // 本服务 creds/refresh 的 {ok:false,error}
      (text ? text.slice(0, 300) : '') ||
      `HTTP ${res.status}`;
    throw new ApiError(String(msg), res.status, json);
  }
  return { json, text, res };
}

/* ---------------------------------------------------------------- 主题 */

function applyTheme(t) {
  if (t) document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
}

function initTheme() {
  let saved = '';
  try {
    saved = localStorage.getItem(THEME_KEY) || '';
  } catch {}
  applyTheme(saved);
  const btn = $('#btn-theme');
  const label = () => {
    const cur = document.documentElement.getAttribute('data-theme')
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark(系统)' : 'light(系统)');
    btn.title = `主题：${cur} —— 点击切换（跟随系统 → 浅色 → 深色）`;
  };
  label();
  btn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || '';
    const next = cur === '' ? 'light' : cur === 'light' ? 'dark' : '';
    try {
      if (next) localStorage.setItem(THEME_KEY, next);
      else localStorage.removeItem(THEME_KEY);
    } catch {}
    applyTheme(next);
    label();
    toast('ok', '主题已切换', next === '' ? '跟随系统' : next === 'light' ? '浅色' : '深色');
  });
}

/* ---------------------------------------------------------------- 吐司 / 横幅 */

function toast(kind, title, detail = '') {
  const box = $('#toast');
  const it = h('div', { class: `it ${kind}` },
    h('span', { class: 'th', text: title }),
    detail ? h('span', { class: 'dim small', text: detail }) : null);
  box.append(it);
  setTimeout(() => it.remove(), kind === 'bad' ? 9000 : 4500);
  while (box.children.length > 4) box.firstElementChild.remove();
}

/** 顶部横幅：错误一律可见，且带「关闭」。 */
function banner(kind, title, detail, onRetry = null) {
  const box = $('#banners');
  const node = h('div', { class: `banner ${kind}` },
    h('span', { text: kind === 'bad' ? '⛔' : kind === 'warn' ? '⚠️' : 'ℹ️' }),
    h('div', {},
      h('b', { text: title }),
      detail ? h('div', { class: 'bd small', text: detail }) : null),
    onRetry ? h('button', { class: 'bt-close', title: '重试', onclick: () => { node.remove(); onRetry(); } }, '重试') : null,
    h('button', { class: 'bt-close', title: '关闭', onclick: () => node.remove() }, '✕'));
  box.append(node);
  while (box.children.length > 3) box.firstElementChild.remove();
  return node;
}

/** 只保留一条同类横幅（例如每次都重建自检错误提示）。 */
const sectionBanner = new Map();
function setSectionBanner(key, node) {
  const old = sectionBanner.get(key);
  if (old) old.remove();
  if (node) sectionBanner.set(key, node);
  else sectionBanner.delete(key);
}

/* ---------------------------------------------------------------- 二次确认对话框 */

function confirmDialog({ title, text, lines = [], confirmLabel = '确认执行', requireCheck = true, danger = true }) {
  return new Promise((resolve) => {
    const overlay = $('#confirm');
    const chk = $('#cf-check');
    const okBtn = $('#cf-ok');
    const tip = $('#cf-tip');

    $('#cf-title').textContent = title;
    $('#cf-text').textContent = text;
    fill($('#cf-extra'), lines.length ? h('ul', { class: 'small dim' }, lines.map((l) => h('li', { text: l }))) : null);
    $('#cf-checkline').classList.toggle('hidden', !requireCheck);
    chk.checked = false;
    okBtn.textContent = confirmLabel;
    okBtn.className = danger ? 'danger' : 'primary';
    okBtn.disabled = requireCheck;
    tip.textContent = requireCheck ? '勾选后才能执行' : '';

    const done = (val) => {
      overlay.classList.add('hidden');
      document.removeEventListener('keydown', onKey);
      chk.removeEventListener('change', onChk);
      okBtn.removeEventListener('click', onOk);
      $('#cf-cancel').removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      resolve(val);
    };
    const onChk = () => { okBtn.disabled = requireCheck && !chk.checked; };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onBackdrop = (e) => { if (e.target === overlay) done(false); };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };

    chk.addEventListener('change', onChk);
    okBtn.addEventListener('click', onOk);
    $('#cf-cancel').addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);

    overlay.classList.remove('hidden');
    (requireCheck ? chk : okBtn).focus();
  });
}

/* ---------------------------------------------------------------- 操作日志 */

function logAction(action, ok, detail) {
  state.log.unshift({ at: new Date(), action, ok, detail: String(detail ?? '') });
  if (state.log.length > 40) state.log.length = 40;
  renderLog();
}

function renderLog() {
  const tb = $('#d-log');
  if (!tb) return;
  if (!state.log.length) {
    fill(tb, h('tr', {}, h('td', { colspan: '4', class: 'dim', text: '还没有操作记录' })));
    return;
  }
  fill(tb, state.log.map((r) => h('tr', {},
    h('td', { class: 'mono small', text: `${pad(r.at.getHours())}:${pad(r.at.getMinutes())}:${pad(r.at.getSeconds())}` }),
    h('td', { text: r.action }),
    h('td', {}, h('span', { class: `badge ${r.ok ? 'on' : 'off'}`, text: r.ok ? '成功' : '失败' })),
    h('td', { class: 'small dim', text: r.detail || '—' }))));
}

/* ---------------------------------------------------------------- 按钮忙碌态 */

async function withBusy(btn, fn) {
  if (btn.dataset.busy === '1') return;
  btn.dataset.busy = '1';
  btn.disabled = true;
  btn.classList.add('busy');
  try {
    return await fn();
  } finally {
    btn.dataset.busy = '';
    btn.disabled = false;
    btn.classList.remove('busy');
  }
}

/* ---------------------------------------------------------------- 数据加载 */

async function loadInfo() {
  try {
    const { json } = await api('GET', '/__wb2api', { timeoutMs: 30000 });
    state.info = json;
    state.infoErr = null;
    state.infoAt = Date.now();
  } catch (e) {
    state.infoErr = e;
    state.info = null;
  }
  renderOverview();
  renderCreds();
  renderSelfCheck();
  renderAccounts();
  renderChrome();
}

async function loadAccounts() {
  try {
    const { json } = await api('GET', '/__wb2api/accounts', { timeoutMs: 60000 });
    state.accounts = Array.isArray(json?.accounts) ? json.accounts : [];
    state.accountsMeta = { dir: json?.dir ?? '', current: json?.current ?? '', configFile: json?.configFile ?? '', override: json?.override ?? null };
    state.accountsErr = null;
    state.accountsAt = Date.now();
  } catch (e) {
    state.accountsErr = e;
    state.accounts = null;
    state.accountsMeta = null;
  }
  renderAccounts();
}

async function loadModels({ force = false } = {}) {
  try {
    const { json } = await api('GET', force ? '/v1/models?refresh=1' : '/v1/models', { timeoutMs: 90000 });
    state.models = Array.isArray(json?.data) ? json.data : [];
    state.modelsErr = null;
    state.modelsAt = Date.now();
  } catch (e) {
    state.modelsErr = e;
    state.models = null;
  }
  renderModels();
  renderOverview();
  renderCreds(); // 凭证页也显示「可用模型 N 个」，两条加载线是并行的，模型晚到要补渲染
}

async function loadAll({ force = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  $('#btn-refresh').classList.add('busy');
  try {
    await Promise.allSettled([loadInfo(), loadModels({ force }), loadAccounts()]);
    $('#last-updated').textContent = `更新于 ${fmtTime(new Date().toISOString())}`;
  } finally {
    state.loading = false;
    $('#btn-refresh').classList.remove('busy');
  }
}

/* ---------------------------------------------------------------- 渲染：外壳 */

function renderChrome() {
  const info = state.info;
  const ok = !!info && !info.login?.error;
  const dot = $('#svc-dot');
  dot.className = `dot ${state.infoErr ? 'off' : ok ? '' : 'warn'}`;
  $('#svc-text').textContent = state.infoErr ? '服务不可达' : ok ? '凭证可用' : '凭证不可用';
  $('#brand-ver').textContent = info?.version || (state.infoErr ? '?' : '—');
  $('#svc-pill').title = state.infoErr ? state.infoErr.message : `服务在线 · ${info?.endpoint || ''}`;

  // 全局服务不可达提示
  if (state.infoErr) {
    const node = h('div', { class: 'banner bad' },
      h('span', { text: '⛔' }),
      h('div', {},
        h('b', { text: '服务不可达' }),
        h('div', { class: 'bd small', text: `${state.infoErr.message}。若服务已停止，请在项目目录执行 npm start 后重试。` })),
      h('button', { class: 'bt-close', title: '重试', onclick: () => { node.remove(); setSectionBanner('down', null); loadAll(); } }, '重试'),
      h('button', { class: 'bt-close', title: '关闭', onclick: () => { node.remove(); setSectionBanner('down', null); } }, '✕'));
    if (!sectionBanner.get('down')) {
      $('#banners').prepend(node);
      sectionBanner.set('down', node);
    }
  } else {
    setSectionBanner('down', null);
  }
  $$('#banners .banner').forEach((n) => {
    if (n !== sectionBanner.get('down') && n.textContent.includes('服务不可达') && !state.infoErr) n.remove();
  });
}

/* ---------------------------------------------------------------- 渲染：总览 */

const ENDPOINTS = [
  ['GET', '/', '浏览器状态页（脚本访问或 ?format=json 时给 JSON）'],
  ['GET', '/health', '自检 JSON 别名，便于探活'],
  ['GET', '/ui', '本管理台（纯静态，无构建、无外链）'],
  ['POST', '/v1/chat/completions', '对话 / 工具调用；stream 真/假都支持'],
  ['POST', '/route/chat/completions', '同上（旧路径别名）'],
  ['GET', '/v1/models', '模型目录（缓存 5 分钟；带 ?refresh 强制重拉）'],
  ['GET', '/v1/models/{id}', '单个模型；不存在时 404'],
  ['GET', '/__wb2api', '自检 JSON：凭证来源 / 到期 / uid / 模型清单'],
  ['GET', '/__wb2api/accounts', '本机所有账号（会话文件）及各自状态；不含 token'],
  ['POST', '/__wb2api/accounts/switch', '切换当前账号（body {"file":"<绝对路径>"}，需在枚举结果内）'],
  ['POST', '/__wb2api/creds/refresh', '重新解凭证（?mode=token 走换票续期）'],
  ['POST', '/__wb2api/shutdown', '让服务退出（仅本机，拒绝带 Origin 的请求）'],
];

function renderOverview() {
  const info = state.info;
  const login = info?.login || {};

  // KPI 1：凭证
  let stateText = '—', subText = '—', ic = '♥';
  if (state.infoErr) { stateText = '不可达'; subText = '服务没在跑？'; ic = '⛔'; }
  else if (login.error) { stateText = '不可用'; subText = String(login.error).slice(0, 90); ic = '⚠️'; }
  else if (info) { stateText = '可用'; subText = `来源 ${login.source || '—'}`; ic = '✅'; }
  $('#ov-state').textContent = stateText;
  $('#ov-state').className = `k-val ${state.infoErr || login.error ? 'bad' : 'ok'}`;
  $('#ov-state-sub').textContent = subText;
  $('#ov-ic').textContent = ic;

  // KPI 2：模型
  const models = state.models;
  $('#ov-models').textContent = models ? String(models.length) : state.modelsErr ? '—' : '…';
  $('#ov-models').className = `k-val ${state.modelsErr ? 'bad' : ''}`;
  $('#ov-models-sub').textContent = models ? distText(models) : state.modelsErr ? '读取失败，见下方提示' : '加载中…';

  // KPI 3：版本
  $('#ov-ver').textContent = info?.version ?? (state.infoErr ? '—' : '…');
  $('#ov-ver-sub').textContent = info ? 'wb2api' : '—';

  // KPI 4：token 剩余
  const left = humanLeft(login.expiresAt);
  $('#ov-ttl').textContent = login.expiresAt ? left.text.replace(/^剩余 /, '') : '—';
  $('#ov-ttl').className = `k-val ${left.state === 'bad' ? 'bad' : left.state === 'warn' ? 'warn' : ''}`;
  $('#ov-ttl-sub').textContent = login.expiresAt ? `到期 ${fmtTime(login.expiresAt)}` : '—';

  // 账号与凭证
  fill($('#ov-creds'),
    ...(login.error
      ? [h('div', { text: '凭证状态' }), h('div', { class: 'bad', text: `不可用：${login.error}` })]
      : [
          h('div', { text: '账号 uid' }), h('div', { class: 'mono', text: login.uid ?? '—' }),
          h('div', { text: 'uin' }), h('div', { class: 'mono', text: login.uin ?? '—' }),
          h('div', { text: '域' }), h('div', { class: 'mono', text: login.domain || '—' }),
          h('div', { text: '凭证来源' }), h('div', {}, h('code', { text: login.source ?? '—' })),
          h('div', { text: 'access 到期' }), h('div', { class: 'mono', text: `${fmtTime(login.expiresAt)}（${left.text}）` }),
          h('div', { text: 'refresh 到期' }), h('div', { class: 'mono', text: fmtTime(login.refreshExpiresAt) }),
        ]),
    ...(state.infoErr ? [h('div', { text: '错误' }), h('div', { class: 'bad', text: state.infoErr.message })] : []));

  // 上游与服务
  fill($('#ov-svc'),
    h('div', { text: '上游网关' }), h('div', { class: 'mono', text: info?.endpoint ?? '—' }),
    h('div', { text: '服务版本' }), h('div', { class: 'mono', text: info?.version ?? '—' }),
    h('div', { text: '当前页面' }), h('div', { class: 'mono', text: location.origin + '/ui' }),
    h('div', { text: 'OpenAI base_url' }), h('div', { class: 'mono', text: `${location.origin}/v1` }),
    h('div', { text: '鉴权' }), h('div', { text: '无（仅监听回环地址，api_key 随便填）' }),
    h('div', { text: '模型缓存' }), h('div', { text: '5 分钟；「强制重拉目录」可立即刷新' }));

  // 接法示例
  $('#ov-snippet').textContent =
`from openai import OpenAI

client = OpenAI(base_url="${location.origin}/v1", api_key="wb2api")  # key 会被忽略

# 非流式
resp = client.chat.completions.create(model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "你好"}], max_tokens=512)
print(resp.choices[0].message.content)

# 流式
for ev in client.chat.completions.create(model="deepseek-v4-flash",
        messages=[{"role": "user", "content": "数到三"}], stream=True):
    print(ev.choices[0].delta.content or "", end="")`;

  // 端点速查
  fill($('#ov-endpoints'), ENDPOINTS.map(([m, p, d]) => h('tr', {},
    h('td', {}, h('code', { text: m })),
    h('td', { class: 'mono' }, h('code', { text: p })),
    h('td', { class: 'dim', text: d }))));

  // 来源分布
  const dist = $('#ov-dist');
  if (!models) {
    fill(dist, h('span', { class: 'dim', text: state.modelsErr ? `读取失败：${state.modelsErr.message}` : '加载中…' }));
  } else {
    const by = new Map();
    for (const m of models) by.set(m.catalog || '(未标)', (by.get(m.catalog || '(未标)') || 0) + 1);
    fill(dist, h('div', { class: 'grid g3' }, [...by.entries()].sort((a, b) => b[1] - a[1]).map(([cat, n]) =>
      h('div', { class: 'mini' },
        h('div', { class: 'm-l' }, h('span', { class: `badge ${cat}`, text: cat })),
        h('div', { class: 'm-v' }, h('b', { text: String(n) }), h('span', { class: 'dim small', text: ` 个 / 共 ${models.length}` }))))));
  }
}

function distText(models) {
  const by = new Map();
  for (const m of models) by.set(m.catalog || '?', (by.get(m.catalog || '?') || 0) + 1);
  return [...by.entries()].map(([k, v]) => `${k} ${v}`).join(' · ') || '0 个';
}

/* ---------------------------------------------------------------- 渲染：模型 */

function modelRows() {
  const all = state.models || [];
  const { q, src, img, tool } = state.filter;
  const needle = q.trim().toLowerCase();
  let rows = all.filter((m) => {
    if (src && (m.catalog || '') !== src) return false;
    if (img && !m.supports_images) return false;
    if (tool && !m.supports_tools) return false;
    if (!needle) return true;
    return [m.id, m.name, m.owned_by, m.catalog].some((v) => String(v ?? '').toLowerCase().includes(needle));
  });
  const { key, dir } = state.sort;
  const mul = dir === 'asc' ? 1 : -1;
  rows = rows.slice().sort((a, b) => {
    const va = a[key], vb = b[key];
    // null/undefined 永远排在后面，避免 «—» 混在数字中间
    const na = va === null || va === undefined, nb = vb === null || vb === undefined;
    if (na && nb) return String(a.id).localeCompare(String(b.id));
    if (na) return 1;
    if (nb) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mul;
    return String(va).localeCompare(String(vb), 'zh-Hans-CN') * mul;
  });
  return { rows, total: all.length };
}

function capBadges(m) {
  const defs = [['图片', m.supports_images], ['工具', m.supports_tools], ['推理', m.supports_reasoning]];
  return h('td', { class: 'cap' },
    defs.map(([label, on]) => h('span', { class: `badge ${on ? 'on' : 'off'}`, text: `${on ? '✓' : '✕'} ${label}` })),
    m.is_default ? h('span', { class: 'badge on', text: '默认' }) : null);
}

function renderModels() {
  const tb = $('#m-tbody');
  const stat = $('#m-stat');

  if (state.modelsErr && !state.models) {
    fill(stat, h('span', { class: 'bad', text: `读取 /v1/models 失败：${state.modelsErr.message}` }));
    fill(tb, h('tr', {}, h('td', { colspan: '8' },
      h('div', { class: 'banner bad', style: 'margin:0' },
        h('span', { text: '⛔' }),
        h('div', {},
          h('b', { text: '模型目录不可用' }),
          h('div', { class: 'bd small', text: state.modelsErr.message })),
        h('button', { class: 'bt-close', onclick: () => loadModels() }, '重试')))));
    return;
  }

  const { rows, total } = modelRows();
  const statParts = [];
  if (state.models) {
    statParts.push(`显示 ${rows.length} / 共 ${total} 个`);
    const by = new Map();
    for (const m of rows) by.set(m.catalog || '?', (by.get(m.catalog || '?') || 0) + 1);
    if (by.size) statParts.push(`（当前筛选：${[...by.entries()].map(([k, v]) => `${k} ${v}`).join(' · ')}）`);
    statParts.push(`· 更新于 ${fmtTime(new Date(state.modelsAt).toISOString())}`);
  } else statParts.push('加载中…');
  fill(stat, h('span', { text: statParts.join(' ') }));

  if (!rows.length) {
    fill(tb, h('tr', {}, h('td', { colspan: '8', class: 'dim', text: total ? '没有符合条件的模型，试试清空筛选' : '目录为空' })));
    return;
  }

  const out = [];
  for (const m of rows) {
    const ctxTitle = [
      m.context_default !== null && m.context_default !== undefined ? `默认档位 ${fmtNum(m.context_default)}` : null,
      Array.isArray(m.context_supported) && m.context_supported.length ? `可选档位 ${m.context_supported.map(fmtNum).join(' / ')}` : null,
    ].filter(Boolean).join('；');

    out.push(h('tr', {},
      h('td', { class: 'cell-id', text: m.id }),
      h('td', { text: m.name ?? '—' }),
      h('td', {}, h('span', { class: `badge ${m.catalog || ''}`, text: m.catalog || '—' }), m.extra ? h('span', { class: 'badge probe', text: ' extra' }) : null),
      h('td', { class: 'num', title: ctxTitle || '' }, fmtNum(m.context_length)),
      h('td', { class: 'num' }, fmtNum(m.max_output_tokens)),
      capBadges(m),
      h('td', { class: 'mono small', text: m.owned_by ?? '—' }),
      h('td', {}, h('button', {
        class: 'ghost', style: 'padding:2px 8px;font-size:12px',
        onclick: () => {
          if (state.expanded.has(m.id)) state.expanded.delete(m.id);
          else state.expanded.add(m.id);
          renderModels();
        },
      }, state.expanded.has(m.id) ? '收起' : '详情'))));

    if (state.expanded.has(m.id)) {
      out.push(h('tr', {}, h('td', { colspan: '8', style: 'background:var(--card-2)' },
        h('div', { class: 'small dim', style: 'margin-bottom:6px' },
          'GET ', h('code', { text: `/v1/models/${m.id}` }),
          m.context_default !== null && m.context_default !== undefined ? ` · 默认档位 ${fmtNum(m.context_default)}` : '',
          Array.isArray(m.context_supported) && m.context_supported.length ? ` · 可选档位 ${m.context_supported.map(fmtNum).join(' / ')}` : ''),
        h('pre', { style: 'max-height:260px', text: JSON.stringify(m, null, 2) }))));
    }
  }
  fill(tb, out);
}

/* ---------------------------------------------------------------- 渲染：账号 */

function renderAccounts() {
  const tb = $('#acc-tbody');
  const stat = $('#acc-stat');
  const curHost = $('#acc-current');
  if (!tb) return;

  if (state.accountsErr) {
    fill(curHost, h('div', { text: '状态' }), h('div', { class: 'bad', text: `枚举失败：${state.accountsErr.message}` }));
    fill(stat, h('span', { class: 'bad', text: `GET /__wb2api/accounts 失败：${state.accountsErr.message}` }));
    fill(tb, h('tr', {}, h('td', { colspan: '9' },
      h('div', { class: 'banner bad', style: 'margin:0' },
        h('span', { text: '⛔' }),
        h('div', {},
          h('b', { text: '账号列表不可用' }),
          h('div', { class: 'bd small', text: state.accountsErr.message })),
        h('button', { class: 'bt-close', onclick: () => loadAccounts() }, '重试')))));
    return;
  }
  if (!state.accounts) {
    fill(curHost, h('span', { class: 'dim', text: '加载中…' }));
    fill(stat, h('span', { class: 'dim', text: '加载中…' }));
    return;
  }
  if (!state.accounts.length) {
    fill(curHost, h('div', { text: '状态' }), h('div', { class: 'warn', text: '没有找到任何 .info 会话文件' }));
    fill(stat, h('span', { class: 'dim', text: `目录 ${state.accountsMeta?.dir || '—'} 下没有账号文件` }));
    fill(tb, h('tr', {}, h('td', { colspan: '9', class: 'dim', text: '目录里没有 .info 文件；先在 WorkBuddy 里登录一次' })));
    return;
  }

  const meta = state.accountsMeta || {};
  const cur = state.accounts.find((a) => a.isCurrent);
  fill(curHost,
    h('div', { text: '当前账号（服务在用）' }),
    h('div', {},
      h('span', { class: 'mono', text: cur ? baseName(cur.file) : (meta.current ? baseName(meta.current) : '—') }),
      cur?.uid ? h('span', { class: 'dim small', text: ` · uid ${cur.uid}` }) : null),
    h('div', { text: 'uid / uin' }), h('div', { class: 'mono', text: cur ? `${cur.uid || '—'} / ${cur.uin || '—'}` : '—' }),
    h('div', { text: 'access 到期' }),
    h('div', { class: 'mono', text: cur?.expiresAt ? `${fmtTime(cur.expiresAt)}（${humanLeft(cur.expiresAt).text}）` : '—' }),
    h('div', { text: '枚举目录' }), h('div', { class: 'mono small', text: meta.dir || '—' }),
    h('div', { text: '选择来源' }),
    h('div', {},
      meta.override
        ? h('span', {}, h('span', { class: 'badge on', text: '运行时覆盖' }), h('span', { class: 'dim small', text: ` data/active-account.json → ${baseName(meta.override)}` }))
        : h('span', {}, h('span', { class: 'badge', text: '配置 / 自动发现' }),
            h('span', { class: 'dim small', text: meta.configFile ? ` credentials.authFile = ${baseName(meta.configFile)}` : ' credentials.authFile 为空，按「非备份优先 → mtime 最新」自动选' }))),
    h('div', { text: '服务端凭证' }),
    h('div', { class: 'mono small', text: state.info?.login?.source ? `${state.info.login.source} · ${state.info.login.uid || '—'}` : (state.info?.login?.error ? `不可用：${state.info.login.error}` : '—') }));

  const okCount = state.accounts.filter((a) => !a.error).length;
  const validCount = state.accounts.filter((a) => a.tokenValid).length;
  fill(stat, h('span', {}, `共 ${state.accounts.length} 个文件（${okCount} 个解开、${state.accounts.length - okCount} 个失败）· access token 仍有效的 ${validCount} 个 · 更新于 ${fmtTime(new Date(state.accountsAt).toISOString())}`));

  fill(tb, state.accounts.map((a) => {
    const left = humanLeft(a.expiresAt);
    const rleft = humanLeft(a.refreshExpiresAt);
    const disabled = !!a.error || a.isCurrent;
    const btn = h('button', {
      class: 'ghost', style: 'padding:2px 8px;font-size:12px',
      disabled,
      title: a.error ? '该文件解不开，无法作为切换目标' : a.isCurrent ? '已经是当前账号' : '切换到此账号（会立刻重新解析凭证）',
      onclick: (e) => switchAccount(a, e.currentTarget),
    }, a.error ? '不可用' : a.isCurrent ? '当前' : '切换到此账号');

    return h('tr', { class: a.isCurrent ? 'row-current' : '' },
      h('td', {}, a.isCurrent ? h('span', { class: 'badge on', text: '● 当前' }) : h('span', { class: 'dim', text: '—' })),
      h('td', { class: 'cell-file' },
        h('div', { class: 'mono small', text: a.name }),
        h('div', { class: 'dim small' },
          a.isBackup ? h('span', { class: 'badge', text: '备份' }) : h('span', { class: 'badge on', text: '非备份' }),
          ` ${fmtBytes(a.size)} · mtime ${fmtTime(a.mtime)}`)),
      h('td', { class: 'mono small', text: a.uid || '—' }),
      h('td', { class: 'mono small', text: a.uin || '—' }),
      h('td', { text: a.nickname || '—' }),
      h('td', { class: 'mono small', text: a.domain || '—' }),
      h('td', { class: 'mono small' }, a.expiresAt ? `${fmtTime(a.expiresAt)}` : '—', h('div', { class: `small ${left.state === 'bad' ? 'bad' : 'dim'}`, text: left.text })),
      h('td', { class: 'mono small' }, a.refreshExpiresAt ? `${fmtTime(a.refreshExpiresAt)}` : '—', h('div', { class: 'dim small', text: rleft.text })),
      h('td', {}, a.error
        ? h('span', { class: 'badge off', title: a.error }, '解密失败')
        : h('span', { class: `badge ${a.tokenValid ? 'on' : 'off'}`, text: a.tokenValid ? '✓ token 有效' : '✕ token 已过期' }),
        a.error ? h('div', { class: 'bad small', title: a.error, text: String(a.error).slice(0, 60) }) : null),
      h('td', {}, btn));
  }));
}

async function switchAccount(a, btn) {
  const left = humanLeft(a.expiresAt);
  const ok = await confirmDialog({
    title: '切换到这个账号？',
    text: `服务将改用「${a.name}」里的会话凭证，并立刻重新解密一次。`,
    lines: [
      `uid ${a.uid || '—'} · uin ${a.uin || '—'}${a.nickname ? ` · ${a.nickname}` : ''}`,
      `access token 到期 ${fmtTime(a.expiresAt)}（${left.text}）`,
      a.isBackup ? '⚠️ 这是桌面端 clean() 留下的历史备份，凭证可能已经过期。' : '这是桌面端当前登录的账号文件。',
      '只写 data/active-account.json（运行时覆盖），不改 config.yaml；',
      '切换后下一次请求即用新账号，不需要重启服务；模型目录缓存会被作废并重拉。',
    ],
    confirmLabel: '确认切换',
    requireCheck: true,
    danger: false,
  });
  if (!ok) return;

  await withBusy(btn, async () => {
    try {
      const { json } = await api('POST', '/__wb2api/accounts/switch', { body: { file: a.file }, timeoutMs: 60000 });
      const detail = `uid=${json.uid} · uin=${json.uin} · source=${json.source} · 到期 ${fmtTime(json.expiresAt)}`;
      toast('ok', '已切换账号（立即生效）', detail);
      logAction('切换账号', true, `${a.name} · ${detail}`);
    } catch (e) {
      toast('bad', '切换账号失败', e.message);
      logAction('切换账号', false, `${a.name} · ${e.message}`);
      banner('bad', '切换账号失败', e.message);
    }
    // 服务端凭证与模型目录都变了，整页重拉
    await loadAll();
    await loadModels({ force: true });
  });
}

/* ---------------------------------------------------------------- 渲染：凭证 */

function renderCreds() {
  const info = state.info;
  const login = info?.login || {};
  const host = $('#c-detail');

  if (state.infoErr) {
    fill(host, h('div', { text: '状态' }), h('div', { class: 'bad', text: `自检不可用：${state.infoErr.message}` }));
  } else if (login.error) {
    fill(host,
      h('div', { text: '状态' }), h('div', { class: 'bad', text: '凭证不可用' }),
      h('div', { text: '错误' }), h('div', { class: 'bad', text: String(login.error) }),
      h('div', { text: '建议' }), h('div', { text: '先确认 WorkBuddy 已登录过一次，再点「重新解凭证」；仍失败请看服务日志 logs/server-stdout.log' }));
  } else {
    fill(host,
      h('div', { text: '账号 uid' }), h('div', { class: 'mono', text: login.uid ?? '—' }),
      h('div', { text: 'uin' }), h('div', { class: 'mono', text: login.uin ?? '—' }),
      h('div', { text: '域' }), h('div', { class: 'mono', text: login.domain || '—' }),
      h('div', { text: '来源' }), h('div', {}, h('code', { text: login.source ?? '—' })),
      h('div', { text: 'access 到期' }), h('div', { class: 'mono', text: fmtTime(login.expiresAt) }),
      h('div', { text: 'refresh 到期' }), h('div', { class: 'mono', text: fmtTime(login.refreshExpiresAt) }),
      h('div', { text: '可用模型' }), h('div', { text: state.models ? `${state.models.length} 个` : '—' }));
  }

  $('#c-src').textContent = login.source ?? '—';
  $('#c-exp').textContent = login.expiresAt ? `${fmtTime(login.expiresAt)}（${humanLeft(login.expiresAt).text}）` : '—';
  $('#c-rexp').textContent = fmtTime(login.refreshExpiresAt);
}

/* ---------------------------------------------------------------- 渲染：自检 */

function renderSelfCheck() {
  const info = state.info;
  const kv = $('#sc-keyvals');
  const pre = $('#sc-json');

  if (state.infoErr) {
    fill(kv, h('div', { text: '状态' }), h('div', { class: 'bad', text: state.infoErr.message }));
    pre.textContent = state.infoErr.message;
    return;
  }
  if (!info) {
    fill(kv, h('span', { class: 'dim', text: '加载中…' }));
    pre.textContent = '加载中…';
    return;
  }
  const login = info.login || {};
  fill(kv,
    h('div', { text: 'service' }), h('div', { class: 'mono', text: info.service ?? '—' }),
    h('div', { text: 'version' }), h('div', { class: 'mono', text: info.version ?? '—' }),
    h('div', { text: 'endpoint' }), h('div', { class: 'mono', text: info.endpoint ?? '—' }),
    ...(login.error
      ? [h('div', { text: 'login.error' }), h('div', { class: 'bad', text: String(login.error) })]
      : [
          h('div', { text: 'login.uid' }), h('div', { class: 'mono', text: login.uid ?? '—' }),
          h('div', { text: 'login.uin' }), h('div', { class: 'mono', text: login.uin ?? '—' }),
          h('div', { text: 'login.domain' }), h('div', { class: 'mono', text: login.domain ?? '—' }),
          h('div', { text: 'login.source' }), h('div', { class: 'mono', text: login.source ?? '—' }),
          h('div', { text: 'login.expiresAt' }), h('div', { class: 'mono', text: fmtTime(login.expiresAt) }),
          h('div', { text: 'login.refreshExpiresAt' }), h('div', { class: 'mono', text: fmtTime(login.refreshExpiresAt) }),
        ]),
    h('div', { text: 'models' }), h('div', { class: 'mono', text: `${Array.isArray(info.models) ? info.models.length : 0} 个` }),
    h('div', { text: '原始 JSON 大小' }), h('div', { class: 'mono', text: fmtBytes(JSON.stringify(info).length) }));
  pre.textContent = JSON.stringify(info, null, 2);
}

/* ---------------------------------------------------------------- 动作：凭证 */

async function refreshCreds(mode, btn) {
  const label = mode === 'token' ? '换票续期' : '重新解凭证';
  const ok = await confirmDialog({
    title: `${label}？`,
    text: mode === 'token'
      ? '将用当前 refreshToken 向上游换一张新的 accessToken（refreshToken 会轮换）。'
      : '将从本机 WorkBuddy 加密会话文件重新解密一份凭证，需要本机装过并登录过 WorkBuddy。',
    lines: mode === 'token'
      ? ['上游会返回新的 accessToken / refreshToken；', '成功后服务会作废模型目录缓存，页面会自动重拉。']
      : ['会重新调用 WorkBuddy.exe 取静态密钥（可能耗时数秒）；', '成功后服务会作废模型目录缓存，页面会自动重拉。'],
    confirmLabel: label,
    danger: false,
  });
  if (!ok) return;

  await withBusy(btn, async () => {
    try {
      const { json } = await api('POST', `/__wb2api/creds/refresh${mode === 'token' ? '?mode=token' : ''}`, { timeoutMs: 120000 });
      const detail = `mode=${json.mode} · uid=${json.uid} · source=${json.source} · 到期 ${fmtTime(json.expiresAt)}`;
      toast('ok', `${label}成功`, detail);
      logAction(label, true, detail);
    } catch (e) {
      toast('bad', `${label}失败`, e.message);
      logAction(label, false, e.message);
      banner('bad', `${label}失败`, e.message);
    }
    await loadAll();
  });
}

/* ---------------------------------------------------------------- 动作：关闭服务 */

async function doShutdown(btn) {
  const ok = await confirmDialog({
    title: '关闭 wb2api 服务？',
    text: '服务会立即退出（process.exit(0)），正在进行的对话会被中断，且不会自动重启。',
    lines: [
      '重启方式：在项目目录执行 npm start；',
      '服务端只接受本机请求，且会拒绝带 Origin 头的浏览器请求；',
      '因此从本页面发起时，服务端通常会返回 403 origin not allowed —— 这是既有设计，不是页面故障。',
    ],
    confirmLabel: '确认关闭服务',
    requireCheck: true,
    danger: true,
  });
  if (!ok) return;

  await withBusy(btn, async () => {
    try {
      const { json } = await api('POST', '/__wb2api/shutdown', { timeoutMs: 10000 });
      toast('ok', '服务已接受关闭请求', json?.message || 'shutting down');
      logAction('关闭服务', true, json?.message || 'shutting down');
    } catch (e) {
      if (e.status === 403) {
        toast('bad', '服务端拒绝了关闭请求（403）', '浏览器请求带 Origin 头，服务端按设计拒绝。请用 npm run stop 或 npm start 重启。');
        logAction('关闭服务', false, `403 ${e.message} —— 服务端防 CSRF 设计，请用 npm run stop`);
      } else {
        toast('bad', '关闭服务失败', e.message);
        logAction('关闭服务', false, e.message);
      }
    }
    setTimeout(() => loadAll(), 800);
  });
}

/* ---------------------------------------------------------------- 复制 */

async function copyText(text, msgHost) {
  const say = (s) => { if (msgHost) { msgHost.textContent = s; setTimeout(() => { msgHost.textContent = ''; }, 2500); } };
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      say('已复制 ✓');
      return;
    }
    throw new Error('clipboard 不可用');
  } catch {
    // http:// 下（非 https/localhost 之外）clipboard API 可能不可用 → 退回 textarea
    try {
      const ta = h('textarea', { style: 'position:fixed;opacity:0;pointer-events:none' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      say(ok ? '已复制 ✓' : '复制失败，请手动选择');
    } catch (e) {
      say(`复制失败：${e.message}`);
    }
  }
}

/* ---------------------------------------------------------------- 路由 */

const TITLES = {};
$$('#nav a').forEach((a) => {
  a.addEventListener('click', () => closeNav());
});

function route() {
  const want = (location.hash || '#/overview').replace(/^#\//, '');
  const view = $(`#view-${want}`) ? want : 'overview';
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${view}`));
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  const sec = $(`#view-${view}`);
  $('#page-title').textContent = sec.dataset.title || 'wb2api';
  $('#page-sub').textContent = sec.dataset.sub || '';
  document.title = `${sec.dataset.title || 'wb2api'} · wb2api 管理台`;
}

/* ---------------------------------------------------------------- 窄屏抽屉 */

function openNav() {
  $('#side').classList.add('open');
  $('#scrim').hidden = false;
}
function closeNav() {
  $('#side').classList.remove('open');
  $('#scrim').hidden = true;
}

/* ---------------------------------------------------------------- 事件绑定 */

function bind() {
  $('#btn-refresh').addEventListener('click', () => loadAll());
  $('#btn-models-refresh').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    toast('ok', '正在强制重拉模型目录', '服务端会重新拉取上游 /v3/config 并重探兜底模型');
    await loadModels({ force: true });
    if (state.modelsErr) toast('bad', '强制重拉失败', state.modelsErr.message);
    else toast('ok', '目录已更新', `共 ${state.models?.length ?? 0} 个模型`);
  }));

  // 自动刷新
  let timer = null;
  $('#auto-refresh').addEventListener('change', (e) => {
    clearInterval(timer);
    timer = null;
    if (e.target.checked) {
      timer = setInterval(() => { if (!document.hidden) loadAll(); }, 30000);
      toast('ok', '已开启自动刷新', '每 30 秒刷新一次自检与模型目录（页面隐藏时暂停）');
    }
  });

  // 模型筛选
  let debounce = null;
  $('#m-q').addEventListener('input', (e) => {
    clearTimeout(debounce);
    const v = e.target.value;
    debounce = setTimeout(() => { state.filter.q = v; renderModels(); }, 120);
  });
  $('#m-src').addEventListener('change', (e) => { state.filter.src = e.target.value; renderModels(); });
  $('#m-only-img').addEventListener('change', (e) => { state.filter.img = e.target.checked; renderModels(); });
  $('#m-only-tool').addEventListener('change', (e) => { state.filter.tool = e.target.checked; renderModels(); });
  $('#m-clear').addEventListener('click', () => {
    state.filter = { q: '', src: '', img: false, tool: false };
    $('#m-q').value = ''; $('#m-src').value = '';
    $('#m-only-img').checked = false; $('#m-only-tool').checked = false;
    renderModels();
  });
  $$('#m-table th.sortable').forEach((th) => th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
    else { state.sort.key = key; state.sort.dir = 'asc'; }
    $$('#m-table th.sortable').forEach((x) => x.classList.remove('asc', 'desc'));
    th.classList.add(state.sort.dir);
    renderModels();
  }));

  // 账号
  $('#btn-acc-reload').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    await loadAccounts();
    const msg = $('#acc-msg');
    msg.textContent = state.accountsErr ? `失败：${state.accountsErr.message}` : `已重新枚举 ${state.accounts?.length ?? 0} 个文件`;
    setTimeout(() => { msg.textContent = ''; }, 4000);
    if (state.accountsErr) toast('bad', '重新枚举失败', state.accountsErr.message);
  }));
  $('#btn-acc-locate').addEventListener('click', () => copyText(state.accountsMeta?.dir || '', $('#acc-msg')));

  // 凭证：切换账号后服务端凭证变了，重新解一次并重画
  $('#btn-creds-file').addEventListener('click', (e) => refreshCreds('file', e.currentTarget));
  $('#btn-creds-token').addEventListener('click', (e) => refreshCreds('token', e.currentTarget));
  $('#btn-creds-reload').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    await loadAll();
    const down = !state.info && state.infoErr;
    if (down) toast('bad', '刷新失败：服务不可达', state.infoErr.message);
    else toast('ok', '已刷新凭证显示', state.info?.login?.source ? `来源 ${state.info.login.source}` : '');
  }));

  // 自检
  $('#btn-sc-reload').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    await loadInfo();
    const msg = $('#sc-msg');
    // 服务不可达本身就写在页面上（错误卡片里），这里不重复弹吐司
    const quiet = !state.info && ERR_RE.test(state.infoErr?.message || '');
    msg.textContent = state.infoErr ? `失败：${state.infoErr.message}` : `已更新 ${fmtTime(new Date(state.infoAt).toISOString())}`;
    setTimeout(() => { msg.textContent = ''; }, 4000);
    if (state.infoErr && !quiet) toast('bad', '自检失败', state.infoErr.message);
  }));
  $('#btn-sc-copy').addEventListener('click', () => copyText(JSON.stringify(state.info ?? {}, null, 2), $('#sc-msg')));

  // 总览里的复制
  $('#btn-copy-base').addEventListener('click', () => copyText(`${location.origin}/v1`, $('#copy-msg')));
  $('#btn-copy-snippet').addEventListener('click', () => copyText($('#ov-snippet').textContent, $('#copy-msg')));

  // 危险操作
  $('#btn-shutdown').addEventListener('click', (e) => doShutdown(e.currentTarget));

  // 抽屉
  $('#btn-open-nav').addEventListener('click', openNav);
  $('#btn-close-nav').addEventListener('click', closeNav);
  $('#scrim').addEventListener('click', closeNav);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNav(); });

  window.addEventListener('hashchange', route);
  window.addEventListener('online', () => loadAll());
}

/* ---------------------------------------------------------------- 启动 */

function start() {
  initTheme();
  bind();
  route();
  renderLog();
  renderChrome();
  loadAll();
}

start();
