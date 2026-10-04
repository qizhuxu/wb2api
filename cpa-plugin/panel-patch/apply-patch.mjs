#!/usr/bin/env node
/**
 * 把 workbuddy-quota-patch.html 注入 CPA 官方面板 static/management.html。
 *
 * 为什么要有这个脚本（而不是手写一段 python 注入）：
 *   手写注入没有任何校验。姊妹项目 mimo 补丁的 v7.4.1 把版本标记写成
 *   `window.__mimoQuotaPatch=7.4.1`——`7.4.1` 不是合法数字字面量，整个
 *   <script> 解析失败，补丁一行都没跑：卡片消失、刷新按钮消失，页面上只留
 *   一句控制台错误。这里在写盘**之前**用 node:vm 解析补丁的内联脚本
 *   （只解析、不执行），语法错就直接中止、原文件不动。
 *
 * 与 mimo 版注入器的 5 处差异（都是实测踩出来的）：
 *   1. <head> 定位用 /<head(?:\s[^>]*)?>/i。mimo 版的 /<head[^>]*>/i 在真实
 *      面板上匹配 4 处，其中一处是 `<header class="'+QC.head+'">`——不是 head
 *      标签；当前面板恰好安全（真 <head> 出现在最早），纯属巧合。
 *   2. 找不到「不含补丁标记的干净源」就报错退出，不退化猜测；目标面板只含
 *      mimo 补丁、不含 workbuddy 补丁时，把当前文件当干净源（顺序见下）。
 *   3. 写盘前做体积 + 结构体检（增量 ±20%、</html> 唯一、注释配平、脚本数 +N）。
 *   4. 原子写：先写同名 .tmp 再 rename，避免 CPA 在写一半时读走半截文件。
 *   5. 保留 vm.Script 逐段语法门禁，但**只校验我们注入的那段内联脚本**。
 *      为什么不校验整份 HTML：官方面板主 bundle 是
 *      `<script type="module" crossorigin>`，内含 5 处 `import.meta`；
 *      vm.Script 只接受经典脚本，拿它解析整份 HTML 会把官方的 ESM 语法
 *      （import.meta / export）误报成我们的问题。所以必须先剥 HTML 注释、
 *      只抽非 src= 的内联 script，再从里面挑出我们注入的那段来解析。
 *
 * 用法：
 *   node apply-patch.mjs                       # 默认 bin: %TEMP%\cpa-test\bin
 *   node apply-patch.mjs --bin "D:\cpa\bin"
 *   node apply-patch.mjs --dry-run             # 只校验，不写盘
 *   node apply-patch.mjs --restore             # 还原干净原版
 *   node apply-patch.mjs --patch <file>        # 指定补丁文件
 *
 * 干净源优先级
 *   注入：static/management.html.orig → static/mgmt-unpatched.html →
 *         当前 static/management.html（仅当它不含 __wbQuotaPatch，例如只打了
 *         mimo 补丁）→ static/management.html.prev（仅当它不含标记，用于把
 *         旧版 workbuddy 补丁升级到新版）→ 都没有：报错退出，宁可不升级。
 *   还原：static/management.html.orig → static/mgmt-unpatched.html →
 *         static/management.html.prev；当前文件本就干净则视为无需还原。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

/* ------------------------------------------------------------ 0) 输出工具 */

const ok = (s) => console.log(`  ✅ ${s}`);
const info = (s) => console.log(`  ·  ${s}`);
const warn = (s) => console.log(`  ⚠️  ${s}`);
const fail = (s) => {
  console.error(`  ❌ ${s}`);
  process.exit(1);
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

/* ------------------------------------------------------------ 1) 参数解析 */

const DRY = has("--dry-run");
const RESTORE = has("--restore");
const PATCH_FILE = path.resolve(opt("--patch", path.join(HERE, "workbuddy-quota-patch.html")));
const BIN = path.resolve(
  opt("--bin", path.join(process.env.TEMP || process.env.TMP || ".", "cpa-test", "bin"))
);

const FLAGS = new Set(["--dry-run", "--restore"]);
const VALUED = new Set(["--bin", "--patch"]);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (VALUED.has(a)) {
    if (!args[i + 1] || args[i + 1].startsWith("--")) fail(`${a} 缺少取值，例如 ${a} "D:\\cpa\\bin"`);
    i++;
    continue;
  }
  if (!FLAGS.has(a)) fail(`未知参数：${a}（可用：--bin <dir> / --patch <file> / --dry-run / --restore）`);
}

/* ------------------------------------------------------------ 2) 关键常量 */

