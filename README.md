# wb2api

把本机 **WorkBuddy** 桌面客户端的账号会话包成**标准 OpenAI 兼容入口**，跑在本机。

参考同作者的 [xm2api](https://github.com/qizhuxu/xm2api)（小米 MiMo 那一套）的思路与工程形态，
但 WorkBuddy 这边上游约束更多，凭证也不是明文——都需要复刻，细节见
`docs/architecture.md`。

**深入文档**（本机开发资料，**不入公开面**，故此处用代码字体而非链接）：

| 文档 | 内容 |
|---|---|
| `docs/architecture.md` | 整体架构、上游协议、凭证链路、踩坑记录 |
| `docs/workbuddy-thinking-multimodal.md` | 上游**思考与多模态**的字段、取值、错误码（全实测） |
| `docs/upstream-rate-limit.md` | **上游限流（429 / code=6004）专项实测**：**单日限额 ≈ 5.56M tokens**、滚动 24 小时窗口、并发/请求数均非触发因素、复现脚本 |
| `docs/cpa-analysis.md` | [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 的思考/多模态设计调研与对比 |
| `docs/cpa-plugin-analysis.md` | [workbuddy-cpa-plugin](https://github.com/Lxapk/workbuddy-cpa-plugin) 调研（二开基线） |
| `docs/plugin-build-ci.md` | workbuddy 插件构建与发布（CI）：Linux `.so` 交叉构建的必要性与流程 |
| `docs/subagent-retrospective.md` | 子代理使用问题复盘（协作纪律的证据与根因） |
| `docs/panel-patch-plan.md` | CPA 面板补丁实施方案（#/auth-files、#/quota 的 wb 卡片） |

> 这些文档与 `AGENTS.md`、`test/` 同属开发资料，公开仓库里不会包含
> （规则见 `.gitattributes` 的 `export-ignore`）；因此上游项目链接可直接点，本地文档路径不可。

- **不需要 API Key** —— 用桌面客户端自己的登录会话
- **不需要开客户端** —— 只需要它登录过一次（凭证解密后缓存在本地）
- **不改你的请求** —— 上游 SSE 原样透传，只在客户端明确要 `stream:false` 时本地聚合
- **自动续期** —— accessToken 快过期时用 refreshToken 换新的，不打扰桌面端

> ⚠️ 只在本机使用、只用于你自己的账号。不要把它暴露到公网。

---

## 快速开始

前置：Node ≥ 22（用到内置 `fetch` / `AbortSignal.timeout`），Windows，WorkBuddy 已登录过一次。

```powershell
npm install
npm run menu      # 交互式控制台（或双击 start.bat）
```

不想进菜单也可以直接用命令：

```powershell
npm start         # 后台启动（日志进 logs/server-stdout.log）
npm stop          # 停止
npm status        # 状态 / 凭证 / 模型数
npm run probe     # 健康检查：凭证 → 模型 → 流式 → 非流式
npm test          # 回归测试（假上游打异常语义 / 流式边界 / 凭证状态机）
npm run creds     # 看当前凭证（export 重新解密，refresh 强制续期）
npm run serve     # 前台启动，Ctrl+C 停止（调试用）
npm run public-snapshot   # 导出公开面快照并自检（剔除 AGENTS.md / test/ / docs/ 等）
```

### 管理台（浏览器）

服务启动后打开 **<http://127.0.0.1:18788/ui>**（或从状态页的「→ 打开管理台」进入）。

纯静态、无构建、无 CDN 外链；五个视图：

| 视图 | 内容 |
|---|---|
| **总览** | 凭证状态（uid / 到期 / 来源）、模型数、服务版本 |
| **模型** | `/v1/models` 全表：id / 名称 / 上下文 / 输出上限 / 来源（`local`·`upstream`·`probe`）/ 能力标记；支持筛选、按来源过滤、强制刷新 |
| **凭证** | 当前凭证详情；「重新解凭证」（`mode=file`）与「换票续期」（`mode=token`） |
| **自检** | `/__wb2api` 完整结果 |
| **危险操作** | 服务退出（二次确认，需勾选确认） |

> ⚠️ 本服务**没有鉴权**（只监听回环）。管理台因此不含密钥机制；
> 若要暴露到局域网，请自己在前面加一层鉴权。

客户端接法（官方 SDK 已实测通过）：

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:18788/v1", api_key="wb2api")  # key 会被忽略

# 非流式（服务端把上游的流聚合回一条 JSON）
resp = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "你好"}],
    max_tokens=512,
)
print(resp.choices[0].message.content)

