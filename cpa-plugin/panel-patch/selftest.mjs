#!/usr/bin/env node
/**
 * apply-patch.mjs 的对抗式回归自测（41 项）。
 *
 * 只跑边界与**失败**路径：脏源拒绝、注释未闭合、语法错、目录/参数错等。
 * 夹具建在系统临时目录下（不脏仓库、也**不清脚本自己所在的目录**——初版把
 * ROOT 指向脚本所在目录，fs.rmSync 顺手把 selftest.mjs 自己删了），不碰真实面板。
 *
 * 用法：node selftest.mjs    →  全绿时退出码 0
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APPLY = path.join(path.dirname(fileURLToPath(import.meta.url)), "apply-patch.mjs");
const ROOT = path.join(os.tmpdir(), "wb2api-panel-patch-fixtures");
fs.rmSync(ROOT, { recursive: true, force: true });

let pass = 0, fail = 0;
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

function run(args) {
  try {
    const out = execFileSync(process.execPath, [APPLY, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? -1, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
}
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? " :: " + extra : ""}`); }
}
function fixture(name, html) {
  const dir = path.join(ROOT, name, "static");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "management.html"), html, "utf8");
  return path.join(ROOT, name);
}
const MARK = "__wbQuotaPatch";

/* 真实面板的坑全塞进夹具：
   - HTML 注释正文里带 <script> 字样（骗过朴素正则）
   - <header class="..."> 出现在 <head> 之前（骗过 /<head[^>]*>/i）
   - 官方 module bundle 带 import.meta（vm.Script 不能解析）
   - script 正文里带 </html> 与 r-->0（骗过 raw 计数） */
const HEADER_TRAP = `<header class="'+QC.head+'">`;
const PMOD = `<!-- 说明：不要匹配 <head> 字样，也不要匹配 <script> 字样 -->`;
const BASE = [
  "<!doctype html>",
  `<html lang="zh-CN">`,
  `<body><div>${HEADER_TRAP}</div></body>`,
  `  <head>`,
  PMOD,
  "    <script>window.__panel='x';</script>",
  `    <script type="module" crossorigin>import.meta.url; var s="</html>"; for(;r-->0;);</script>`,
  "  </head>",
  "  <body><div id=\"root\"></div></body>",
  "</html>",
  "",
].join("\n");

const PATCH_OK = [
  "<!-- workbuddy patch -->",
  "<style>[data-wb-hidden='1']{display:none}</style>",
  "<script>",
  "(function(){",
  "  if (window.__wbQuotaPatch) return;",
  "  window.__wbQuotaPatch = '1';",
  "  var a = 1;",
  "})();",
  "</script>",
  "",
].join("\n");

const writePatch = (name, text) => {
  fs.mkdirSync(ROOT, { recursive: true });
  const f = path.join(ROOT, name);
  fs.writeFileSync(f, text, "utf8");
  return f;
};

/* --- 1) dry-run：真面板坑的夹具上必须通过，且注入点必须是 <head> --- */
{
  const bin = fixture("case1", BASE);
  const r = run(["--bin", bin, "--patch", writePatch("p-ok.html", PATCH_OK), "--dry-run"]);
  check("1a dry-run 退出码 0", r.code === 0, r.out);
  check("1b 打印「内联脚本语法校验通过（1 段」", /内联脚本语法校验通过（1 段/.test(r.out), r.out);
  check("1c 注入点是 <head>（没被 <header> 骗走）", /注入点：原文 idx \d+ 处的 <head>/.test(r.out), r.out);
  check("1d 没有写盘", !fs.readFileSync(path.join(bin, "static", "management.html"), "utf8").includes(MARK), "");
}