const MARKER = "__wbQuotaPatch"; // workbuddy 补丁的幂等标记（不是 mimo）
const VERSION_RE =
  /if\s*\(\s*window\.__wbQuotaPatch\s*\)\s*return;\s*window\.__wbQuotaPatch\s*=\s*([^;]+);/;
/** 补丁里守卫在 IIFE 内，上面的正则不锚行首，照样能拿到 '1' */
const SIZE_TOLERANCE = 0.2; // 注入增量相对补丁体积允许的偏差

const HTML = path.join(BIN, "static", "management.html");
const ORIG = path.join(BIN, "static", "management.html.orig");
const UNPATCHED = path.join(BIN, "static", "mgmt-unpatched.html");
const PREV = `${HTML}.prev`;
const BAK = `${HTML}.bak`;

/* --------------------------------- 3) 结构感知的 HTML 视图（定位 + 计数） */

/** 整段替换成等长空白（保留换行）：视图与原文下标严格对齐。 */
const blank = (s) => s.replace(/[^\n]/g, " ");

/* 开标签用 sticky（y）：必须**正好落在**当前 `<` 上，否则会把后面某个真
   <script> 的匹配当成这里的，bodyStart 就算错了。
   闭标签用 global（g）+ lastIndex：语义是「从这里往后找第一个」，写成 sticky
   会变成「必须正好在这里」，找不到就一路遮蔽到文件尾（实测踩过：</html>
   被吞掉，结构检查报「</html> 计数为 0」）。 */
const RE_SCRIPT_OPEN = /<script\b[^>]*>/iy;
const RE_SCRIPT_CLOSE = /<\/script\s*>/gi;

/** 结构视图：把 **<script> 正文** 与 **HTML 注释正文** 换成等长空白，
 *  但保留 `<!--` / `-->` / `<script …>` 标记本身与所有换行。
 *
 *  用途：`</html>` 计数、`<script>` 计数、`<!--`/`-->` 配平、注入点定位。
 *  正文是 CDATA/纯文本，里面的样子都不算标签：官方面板 minified bundle 里真的
 *  写着 `</html>` 字面量，minified JS 里还有 8 处 `r-->0` 自减。不遮蔽就会
 *  误判——实测原文 raw `<!--` 1 个、`-->` 9 个，那个 8 纯属 JS。
 *
 *  为什么必须左到右一趟扫，而不是两个正则各replace一遍：
 *  mimo 补丁的注释正文里就写着 `<script>` 字样（实测面板 idx≈9709）。若直接
 *  正则找开标签，会把注释里的假标签当真，一路吞到下一个 `</script>`——实测
 *  正是这个坑让 `</html>` 被吞掉、结构检查报「计数为 0」。
 *  反过来先剥注释、再遮蔽脚本正文则相反：脚本正文里的 `-->` 会留在注释配平的
 *  统计里。两种顺序都不行，只能带状态扫一遍。
 *
 *  未闭合的 `<!--` 如何处理（注释配平检查成立的前提）：
 *  若让它一路吞到下一个 `-->`，那么「A 处漏写 `-->`、后面 B 处真实注释的
 *  `-->` 恰好把它补上」就会显示成配平（实测就这么放过去一个未闭合注释）。
 *  所以未闭合时只遮蔽到**下一个 `<!--`** 为止，并**保留**这个 `<!--` 不动，
 *  让它自己去和后面的 `-->` 配——错配于是必然表现为两个 `<!--` 对一个 `-->`。 */
function structuralView(html) {
  const parts = [];
  let cursor = 0;
  const hide = (from, to) => {
    if (to <= from) return;
    parts.push(html.slice(cursor, from), blank(html.slice(from, to)));
    cursor = to;
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      const nextOpen = html.indexOf("<!--", lt + 4);
      if (end < 0 || (nextOpen >= 0 && nextOpen < end)) {
        // 未闭合：只遮蔽到下一个 <!-- 之前，保留 delimiter 交给配平检查
        hide(lt + 4, nextOpen >= 0 ? nextOpen : html.length);
        i = nextOpen >= 0 ? nextOpen : html.length;
        continue;
      }
      hide(lt + 4, end);
      i = end + 3;
      continue;
    }
    RE_SCRIPT_OPEN.lastIndex = lt;
    const so = RE_SCRIPT_OPEN.exec(html);
    if (so) {
      const bodyStart = lt + so[0].length;
      RE_SCRIPT_CLOSE.lastIndex = bodyStart;
      const sc = RE_SCRIPT_CLOSE.exec(html);
      hide(bodyStart, sc ? sc.index : html.length);
      i = sc ? sc.index : html.length;
      continue;
    }
    i = lt + 1;
  }
  parts.push(html.slice(cursor));
  return parts.join("");
}

