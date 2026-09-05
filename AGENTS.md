# AGENTS.md

本文件为参与 `jumyjumy-web` 开发的 AI Agent 与开发者提供统一的工程规范、架构约束与开发指导。

---

## 1. 项目定位与核心愿景

`jumyjumy-web` 是一个面向 Google 搜索引擎索引优化（SEO）的高性能极简英文问答站点（**ONLY English**，全站 UI、元数据与内容均为纯英文）。
全站仅包含两种核心页面类型：
1. **首页**：极简居中的提问 / 搜索框。
2. **问答详情页**：`/q/<slug>-<id>`，提供高质量 Markdown 答案与权威来源引用。

内容由后端 JSON API 提供。**前端负责渲染与 HTTP 语义，后端负责答案生成、去重与持久化**——这条分界线决定了本仓库的绝大部分设计。

---

## 2. 技术栈与运行环境

- **框架**：[Astro 5](https://astro.build/)，`output: 'server'` + `@astrojs/cloudflare`（SSR，跑在 Cloudflare Workers）
- **语言**：TypeScript 5（严格模式 + `verbatimModuleSyntax`）
- **测试框架**：[Vitest](https://vitest.dev/)（纯 Node 环境单测，覆盖 `src/lib/**`）
- **运行时约束**：线上就是 **Cloudflare Workers**，严禁引入 Node.js 专有内置模块（如 `fs`, `path`, `child_process`），只用 Workers 也有的 API（`crypto.subtle`, `fetch`, `TextEncoder`, `Intl.*` 等）。`wrangler.jsonc` 里的 `nodejs_compat` 是给 Astro 自身的 SSR 产物用的，不是在 `src/` 里动用 Node API 的许可。

### 2.1 为什么必须是 SSR，而不是静态构建

这是本项目最重要的架构决策，改动前务必理解。静态构建做不到以下三件事：

1. **真实状态码**。标题优化会改变 slug，旧 URL 必须 301 到规范路径，否则外链权重丢失；问题不存在必须发真 404，返回 200 空页即 soft 404，拖累全站抓取预算。
2. **页面先于构建存在**。用户提问持续产出新页面，`getStaticPaths()` 会把页面集合冻结在 build 那一刻。
3. **按请求判定索引**。`status` 与 `demoted` 会随时间翻转，静态构建会把 `noindex` 焊死进 HTML 直到下次部署。

### 2.2 依赖版本约束

`@astrojs/cloudflare` 必须停留在 **12.x**：13.x 要求 Astro 6，14.x 要求 Astro 7，而本项目基于 Astro 5。不带版本号执行 `npm install @astrojs/cloudflare` 会 ERESOLVE 失败。

---

## 3. 目录架构与职责划分

```text
jumyjumy-web/
├── public/                 # 静态资源 (favicon, robots.txt 等)
├── src/
│   ├── components/         # 品牌与通用 UI 组件 (Logo.astro 等)
│   ├── layouts/            # 页面骨架（HTML 头、SEO Meta、canonical、样式引用）
│   ├── lib/                # 核心领域逻辑（纯函数、零外部依赖、高单测覆盖）
│   │   ├── __tests__/      # Vitest 单元测试
│   │   ├── api.ts          # 后端契约：URL 构造、信封解包与词汇翻译、载荷校验、规范路径判定、取数
│   │   ├── slug.ts         # URL 生成、路径编码与 base36 id 解析
│   │   ├── markdown.ts     # 默认转义、防 XSS 的 Markdown 渲染器
│   │   ├── json-ld.ts      # 结构化数据内联转义（防 </script> 逃逸）
│   │   └── types.ts        # 领域数据模型定义
│   ├── pages/              # Astro 路由（index.astro, q/[slugId].astro）
│   └── styles/             # 全局极简 CSS 变量与 Typography 样式
├── .env / .env.example     # 后端 endpoint 配置
├── astro.config.mjs        # Astro 配置 + astro:env 环境变量 schema
├── package.json            # 依赖与脚本定义
├── tsconfig.json           # TS 编译配置
└── vitest.config.ts        # 单测配置
```

### 3.1 请求生命周期

```text
浏览器  GET /q/<query>
   -> Astro SSR   GET <API_BASE_URL>/q/<query>   [JSON]
   -> 200 渲染 | 301 规范路径 | 404 不存在 | 502 后端故障
```

`<query>` 既可能是 `<slug>-<id>`，也可能是首页提交的提问原文——两者走同一条路径，由后端解析，前端负责在结果与请求路径不一致时 301。

---

## 4. 核心领域准则 (Domain Invariants)

所有修改 `src/lib/` 代码的操作必须严格遵守以下业务与架构不变量：

### 4.1 后端契约与不可信输入 (`api.ts`)
- **路径编码**：`<query>` 直接来自 URL，是用户可控输入。必须 `encodeURIComponent` 压成单个 path segment，否则 `/q/../../internal/admin` 构成路径穿越。
- **信封与词汇翻译**：后端所有响应都包在 `{ success, data, error }` 里。`parseQuestionPayload` 接收的是**整个信封**而非 `data`——`success` 是契约的一部分，跳过它等于把一条失败响应当成内容渲染。两侧词汇不同，翻译只发生在本模块：`data.query` → `title`、`data.text` → `answerMarkdown`、`sources[].uri` → `sources[].url`。页面层只认识领域模型。
- **载荷校验**：后端返回的 JSON 一律视为不可信数据。必需字段（`id` / `query` / `status`）不合规即整体拒绝，宁可报错也不渲染半个页面。`status` 必填且不设默认值——它决定是否 `noindex`，缺省成任何一个值都是错的。
- **错误分型**：取数结果用判别联合 `ok | notFound | error`，页面层**必须**区分「不存在」（404）与「后端故障」（502）。两者混为一谈会产生 soft 404，或让已收录页面被误剔出索引。后端的 `400`（空问题、超长、被上游拒答）归入 `notFound`：这类 URL 永远不会成立，发 502 只会让爬虫无限重试一个死链。
- **副作用注入**：`fetch` 以参数传入而非 import，保证模块可单测且不绑定运行时。

### 4.2 URL 结构与永久主键 (`slug.ts`)
- **路径结构**：`/q/<slug>-<id>`。
- **永久主键**：末尾 6 位 base36 字符为永久唯一 ID；前置 `slug` 仅作语义装饰。
- **ID 的来源**：id 由后端对规范化查询词取 SHA-256 指纹后推导，而非随机生成——同一个问题永远得到同一个 id，即使后端的落库文件（`[q].store_path`，默认 `data/questions.jsonl`）丢失后被重新提问，已被搜索引擎收录的 URL 依然指向同一个页面。反过来说，那个文件丢了会让所有已收录的 `/q/<slug>-<id>` 集体 404，直到同样的问题被重新问一遍。
- **CTR 优化友好**：随时优化标题导致 slug 改变时，通过 301 永久重定向至最新规范路径，绝对不丢失外链权重。
- `parseSlugId` 刻意宽松匹配；**存在性由后端判定**，不是解析器的职责。
- **编码边界**：`toSlug` 保留 CJK（中文 slug 对中文检索是加分项），但这样的路径不能原样进 HTTP 头——头部值是 ByteString，`开`（U+5F00）会让 `new Response` 抛 `TypeError`，整页 500。因此 `encodePath` 只在「路径变成 URL」这一步使用；`resolveCanonicalRedirect` 的**比较仍在解码态进行**，否则含 CJK 的规范 URL 会不停 301 到它自己。

### 4.3 安全基线：后端投毒防线
后端返回的一切内容都是不可信输入。以下三道防线不得削弱：
1. `sources[].uri` 在 `parseQuestionPayload` 中翻译为 `url` 的同时做协议白名单（仅 http/https）——详情页把它原样写进 `<a href>`，这是唯一防线。
2. 答案正文一律经 `renderAnswer` 渲染，严禁把原始 Markdown 交给 `set:html`。
3. 结构化数据一律经 `toInlineJsonLd`，严禁裸用 `JSON.stringify`。后者会让载荷中的 `</script>` 提前闭合 `<script type="application/ld+json">`，其后内容按 HTML 解析，构成完整注入点。

### 4.4 数据只读不可变 (`types.ts`)
- 所有领域模型字段均为 `readonly`（如 `readonly sources: readonly Source[]`）。
- 严禁对领域对象进行原地（in-place）属性修改，必须使用不可变派生（`{ ...question, ... }`）。

---

## 5. 配置与环境变量

`API_BASE_URL` 在 `astro.config.mjs` 的 `env.schema` 中通过 `envField.string` 声明，页面以 `import { API_BASE_URL } from 'astro:env/server'` 读取。

`access: 'secret'` 是**功能性选择而非保密声明**：只有 secret 才在运行时从 `process.env` 解析；`access: 'public'` 会把值内联进构建产物，换环境就得重新构建。

取值来源（已实测）：

| 运行方式 | 来源 |
| :--- | :--- |
| `astro dev` / `astro build` | `.env` |
| 线上 Worker | `wrangler secret put API_BASE_URL` 设置的 secret；适配器按请求把 `env.schema` 里的每个键拷进 `process.env` |
| `wrangler dev` | `.dev.vars`，**不读** `.env` |
| 都没有 | schema `default`，`http://localhost:3000` |

该值**不写入** `wrangler.jsonc` 的 `vars`。本仓库已公开，而 `vars` 是明文的：把后端源站提交进去，等于公开一个无鉴权、每次调用都消耗模型额度的入口。只有 secret 既能留在树外，又能按请求进入 `process.env`。都没配置时 `/q/*` 会全部 502——那是配置缺失的预期表现，不是 bug。

---

## 6. 开发与编码规范

1. **类型安全**：开启 `verbatimModuleSyntax`，所有纯类型导入必须显式标注 `import type { ... } from '...'`。
2. **纯粹性与解耦**：`src/lib/` 内的模块必须无副作用；I/O 以参数注入，不得 import。严禁耦合 Astro 上下文或 DOM API。
3. **注释规范**：`src/lib/` 内的重要逻辑注释使用**中文**编写，重点解释**为什么存在此项业务/SEO/安全约束**，而非复述代码字面逻辑。
4. **测试驱动 (TDD)**：
   - 测试遵循 Arrange-Act-Assert (AAA) 结构。
   - 测试用例命名应具有强行为语义（如 `'returns error instead of throwing when the backend is unreachable'`）。
   - 新增领域特性必须补齐覆盖率（`src/lib/**` 不低于 80%）。
   - Vitest 仅在 node 环境收集 `src/**/*.test.ts`，**`.astro` 文件不被覆盖**——需要测试的逻辑一律下沉到 `src/lib/`。

---

## 7. 常用命令清单

```bash
npm run dev        # 启动本地开发服务 (http://localhost:4321，读取 .env)
npm run build      # 生产打包 (输出到 dist/)
npm run preview    # wrangler dev —— 用 workerd 跑打包产物（需先 build）
npm run deploy     # astro build && wrangler deploy —— 发布到 Cloudflare Workers
npm run check      # Astro TS 与模板语法检查
npm test           # 执行 Vitest 单元测试
npm run test:watch # Vitest 监听模式
npx vitest run --coverage   # 覆盖率（scoped to src/lib/**）
```

无后端运行时：`/` 仍返回 200（预渲染），`/q/*` 返回 502。

### 7.1 部署（Cloudflare Workers）

线上地址 `https://www.jumyjumy.com`，配置全在 `wrangler.jsonc`。构建产物一分为二，二者都在该文件里点名：

- `dist/_worker.js/index.js` —— SSR 入口（`main`）。
- `dist/` 其余文件 —— 静态资源（`assets.directory`）。首页是 `prerender`，因此 `/` 由资源层直接返回、不唤醒 Worker；`/q/*` 匹配不到资源才落到 SSR。

`public/.assetsignore` 是功能性的，不是整洁强迫症：服务端 bundle 就躺在资源目录里，而 Workers **不会**像 Pages 那样自动排除 `_worker.js`——实测不写这个文件时 `GET /_worker.js/index.js` 返回 **200 并吐出整个服务端 bundle**。它放在 `public/` 而不是 `dist/`，因为 `astro build` 每次都会重建 `dist/`，写在那里会被删掉。`_routes.json` 同理排除：那是适配器给 Pages 生成的，Workers 根本不读，对外提供只是白送路由表。

`compatibility_date` 对齐本地 `workerd` 版本，避免 `wrangler dev` 告警并降级；往前挪是运行时行为变更，要单独验证，别顺手改。

---

## 8. 变更自检清单 (Agent PR Checklist)

在提交任何代码变更前，Agent 必须确认：
- [ ] `npm test` 全部通过（零失败测试）。
- [ ] `npm run check` 无类型与模板错误。
- [ ] `npm run build` 成功。
- [ ] `src/lib/**` 覆盖率不低于 80%。
- [ ] 未引入任何破坏 Cloudflare Workers 兼容性的 Node 原生模块。
- [ ] 涉及 `src/lib/` 的修改附带了清晰阐释约束原因的中文注释。
- [ ] 触及渲染路径时，§4.3 三道安全防线未被削弱。
- [ ] 触及 `/q/` 路由时，404 / 502 / 301 四种响应语义未被混淆。
- [ ] 页面结构符合极简设计要求（首页单提问框，问答页高效易读）。