/* --- 2) 真注入：标记在位、</html> 唯一、精确落在 <head> 之后 --- */
{
  const bin = fixture("case2", BASE);
  const pf = path.join(bin, "static", "management.html");
  const before = sha(pf);
  const r = run(["--bin", bin, "--patch", writePatch("p-ok2.html", PATCH_OK)]);
  check("2a 注入退出码 0", r.code === 0, r.out);
  const out = fs.readFileSync(pf, "utf8");
  check("2b 文件含 __wbQuotaPatch", out.includes(MARK), "");
  /* 夹具故意在 script 正文里放了一个 </html> 字面量：原文粗计是 2，结构性
     计数必须是 1。工具若不区分，就会误报「计数为 2」并拒绝写盘。 */
  check("2c 原文粗计 2 但结构计数 1，未误判中止", (out.match(/<\/html>/gi) || []).length === 2 && /干净源结构：<\/html>×1/.test(r.out) && /原文粗计：<\/html>×2/.test(r.out), r.out);
  check("2d 补丁正好插在 <head> 之后", out.includes("<head>\n" + PATCH_OK), JSON.stringify(out.slice(out.indexOf("<head>"), out.indexOf("<head>") + 40)));
  check("2e 体积增量 == 补丁字节数+1", Buffer.byteLength(out) - Buffer.byteLength(BASE) === Buffer.byteLength(PATCH_OK) + 1, "");
  check("2f 没留下 .tmp", !fs.existsSync(pf + ".tmp"), "");
  check("2g 备份 .prev 存在且为注入前原文", fs.existsSync(pf + ".prev") && sha(pf + ".prev") === before, "");
  check("2h script 正文里的 </html>/r-->0 未污染结构计数", /注释 <!-- 1 \/ --> 1，<script> 2 个（原文粗计：<\/html>×2/.test(r.out) && /注释 <!-- 2 \/ --> 2，<script> 3 个/.test(r.out), r.out);

  /* --- 3) 还原：必须字节级回到夹具原文 --- */
  const rr = run(["--bin", bin, "--restore"]);
  check("3a restore 退出码 0", rr.code === 0, rr.out);
  check("3b 还原后与注入前 hash 一致", sha(pf) === before, "");
  check("3c 还原后不含补丁标记", !fs.readFileSync(pf, "utf8").includes(MARK), "");

  /* --- 4) 已干净时再次 restore：应报「无需还原」并退 0 --- */
  fs.rmSync(pf + ".prev", { force: true });
  const rr2 = run(["--bin", bin, "--restore"]);
  check("4a 干净文件 restore 退 0 且提示无需还原", rr2.code === 0 && /无需还原/.test(rr2.out), rr2.out);
}

/* --- 5) 干净源优先级：.orig 应压过当前文件 --- */
{
  const bin = fixture("case5", BASE.replace("id=\"root\"", "id=\"root\" data-sentinel=\"CURRENT\""));
  const dir = path.join(bin, "static");
  fs.writeFileSync(path.join(dir, "management.html.orig"), BASE.replace("id=\"root\"", "id=\"root\" data-sentinel=\"ORIG\""), "utf8");
  const r = run(["--bin", bin, "--patch", writePatch("p-ok3.html", PATCH_OK)]);
  const out = fs.readFileSync(path.join(dir, "management.html"), "utf8");
  check("5a 优先用 .orig 而不是当前文件", out.includes("ORIG") && !out.includes("CURRENT"), r.out);
  check("5b 干净来源标注为 management.html.orig", /干净来源：management\.html\.orig/.test(r.out), r.out);
}

/* --- 6) 完全没有干净源：必须报错退出，不改文件（改进 2 的核心） --- */
{
  const bin = fixture("case6", BASE);
  const pf = path.join(bin, "static", "management.html");
  run(["--bin", bin, "--patch", writePatch("p-ok4.html", PATCH_OK)]); // 打上补丁并留下 .prev
  fs.rmSync(pf + ".prev", { force: true });                            // 抹掉干净基线
  const h = sha(pf);
  const r = run(["--bin", bin, "--patch", writePatch("p-ok5.html", PATCH_OK)]);
  check("6a 无干净源时退出码 1", r.code === 1, `code=${r.code} ${r.out}`);
  check("6b 报错文案点明不叠加", /找不到不含 __wbQuotaPatch 的干净源/.test(r.out), r.out);
  check("6c 被拒后目标文件未被改动", sha(pf) === h, "");
}

/* --- 7) 补丁语法错：写盘前拦下（改进 5 的核心） --- */
{
  const bin = fixture("case7", BASE);
  const pf = path.join(bin, "static", "management.html");
  const h = sha(pf);
  const bad = PATCH_OK.replace("var a = 1;", "var a = 1.0.1;"); // mimo v7.4.1 的同款事故
  const r = run(["--bin", bin, "--patch", writePatch("p-bad.html", bad)]);
  check("7a 语法错退出码 1", r.code === 1, `code=${r.code}`);
  check("7b 报错含「语法错误」", /语法错误/.test(r.out), r.out);
  check("7c 目标文件未改动", sha(pf) === h, "");
  check("7d 未留下 .tmp", !fs.existsSync(pf + ".tmp"), "");
  check("7e 官方 ESM（import.meta）没被误报", !/import\.meta/.test(r.out), r.out);
}