const count = (s, re) => (s.match(re) || []).length;

function structuralCounts(html) {
  const view = structuralView(html);
  return {
    view,
    htmlClose: count(view, /<\/html\s*>/gi),
    commentOpen: count(view, /<!--/g),
    commentClose: count(view, /-->/g),
    scriptTags: count(view, /<script\b[^>]*>/gi),
    rawHtmlClose: count(html, /<\/html\s*>/gi),
    rawCommentOpen: count(html, /<!--/g),
    rawCommentClose: count(html, /-->/g),
  };
}

/** 改进 3：结构体检。失败一律中止写盘（注释没闭合会吞掉整页）。 */
function assertStructure(html, label) {
  const c = structuralCounts(html);
  info(
    `${label}结构：</html>×${c.htmlClose}，注释 <!-- ${c.commentOpen} / --> ${c.commentClose}，` +
      `<script> ${c.scriptTags} 个（原文粗计：</html>×${c.rawHtmlClose}，<!-- ${c.rawCommentOpen} / --> ${c.rawCommentClose}，` +
      `其中 script 正文里的 \`--\` 也算在内）`
  );
  if (c.htmlClose !== 1) fail(`${label}</html> 计数为 ${c.htmlClose}（应为 1）——拒绝写盘`);
  if (c.commentOpen !== c.commentClose)
    fail(
      `${label}HTML 注释不配平（<!-- ${c.commentOpen} 个，--> ${c.commentClose} 个）——` +
        `未闭合的注释会吞掉整页，拒绝写盘`
    );
  return c;
}

/* ------------------------------------------- 4) 内联脚本语法门禁（改进 5） */

/** 去 HTML 注释的**文本副本**，仅供 inlineScripts 抽取标签边界用（长度会变短，
 *  所以不参与体积/结构计数）。补丁头部说明里就写着 `<script>`/`</script>`
 *  字样，不先剥掉会把注释文本当成脚本内容（mimo 版 v7.5 首次自检踩过）。 */
function stripHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

/** 抽出所有非 src= 的内联 <script>…</script> 正文 */
function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  const text = stripHtmlComments(html);
  let m;
  while ((m = re.exec(text))) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    out.push(m[2]);
  }
  return out;
}

/**
 * 语法校验：vm.Script 以「脚本」身份解析（不是函数体），顶层 return 之类也会被
 * 抓出来。只解析、不执行。**只喂补丁自己的内联脚本**——官方面板主 bundle 是
 * ES module（含 import.meta），塞进来只会得到与补丁无关的误报。
 */
function assertScriptsParse(html, tag) {
  const scripts = inlineScripts(html);
  if (!scripts.length) fail(`${tag} 里没有内联 <script>，注入它没有意义`);
  scripts.forEach((src, i) => {
    const filename = `${tag}#script[${i}]`;
    try {
      new vm.Script(src, { filename });
    } catch (err) {
      const stack = String(err.stack || "");
      const ln = Number((stack.match(new RegExp(`${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}#script\\[${i}\\]:(\\d+)`)) || [])[1] || 0);
      const lines = src.split("\n");
      const ctx = ln
        ? "\n" +
          lines
            .slice(Math.max(0, ln - 3), ln)
            .map((l, k) => `       ${Math.max(1, ln - 2) + k}: ${l}`)
            .join("\n")
        : "";
      fail(`${tag} 内联脚本[${i}]语法错误：${err.message}${ctx}\n     （写盘已中止，原文件未改动）`);
    }
  });
  ok(`内联脚本语法校验通过（${scripts.length} 段，vm.Script 解析）`);
  return scripts;
}

/* --------------------------------------------------------- 5) 原子写（改进 4） */

function atomicWrite(file, text) {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, file); // 同目录 rename：Windows 上也是原子替换
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* 清理失败不掩盖主错误 */
    }
    fail(`写盘失败（${file}）：${err.message}；目标文件未改动，临时文件已尝试清理`);
  }
}

const readIf = (p) => {
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  } catch {
    return null;
  }
};

/* --------------------------------------- 6) 干净源解析（改进 2：不猜、不叠） */

/**
 * 依次挑第一个「存在且不含 __wbQuotaPatch」的候选；全都不合格就返回 null，
 * 由调用方报错退出（宁可不升级，也不在旧补丁上叠加或凭空猜一份基线）。
 */