# 流式
for ev in client.chat.completions.create(
    model="deepseek-v4-flash", messages=[{"role": "user", "content": "数到三"}], stream=True
):
    print(ev.choices[0].delta.content or "", end="")
```

不装 SDK 也行：

```python
import json, urllib.request
req = urllib.request.Request(
    "http://127.0.0.1:18788/v1/chat/completions",
    data=json.dumps({"model": "deepseek-v4-flash",
                     "messages": [{"role": "user", "content": "你好"}],
                     "max_tokens": 512}).encode(),
    headers={"content-type": "application/json"},
)
print(json.load(urllib.request.urlopen(req))["choices"][0]["message"]["content"])
```

---

## 端点

| 路径 | 说明 |
|---|---|
| `GET /` | **浏览器状态页**（HTML：账号、凭证到期、模型数、接法示例）。脚本访问或加 `?format=json` 时返回同一份 JSON |
| `GET /health` | 同上的 JSON 别名，便于探活 |
| `POST /v1/chat/completions` | 对话 / 工具调用。`stream:true` 直接透传上游 SSE；`stream:false` 由本服务聚合 |
| `POST /route/chat/completions` | 同上（旧路径别名） |
| `GET /v1/models` | 模型目录（本地产品配置 + 上游 `/v3/config` 合并，缓存 5 分钟），带 `context_length` / `supports_tools` / `catalog` 等 |
| `GET /v1/models/{id}` | 单个模型；不存在时 404 |
| `GET /ui` | **浏览器管理台**（纯静态，无构建/无外链；只从白名单取文件，不做目录穿越） |
| `GET /__wb2api` | 自检 JSON：凭证来源、到期时间、模型清单 |
| `POST /__wb2api/creds/refresh` | 强制重新解一次凭证：默认 `mode=file` 从会话文件重新解密，`?mode=token` 用 refreshToken 换票 |
| `POST /__wb2api/shutdown` | 让服务自己退出（**仅本机**，拒绝带 `Origin` 的浏览器请求） |

未知路径返回 404 时会附上可用端点清单。

> **上游是 `/v2/chat/completions`，不是 `/v1`**：WorkBuddy 一方网关自己就是 OpenAI 风格的镜像
> 接口，本服务只做路径映射与身份头补齐，不改消息内容。

---

## 它是怎么拿到凭证的

WorkBuddy 把会话存在一个**字段级加密**的 JSON 里
（`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`），
`accessToken` / `refreshToken` 都是 `{"$wbEncrypted":1,"envelope":"<base64>"}` 形状。
本服务的三步：

1. 用 `ELECTRON_RUN_AS_NODE=1` 跑一下 `WorkBuddy.exe`，从它自己的原生绑定
   `electron_browser_workbuddy_storage.loggerGet()` 里取 **静态密钥**（不弹窗、毫秒级退出）；
2. `key = sha256(atRestSecretKey)`，再按源码的 TLV 规则重建 AAD，用 AES-256-GCM 解开字段；
3. 结果缓存到 `data/wb-session.json`，之后只靠这段缓存 + 续期接口工作，**不再碰客户端**。

完整密钥层级、AAD 布局、上游头清单和错误码含义 → **`docs/architecture.md`**（开发资料，不入公开面）。

### 本机的账号选择（重要，别随手改回去）

同一台机器上可能有**多个 WorkBuddy 账号**的会话文件（桌面端换号、`clean()` 备份都会留下 `.info`）。
本服务只认一个：`credentials.authFile` 指哪个就用哪个，置空才按「非备份优先 → mtime 最新」自动发现。

本机（2026-10-04）实测两个账号对同一模型的表现：

| 账号 | 会话文件 | `deepseek-v4.1-flash` |
|---|---|---|
| 账号① `43fde89b-…`（桌面端当前登录） | `workbuddy-desktop.info` | 当时 ❌ HTTP 429 `code=6004`；**22:48:41 已恢复**（报文说 22:48:14，误差 27 秒） |
| **账号② `27442c7b-…`（服务在用）** | `…2026-10-01T16-13….info` | ✅ 200，2.5 秒出正文（经服务自身接口实测：`content="切换成功"`、79 个 reasoning tokens） |

> 限流是**按「账号 × 模型」的每日 token 配额**（`code=6004` = `CraftRateTPDLimit`，TPD = tokens per day），
> **滚动 24 小时窗口**、**只认 token 量**：并发 32 路全过、`max_tokens=1` 照样被拒、
> 同账号其它 19 个模型全部正常。**实测单日限额 ≈ 5.56M tokens**（夹逼区间宽仅 6,007，
> 折合约 232K tokens/h、约 51 次调用/h）；报文里的重置时刻**是准确的**
> （实测误差 27 秒，且恰好对应 24 小时前的一次真实消耗），但它是**最老消耗滑出窗口**的时刻 ——
> 恢复是渐进的，不是到点满血。
> 完整实测（含客户端源码枚举、夹逼精算、去重的逻辑证明、复现脚本）→ `docs/upstream-rate-limit.md`。

所以 `config.yaml` 里**显式钉住**了账号② 的会话文件路径 —— 不依赖自动发现，否则桌面端每次
`clean()` 改写文件 mtime 后，服务会自己漂移回账号①。切号：改这一行为另一份 `.info`
（或置空回自动发现），然后 `npm run creds export` + 重启服务。

---

## 配置

`config.yaml`（环境变量可覆盖：`WB2API_PORT` / `WB2API_HOST` / `WB2API_ENDPOINT` /
`WB2API_WORKBUDDY_EXE` / `WB2API_AUTH_FILE` / `WB2API_PRODUCT_CONFIG`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `server.host` / `server.port` | `127.0.0.1` / `18788` | 监听地址（18787 留给 xm2api，避免打架） |
| `server.apiKey` | `wb2api` | 客户端填什么都行，本服务不校验 |
| `upstream.endpoint` | `https://copilot.tencent.com` | 一方网关 |
| `upstream.appVersion` | `5.6.2` | 会拼进 `X-IDE-Version` 与 `User-Agent`，**上游会校验** |
| `upstream.reasoningEffort` | `max` | 思考等级，注入顶层 `reasoning_effort`（`minimal`~`max`）。留空 = 不思考。见下节 |
| `upstream.reasoningSummary` | `auto` | 同时要思考摘要；留空则不注入 |
| `credentials.workbuddyExe` | `D:\workbuddy\WorkBuddy.exe` | 只用于取静态密钥（留空则自动探测常见安装位置） |
| `credentials.authFile` | 见下 | 加密会话文件。**本机已钉死**为账号②的会话文件（见下节）；置空则自动发现 `auth\*.info` 里非备份、最新的那个 |
| `credentials.refreshBeforeSec` | `600` | accessToken 剩余有效期低于这个秒数就先续期 |
| `models.useLocalCatalog` | `true` | 是否并入 WorkBuddy 本地产品配置（48~52 个模型，见下节）。置 `false` 只认上游 37 个 |
| `models.productConfigPath` | 空 = 自动发现 | 产品配置路径；自动发现 `%ACC_PRODUCT_CONFIG_PATH%` → `~/.workbuddy/cache/acc-product-config-v3.json` |
| `models.extraIds` | `[deepseek-v4.1-flash]` | **兜底**：两个目录都没有、但网关可路由的 id；逐个探活，探不通不显示（可用 `WB2API_EXTRA_MODELS` 覆盖） |
| `models.extraMeta` | 见 config.yaml | 兜底条目的元数据（`name` / `contextLength` / `maxOutputTokens` / `vendor` / `supports*`）。**必填**，见下节 |
| `models.probeIntervalSec` | `43200` | 兜底模型的探活结果缓存时长 |
| `logging.capture` | `false` | 打开后按行记 `logs/requests.jsonl`（只有元信息） |