/* --- 8) 补丁缺版本守卫 --- */
{
  const bin = fixture("case8", BASE);
  const p = PATCH_OK.replace(/if \(window\.__wbQuotaPatch\) return;\n\s*window\.__wbQuotaPatch = '1';\n/, "");
  const r = run(["--bin", bin, "--patch", writePatch("p-noguard.html", p)]);
  check("8a 缺版本守卫退 1", r.code === 1, `code=${r.code}`);
  check("8b 报错点明版本守卫", /找不到版本守卫/.test(r.out), r.out);
}

/* --- 9) 有守卫但没内联脚本 --- */
{
  const bin = fixture("case9", BASE);
  const p = "if (window.__wbQuotaPatch) return; window.__wbQuotaPatch = '1';\n<!-- 只有注释 -->\n";
  const r = run(["--bin", bin, "--patch", writePatch("p-noscript.html", p)]);
  check("9a 无内联 script 退 1", r.code === 1, `code=${r.code}`);
  check("9b 报错点明没有内联", /没有内联 <script>/.test(r.out), r.out);
}

/* --- 10) 补丁注释未闭合：结构门禁必须拦下（改进 3 的核心） --- */
{
  const bin = fixture("case10", BASE);
  const pf = path.join(bin, "static", "management.html");
  const h = sha(pf);
  /* 漏写 -->，且后面还有一个正常注释——正是「错配被后面的 --> 补齐」的陷阱 */
  const p = "<!-- 忘了闭合\n" + PATCH_OK;
  const r = run(["--bin", bin, "--patch", writePatch("p-unclosed.html", p)]);
  check("10a 注释不配平退 1", r.code === 1, `code=${r.code} ${r.out}`);
  check("10b 报错点明注释不配平", /注释不配平/.test(r.out), r.out);
  check("10c 目标文件未改动", sha(pf) === h, "");
}

/* --- 11) 补丁多带一个 </html>：结构门禁必须拦下 --- */
{
  const bin = fixture("case11", BASE);
  const r = run(["--bin", bin, "--patch", writePatch("p-2html.html", PATCH_OK + "</html>\n")]);
  check("11a </html> 计数不为 1 时退 1", r.code === 1, `code=${r.code}`);
  check("11b 报错点明计数", /<\/html> 计数为 2/.test(r.out), r.out);
}

/* --- 12) 参数与目录错误 --- */
{
  const bin = fixture("case12", BASE);
  const p = writePatch("p-ok6.html", PATCH_OK);
  const r1 = run(["--bin", bin, "--patch", p, "--bogus"]);
  check("12a 未知参数退 1", r1.code === 1 && /未知参数/.test(r1.out), r1.out);
  const r2 = run(["--bin", bin, "--patch", p, "--bin"]);
  check("12b --bin 缺取值退 1", r2.code === 1, r2.out);
  const r3 = run(["--bin", path.join(ROOT, "no-such-bin"), "--patch", p]);
  check("12c 面板目录不存在退 1", r3.code === 1 && /找不到面板目录/.test(r3.out), r3.out);
  const r4 = run(["--bin", bin, "--patch", path.join(ROOT, "no-such-patch.html")]);
  check("12d 补丁文件不存在退 1", r4.code === 1 && /找不到补丁文件/.test(r4.out), r4.out);
  /* 该夹具当前文件是干净的：restore 的正确行为是「无需还原」并退 0（而不是报错） */
  const r5 = run(["--bin", bin, "--patch", p, "--dry-run", "--restore"]);
  check("12e 干净文件 + --dry-run --restore：退 0、提示无需还原、不写盘",
    r5.code === 0 && /无需还原/.test(r5.out) && !fs.readFileSync(path.join(bin, "static", "management.html"), "utf8").includes(MARK), r5.out);
}

/* --- 13) 带空格的补丁路径 --- */
{
  const bin = fixture("case13", BASE);
  const nested = path.join(ROOT, "deep", "dir", "my patch.html");
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.writeFileSync(nested, PATCH_OK, "utf8");
  const r = run(["--bin", bin, "--patch", nested, "--dry-run"]);
  check("13a 带空格的 --patch 路径可用", r.code === 0, r.out);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