function pickClean(candidates) {
  const rejected = [];
  for (const { file, label } of candidates) {
    const text = readIf(file);
    if (text === null) {
      rejected.push(`${label}：不存在`);
      continue;
    }
    if (text.includes(MARKER)) {
      rejected.push(`${label}：已含 ${MARKER}（脏）`);
      continue;
    }
    return { file, text, label, rejected };
  }
  return { file: null, text: null, label: null, rejected };
}

const INJECT_CANDIDATES = [
  { file: ORIG, label: "management.html.orig" },
  { file: UNPATCHED, label: "mgmt-unpatched.html" },
  { file: HTML, label: "当前 management.html（不含 workbuddy 补丁）" },
  { file: PREV, label: "management.html.prev（旧补丁的干净基线）" },
];
const RESTORE_CANDIDATES = [
  { file: ORIG, label: "management.html.orig" },
  { file: UNPATCHED, label: "mgmt-unpatched.html" },
  { file: PREV, label: "management.html.prev" },
];

/* ================================================================ 主流程 */

if (!fs.existsSync(path.dirname(HTML))) fail(`找不到面板目录：${path.dirname(HTML)}`);
console.log(`面板 bin：${BIN}`);

if (RESTORE) {
  /* ------------------------------------------------------------ 还原分支 */
  const clean = pickClean(RESTORE_CANDIDATES);
  if (!clean.file) {
    const cur = readIf(HTML);
    if (cur !== null && !cur.includes(MARKER)) {
      info(`当前 ${path.basename(HTML)} 不含 ${MARKER}，无需还原`);
      for (const r of clean.rejected) info(`  （${r}）`);
      process.exit(0);
    }
    fail(
      `没有可还原的干净原版：\n     ${clean.rejected.join("\n     ")}\n` +
        `     请从 CPA 发行包/备份恢复一份干净的 static/management.html.orig 后重试。`
    );
  }
  info(`还原来源：${clean.label} → ${clean.file}（${Buffer.byteLength(clean.text, "utf8")} 字节）`);
  assertStructure(clean.text, "还原源");
  if (DRY) {
    ok("dry-run：还原源校验通过，未写盘");
    process.exit(0);
  }
  const cur = readIf(HTML);
  if (cur !== null) {
    atomicWrite(BAK, cur); // 保留一份改动前的现状（可能是打过补丁的）
    info(`改动前的现状备份到 ${path.basename(BAK)}`);
  }
  atomicWrite(HTML, clean.text);
  const back = fs.readFileSync(HTML, "utf8");
  if (back !== clean.text) fail("写盘后复检失败：还原内容与来源不一致");
  if (back.includes(MARKER)) fail("写盘后复检失败：还原结果里仍有补丁标记");
  ok(`已还原 ${HTML}（${Buffer.byteLength(back, "utf8")} 字节）`);
  process.exit(0);
}

/* -------------------------------------------------------------- 注入分支 */

console.log(`补丁：${PATCH_FILE}`);
if (!fs.existsSync(PATCH_FILE)) fail(`找不到补丁文件：${PATCH_FILE}`);
const patch = fs.readFileSync(PATCH_FILE, "utf8");
const patchBytes = Buffer.byteLength(patch, "utf8");

const vm0 = patch.match(VERSION_RE);
if (!vm0) {
  fail(
    `补丁里找不到版本守卫（期望形如：if (window.${MARKER}) return; window.${MARKER}='1';）。\n` +
      `     这通常说明 --patch 指向的不是本项目的补丁；版本标记与幂等判断都依赖它，拒绝继续。`
  );
}
const PATCH_VERSION = vm0[1].trim();
info(`版本标记：window.${MARKER}=${PATCH_VERSION}`);
info(`补丁体积：${patchBytes} 字节`);

/* 改进 5：只校验补丁那段内联脚本（不碰官方面板的 ESM bundle） */
const patchScripts = assertScriptsParse(patch, "workbuddy-quota-patch.html");

/* 改进 2：干净源；没有就报错退出 */
const clean = pickClean(INJECT_CANDIDATES);
if (!clean.file) {
  fail(
    `找不到不含 ${MARKER} 的干净源，拒绝在旧补丁上叠加：\n     ${clean.rejected.join("\n     ")}\n` +
      `     请先从 CPA 发行包/备份恢复一份干净的 static/management.html（或 .orig）后重试。`
  );
}
const cleanBytes = Buffer.byteLength(clean.text, "utf8");
info(`干净来源：${clean.label}（${clean.file}，${cleanBytes} 字节）`);
for (const r of clean.rejected) info(`  跳过：${r}`);