---

## 思考模式（reasoning）

本服务默认注入 `reasoning_effort: "max"`，让上游真的走推理。实测对照（同一个问题）：

| 发出去的字段 | `reasoning_content` | `reasoning_tokens` |
|---|---|---|
| （什么都不发） | **0 字符** | **0** |
| `reasoning_effort: "max"` | 158 字符 | 58 |
| `reasoning: {effort: "max"}` | **0 字符** | **0** |

**关键坑：上游只认顶层蛇形 `reasoning_effort`，不认 `reasoning: {effort}`** ——
后者是 OpenAI SDK / WorkBuddy 客户端内部的结构，客户端会在发出前转成蛇形；
而 DSH 直连本服务，中间没有那层转换，所以必须由 `src/upstream.mjs!applyReasoning` 补。

优先级（显式传的永远赢，不会被配置盖掉）：

1. 客户端已带合法 `reasoning_effort` → 原样使用
2. 客户端带 `reasoning: {effort}` → 转成顶层蛇形
3. 客户端显式 `reasoning: false` / `"off"` / `reasoning_effort: "off"|"none"` → **不注入**（尊重关闭意图）
4. 都没有 → 用 `upstream.reasoningEffort`

> ⚠️ **开了会变慢、多烧 token**：实测同一问题 `total_tokens` 26 → 157（含思考），
> 且上游会先吐一长串思考再出正文。想关掉就把 `reasoningEffort` 留空
> （或设环境变量 `WB2API_REASONING_EFFORT=off`）。

> 💡 响应里的 `usage.completion_tokens_details.reasoning_tokens` 和
> `completion_thinking_tokens` 可以直接验证思考有没有真的生效（没生效时都是 0）。

---

## 模型列表从哪来（两个来源合并）

`/v1/models` 的目录是**合并**出来的，不是单一来源：

| 来源 | 数量 | 作用 |
|---|---|---|
| 上游 `GET /v3/config` | **37** | 兜底 + 增量（上游新增/灰度的模型靠它补进来） |
| 本地产品配置 `~/.workbuddy/cache/acc-product-config-v3.json` | **48~52**（随上游调整浮动） | **权威目录**：字段最全（含 `maxInputTokens` / `maxOutputTokens` / `contextWindow` 档位） |

合并规则：**以本地为准，上游补齐** —— 同 id 冲突取本地（字段更全、桌面端就是按它显示的），
上游独有的照样并入。本机实测 48 + 1 = **49 个**。

也就是说：**不再手抄整份模型清单**。之前那份 11 个的手工差额清单已删，
模型上下线跟着产品配置自动走。

> ⚠️ 本地产品配置是**桌面端自己写的缓存，会被它随时重写**。实测 2026-10-01 就从 52 个变成 48 个，
> `deepseek-v4.1-flash` 被撤下（上游 37 个里本来也没有它）→ 列表里随之消失。
> 这类「网关能路由、但两个目录都不列」的模型，才放 `models.extraIds` 兜底（见下表），
> 靠探活确认可用性。`deepseek-v4.1-flash` 现在就走这条路。