const cClean = assertStructure(clean.text, "干净源");

/* ---------------------------------------------------------------- 注入 */

/* 改进 1：只认真正的 <head>，不匹配 <header>；在结构视图上定位，
   注释正文里的 `<head>` 字样也不会被误当注入点（实测面板注释里就有一个）。 */
const HEAD_RE = /<head(?:\s[^>]*)?>/i;
const headView = HEAD_RE.exec(cClean.view);
if (!headView) fail("干净源的结构视图里找不到 <head>，注入点不可用");
const headRaw = clean.text.slice(headView.index, headView.index + headView[0].length);
info(`注入点：原文 idx ${headView.index} 处的 ${headRaw}`);

const injected = clean.text.slice(0, headView.index + headRaw.length) + "\n" + patch + clean.text.slice(headView.index + headRaw.length);
const injectedBytes = Buffer.byteLength(injected, "utf8");

/* 改进 3：结构 + 体积体检（全部在写盘之前） */
const cInj = assertStructure(injected, "注入后");
if (cInj.scriptTags !== cClean.scriptTags + patchScripts.length)
  fail(
    `注入后 <script> 数量异常：${cClean.scriptTags} → ${cInj.scriptTags}，` +
      `应为 +${patchScripts.length}（补丁脚本可能被注释/标签吞掉了）——拒绝写盘`
  );
for (const [i, s] of patchScripts.entries()) {
  if (!injected.includes(s))
    fail(`注入结果里找不到补丁内联脚本[${i}]的原文（注入点或标签闭合有问题）——拒绝写盘`);
}

const delta = injectedBytes - cleanBytes;
const lo = Math.round(patchBytes * (1 - SIZE_TOLERANCE));
const hi = Math.round(patchBytes * (1 + SIZE_TOLERANCE));
info(`体积：${cleanBytes} → ${injectedBytes} 字节（+${delta}）`);
info(`允许增量区间 [${lo}, ${hi}] 字节（补丁体积 ±20%）`);
if (delta < lo || delta > hi)
  fail(`体积增量 ${delta} 字节超出 [${lo}, ${hi}]：注入结果与补丁大小不符，拒绝写盘`);

if (DRY) {
  ok("dry-run：结构 + 体积 + 语法全部通过，未写盘");
  process.exit(0);
}

/* ------------------------------------------------------------ 写盘 + 复检 */

/* 备份：优先保住一份干净基线，别用打过补丁的现状覆盖掉它 */
const cur = readIf(HTML);
if (cur !== null) {
  if (cur.includes(MARKER) && readIf(PREV) !== null && !readIf(PREV).includes(MARKER)) {
    info(`保留既有干净基线 ${path.basename(PREV)}（当前文件含补丁，不用它覆盖）`);
  } else {
    atomicWrite(PREV, cur);
    info(`改动前备份到 ${path.basename(PREV)}`);
  }
}
atomicWrite(HTML, injected);

const written = fs.readFileSync(HTML, "utf8");
if (!written.includes(MARKER)) fail("写盘后复检失败：文件里没有补丁标记");
if (Buffer.byteLength(written, "utf8") !== injectedBytes)
  fail("写盘后复检失败：落盘字节数与注入结果不一致（可能被并发改写）");
const cWritten = assertStructure(written, "落盘后");
if (cWritten.scriptTags !== cInj.scriptTags) fail("写盘后复检失败：<script> 数量与注入结果不一致");
/* 只复检**我们注入的那段脚本**：官方面板自己的内联脚本是 ES module
   （含 import.meta / export），拿 vm.Script 按经典脚本解析必然报错，
   不能拿它当补丁的体检结果。 */
for (const [i, s] of patchScripts.entries()) {
  if (!inlineScripts(written).includes(s))
    fail(`写盘后复检失败：注入的内联脚本[${i}]与补丁原文不一致`);
}
assertScriptsParse(patch, "workbuddy-quota-patch.html");

ok(`已写入 ${HTML}（${Buffer.byteLength(written, "utf8")} 字节，原子替换）`);
console.log(`
下一步：
  1. 浏览器硬刷新面板（Ctrl+F5）——静态文件，无需重启 CPA
  2. 控制台应出现 window.${MARKER} === ${PATCH_VERSION}
  3. #/quota 每账号一张卡；#/auth-files workbuddy 卡内有额度区与刷新令牌按钮
  4. 回滚：node apply-patch.mjs --restore`);