> ⚠️ 上游 `/v3/config` 真的只有 37 个 —— `copilot.tencent.com` 与 `www.workbuddy.cn` 都是 37，
> 换 `X-IDE-Version`（5.6.2/5.6.3/5.7.0/latest）也不变，`/v3/models`、`/v3/product-config`
> 等候选路径全部 404。所以「完全从上游拿」在当前上游能力下做不到，本地产品配置才是那批模型的真源。

响应里带 `catalog` 字段标明来源（`local` / `upstream` / `probe`），
只有靠探活补进来的才会额外带 `"extra": true`。

> ⚠️ 注意 id 拼写：`deepseek-v4.1-flash` 是通的，裸 `deepseek-v4.1` 不存在（上游回 `code=11102`）。

> 📌 `deepseek-v4.1-flash` 的容量（来自产品配置）：`maxInputTokens=1000000`、
> `maxOutputTokens=128000`，页面默认档位 `contextWindow.defaultLength=300000`（**默认档位不是上限**）。

### 客户端会读 / 不会读哪些字段（实测）

影响「DSH 设置页 → 获取可用模型」能采纳到什么，**逐行核对过 pi-ai 的 discovery 解析器**：

| 字段 | DSH 会不会读 | 说明 |
|---|---|---|
| `id` / `name` | ✅ | `name` 缺省回退到 id |
| `context_length`（也认 `context_window` / `max_input_tokens`） | ✅ | 缺失 → 采纳后掉进它自己的 **262144** 默认值 |
| `max_output_tokens`（也认 `max_tokens`） | ✅ | 缺失 → 掉进 **32768** |
| `supports_images` / `modality` / `architecture` | ❌ **完全不读** | 图片能力只能靠 DSH 配置里的 `input` 声明 |

所以本服务对 `extraIds` 兜底条目**必须**填 `models.extraMeta` ——
否则这些条目在 `/v1/models` 里只有 id/name，客户端一采纳就丢容量。

> `supports_images` 仍然如实输出：DSH 不读，但别的 OpenAI 客户端会读。

---

## 目录

```
wb2api/
├─ server.mjs              前台入口（npm run serve）
├─ menu.mjs                交互式控制台
├─ config.yaml             配置
├─ start.bat               双击即用
├─ Dockerfile              容器镜像（node:24-alpine；构建上下文由 .dockerignore 收窄）
├─ docker-compose.yml      编排（默认只绑回环，挂载 data/ logs/ config.yaml）
├─ .dockerignore           镜像上下文排除项（密钥、开发资料、第三方参考源码）
├─ .gitattributes          公开面隔离（export-ignore，见 §公开面）
├─ .github/workflows/      CI：docker.yml 构建并推 ghcr.io + 起容器冒烟
├─ src/
│  ├─ config.mjs           配置加载 + 路径自动发现
│  ├─ crypto.mjs           at-rest sym-v1 信封（AAD 重建 / 加解密）
│  ├─ creds.mjs            取静态密钥 → 解会话 → 续期 → 缓存
│  ├─ upstream.mjs         身份头 / 思考注入 / 模型表 / 流式聊天 / SSE 解析与聚合
│  ├─ catalog.mjs          模型目录发现（本地产品配置 + 上游 /v3/config 合并）
│  ├─ server.mjs           OpenAI 兼容 HTTP 层
│  └─ native/at-rest-key.cjs   在 WorkBuddy.exe 里跑的那一小段取钥脚本
├─ ui/                     浏览器管理台（纯静态：index.html / style.css / app.js）
│                          无构建步骤、无 npm 依赖、无 CDN 外链；由 GET /ui 托管
├─ scripts/
│  ├─ daemon.mjs           npm start / stop / status
│  ├─ creds-cli.mjs        npm run creds
│  ├─ probe.mjs            npm run probe
│  └─ public-snapshot.mjs  npm run public-snapshot（导出公开面快照 + 自检）
├─ test/                   回归测试（开发资料，不入公开面）
│  ├─ errors.test.mjs      假上游：429/5xx/业务错误码、流中断、残行、usage 缺省、状态页
│  ├─ catalog.test.mjs     目录合并：本地为准、上游补齐、文件缺失/损坏要降级
│  ├─ reasoning.test.mjs   思考注入优先级：显式优先于配置、SDK 形状要转蛇形、关闭要尊重
│  ├─ models.test.mjs      兜底模型的合并与探活（心跳首片、探不通要剔除）
│  └─ creds.test.mjs       凭证 single-flight 与 force 语义
├─ docs/                   内部调查报告（开发资料，不入公开面）
│  ├─ architecture.md           整体架构、上游协议、凭证链路、踩坑记录
│  ├─ workbuddy-thinking-multimodal.md  上游思考与多模态能力（全实测）
│  ├─ upstream-rate-limit.md    上游限流 429/6004 专项实测（TPD 日配额、滚动 24h 窗口）
│  ├─ cpa-analysis.md           CLIProxyAPI 的思考/多模态设计调研与对比
│  ├─ cpa-plugin-analysis.md    workbuddy-cpa-plugin 调研（二开基线）
│  ├─ panel-patch-plan.md       CPA 面板补丁实施方案
│  ├─ plugin-build-ci.md        插件构建与发布（CI）
│  └─ subagent-retrospective.md 子代理使用问题复盘
├─ CPA/                    CLIProxyAPI 上游参考源码（浅克隆，不入库；git -C CPA pull 更新）
├─ cpa-plugin/             克隆的 Lxapk/workbuddy-cpa-plugin（Go 写，CPA 插件），二开基线
│                          已剥离其 git 历史；构建产物（dist/、*.so）不入库
├─ cpa-plugin2/            克隆的 zidanefaqih/codebuddy-intl-cpa（Go 写，CPA 插件）
│                          国际版(Global)账号专向，不入库；git -C cpa-plugin2 pull 更新
├─ dsh-plugin/             克隆的 2861292267/DSH-Official-WorkBuddy-Credit-Proxy（DSH 插件）
│                          不入库；git -C dsh-plugin pull 更新
├─ data/                   运行时产物（密钥缓存、会话缓存、pid），不入库
└─ logs/                   运行日志，不入库
```

### 公开面

本仓库将来可能公开。`.gitattributes` 用 `export-ignore` 声明**不入公开面**的路径 ——
本地仓库完整保留，但 `git archive` 导出的归档（含 GitHub "Download ZIP"）会自动剔除：

| 路径 | 为什么不公开 |
|---|---|
| `AGENTS.md` | 开发规范，不得公开 |
| `test/` | 回归测试脚本，属开发资料 |
| `docs/` | 内部调查报告（含上游踩坑与实测数据） |
| `scripts/probe.mjs` | 自检脚本，含本机账号探测逻辑 |

导出并自检：`npm run public-snapshot`（默认输出到 `../wb2api-public`）。
它会逐项检查「该剔除的没漏」「没有 token/API key/私钥」「运行必需的源码都在」，
并对检测规则本身跑反向用例与误报用例 —— **自检不通过就以非 0 退出**，避免误发。

> ⚠️ **`export-ignore` 只影响 `git archive`，不影响 `git push`**。
> 所以公开仓库推的是**快照目录**（`../wb2api-public`，干净历史），
> 而不是本地仓库的 `HEAD` —— 后者含有 `AGENTS.md`/`docs/`/`test/` 的完整提交历史，
> 一旦 push 就能被 `git log -p` 翻出来（实测其中含管理密钥、内网 IP、账号 uid）。
>
> 发版流程：
> ```powershell
> npm run public-snapshot          # 导出并自检
> cd ../wb2api-public
> git add -A; git commit -m "..."; git push
> ```

---

## 错误语义（对外）

| 情况 | 对外表现 |
|---|---|
| 上游 401 / 403 | 原样透传；服务内部先自动换票重试一次 |
| 上游 429 | 原样 429 + 透传 `Retry-After`（不压成 400，客户端才能退避重试） |
| 上游 5xx | 原样透传状态码 |
| 上游 200 + 业务 `code != 0` | 转成 400，错误体里带上游 `code` |
| 上游流中途断开 | 已发的分片保留，追加一条 `data:{"error":…}`，**不发** `[DONE]`（不把截断伪装成正常完成） |
| 上游有 SSE 帧无法解析 | 同上报错；非流式路径返回 502（不返回「200 + 内容被截断」） |
| 上游首片前掐连接 | 在还没往客户端写任何分片时自动重试一次（上游偶发 `terminated`，实测遇到过 1 次） |
| 客户端提前断开 | 立即中止上游请求，不再把整轮 token 烧完 |
| 请求体超 `maxBodyBytes` | 413 JSON（先回包再断连） |
| 上游未上报 usage | 补 `{prompt_tokens:0,completion_tokens:0,total_tokens:0}`，形状与 OpenAI 一致 |

---

## 已知限制

- **上游只收流式**：`stream:false` 会被上游以 `code=11101` 拒绝。本服务因此总是以流式打上游，
  客户端要非流式时在本地聚合（`reasoning_content` / `tool_calls` 分片都会正确拼接）。
- **推理模型**：上游会先吐 `reasoning_content`。`content` 为空时记得回退读它。
- **模型清单依赖本机产品配置**：`/v1/models` = 本地产品配置（48~52 个，会被桌面端重写）+ 上游 `/v3/config`（37 个），
  账号套餐不同、桌面端是否登录过，都会影响看到的模型。没装桌面端时自动降级为上游 37 个。
- **首解依赖桌面端文件**：第一次要能从本机解出凭证（要么桌面端登录过，要么已有 `data/wb-session.json`）。
- **UA / 版本会被校验**：换新版 WorkBuddy 后若上游报 `check ua, get coding copilot version error`，
  把 `upstream.appVersion` 改成新客户端版本号即可。

---

## Docker

```bash
# 1) 先灌凭证（容器内没有 WorkBuddy.exe，解不了桌面端会话文件）
cp data/wb-session.json ./data/          # 从本机 Windows 复制过来

# 2) 起容器
docker compose up -d
# 管理台：http://127.0.0.1:18788/ui/

# 或不用 compose：
docker build -t wb2api .
docker run -d -p 18788:18788 -v ./data:/app/data -v ./logs:/app/logs \
  -e WB2API_HOST=0.0.0.0 wb2api
```

| 要点 | 说明 |
|---|---|
| **凭证必须先灌** | 容器内没有 WorkBuddy.exe 与桌面端会话文件，`data/wb-session.json` 是唯一来源；灌好后由 `refreshToken` 自动续期 |
| **容器内绑 `0.0.0.0`** | 默认只监听回环，端口映射进不来；由 `WB2API_HOST` 环境变量覆盖 |
| **必须挂载 `data/`** | 里面是 `at-rest-key.json`（静态密钥）与 `wb-session.json`（会话），重建容器会丢 |
| **端口默认只绑回环** | `127.0.0.1:18788:18788`。本服务无鉴权，要对外请自行加一层 |
| **镜像在 CI 构建** | 本机无 Docker，`.github/workflows/docker.yml` 构建并推 `ghcr.io/qizhuxu/wb2api`，构建后自动起容器冒烟（`/health` + `/ui` + `/ui/app.js`） |
| **插件也在 CI 构建** | `.github/workflows/plugin.yml` 构建 Linux `.so`（本机只有 MinGW，编不出 Linux 目标），产出 `workbuddy_<ver>_linux_amd64.zip` 供 CPA 插件商店安装 |

公开仓库：<https://github.com/qizhuxu/wb2api>（只含构建/运行必要的源码；
`AGENTS.md`、`docs/`、`test/` 等开发资料不入公开面 —— 见下方「公开面」一节）。

`.dockerignore` 会排除 `data/`、`logs/`、`node_modules/`、`test/`、`docs/`、
`CPA/`、`cpa-plugin*/`、`dsh-plugin/` —— 镜像里只有运行必需的源码。

> ⚠️ `HEALTHCHECK` 只回答「进程是否在服务」（`/health` 恒返回 200，凭证状态在 body 里）。
> 凭证是否可用请看管理台或 `/__wb2api`。

---

## 验证记录

本机实测（Windows，WorkBuddy 5.6.2，Node 24）：

```
$ npm run probe
  ✓ 服务在线 /__wb2api — uid=27442c7b-… 模型 49 个，token 到期 2026-11-25T11:43:56.007Z
  ✓ 模型表 /v1/models — 49 个，默认 auto
  ✓ 流式 /v1/chat/completions — 12731 字节 SSE
  ✓ 非流式 /v1/chat/completions — content="收到" usage=51 tokens
全部通过
```

模型目录实测（不再手抄清单，靠「本地产品配置 + 上游目录 + 兜底探活」拿到）：

```
/v1/models 共 49 个 —— catalog: local 48 / upstream 0 / probe 1
  deepseek-v4-flash    1000000 / 50000   (local)
  deepseek-v4-pro      1000000 / 128000  (local)
  deepseek-v4.1-flash  (probe —— 上游与本地目录都不列，探活确认可路由)
```

思考注入实测（同一问题「9.11 和 9.9 哪个大？」）：

```
不带思考字段          → reasoning_content 0 字符   total_tokens  26
带 reasoning_effort:max → 158 字符                 total_tokens 111   ← 上游认这个
reasoning:{effort:max}  → 0 字符                   total_tokens  26   ← 静默忽略

本服务默认注入后（流式，DSH 真实路径）
  → reasoning_content 445 字符，2.8 秒完成，带 [DONE]

客户端显式 reasoning_effort:"low" → 170 字符（尊重，未被 max 盖掉）
客户端显式 reasoning:false        → 0 字符（尊重关闭意图）
```

另外用官方 `openai` Python SDK（3.16.2）实测：非流式返回内容、流式逐片吐出、工具调用返回
`finish_reason=tool_calls` 且 `arguments` 拼接完整。

回归测试（`npm test`，87 项断言全绿）覆盖：429/5xx/业务错误码映射、Retry-After 透传、
上游流中断不发 `[DONE]`、坏帧不静默丢弃、首片前断流的自动重试、客户端断开中止上游、
`\r\n` 与无换行结尾的残行、`: heartbeat` 注释行、多 choice、`tool_calls` 缺 index / 稀疏 index、
usage 缺省、413、未知路由、根路径状态页、目录合并（本地为准 / 上游补齐 / 文件缺失或损坏要降级）、
思考注入优先级（显式优先于配置 / SDK 形状转蛇形 / 显式关闭要尊重）、
兜底模型的探活（含「首片是心跳」的假阴性、元数据要透传给客户端发现）、凭证 single-flight 与 `force` 语义。

> 收尾做过两轮独立对抗性复核（新鲜上下文，只报影响正确性的 gap；两轮都判定 AAD 重建与
> SSE/聚合主链路正确）。累计 12 处问题已全部修复并被上面的测试覆盖：413 发不出去、状态码压平、
> `force` 被 single-flight 吞掉、并发 401 重复消耗会轮换的 refreshToken、文件回落每次都重拉静态密钥、
> 流中断伪装成完成、usage 为 null、坏帧静默丢数据、`tool_calls` 缺 index 被合并、
> 稀疏 index 产出 `null` 洞、客户端断开后上游仍被读完、上游偶发握手失败无重试。
