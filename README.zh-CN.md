<div align="center">

# jumyjumy-web

**面向 Google SEO 优化的高性能 AI Agent 搜索前端**

[English](README.md) • [简体中文](README.zh-CN.md)

<br />

[![Astro](https://img.shields.io/badge/Astro-5.x-BC52EE?style=flat-square&logo=astro&logoColor=white)](https://astro.build/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vitest](https://img.shields.io/badge/Vitest-3.x-6E9F18?style=flat-square&logo=vitest&logoColor=white)](https://vitest.dev/)
[![License](https://img.shields.io/badge/License-All_Rights_Reserved-red?style=flat-square)](#版权与许可)

</div>

---

## 📖 项目简介

**[jumyjumy.com](https://www.jumyjumy.com)** 是一个 AI Agent 搜索引擎平台。用户输入自然语言问题，自主智能体（Agent）进行全网检索与整合研究，输出结构清晰、带有权威信源引用的单一高质回答。每个问答都会生成一个永久且稳定的独立 URL——可被搜索引擎收录索引、便于引用传播。

本仓库是站点的**前端系统**：基于 Astro 构建并运行在 Cloudflare Workers 边缘网络上，全权负责服务端渲染 (SSR)、HTTP 响应语义控制与严格的安全边界防护。负责检索与生成答案的 AI Agent 为独立后端服务，不包含在本仓库中。

---

## ✨ 核心亮点

- **⚡ 边缘原生 SSR (Edge-Native SSR)**：运行在 Cloudflare Workers 边缘网络，实现毫秒级边缘路由匹配与极速首屏交付。
- **🎯 极致 SEO 索引精准度 (SEO-First)**：发出完全真实的 HTTP 状态码（`200`、`301`、`404`、`502`），杜绝软 404（Soft 404），坚决保护 Google 抓取预算与外链权重。
- **⏳ 零等待骨架路由机制 (Zero-Latency Skeleton Routing)**：新问题请求即刻返回 `noindex` 骨架屏，将 TTFB 与上游模型推理耗时彻底解耦；同时阻止搜索引擎爬虫触发高昂的模型计算开销。
- **🛡️ 纵深防御基线 (Defense-in-Depth Security)**：权威信源严格协议白名单（仅限 `http`/`https`）、Markdown 默认转义防 XSS 注入、结构化数据 (JSON-LD) 防 `</script>` 逃逸攻击。
- **📦 零外部依赖的领域核心 (Pure Domain Core)**：`src/lib/` 内部纯函数设计、零外部运行时依赖、与运行时解耦，配备高覆盖率的纯单测保障。

---

## 🔄 运行机制与请求生命周期

全站仅包含两种核心用户页面类型：

1. **首页提问框** (`/`) — 极简居中的提问界面，在边缘侧预渲染（Prerendered）为静态 HTML。
2. **问答详情页** (`/q/<slug>-<id>`) — 特定问题的规范、可收录详情页。

此外存在一个过渡态路由：在全新答案生成期间由详情路由内部重写渲染的 `noindex` 骨架屏。

### 请求生命周期与路由架构

```text
1. 规范问答流 (直接访问或爬虫抓取):
   浏览器 ──GET /q/<slug>-<id>──> [ Astro SSR ] ──GET /q/<slug>-<id>──> [ 后端 API ]
                                         │                                      │
                                         ├─ 200 OK (渲染完成的 HTML) <──────────┘
                                         ├─ 301 永久重定向 (标题优化 / 规范化路径)
                                         ├─ 404 Not Found (问题不存在)
                                         └─ 502 Bad Gateway (后端上游故障)

2. 新问题提问流 (用户提交未经生成的问题原文):
   浏览器 ──GET /q/<raw-query>──> [ Astro SSR ] (内部重写至骨架屏，URL 保持不变)
      │                                  │
      │                                  └─ 200 OK (即刻返回 noindex 骨架屏)
      │
      ├── 瞬时响应：浏览器展示加载骨架，并在客户端发起异步轮询
      └── 客户端请求 ──GET /api/q/<raw-query>──> [ Astro SSR ] ──> [ 后端 API ]
                                                         │                  │
                                                         └── 200 { path } ──┘
                                                                 │
      客户端执行：location.replace(path) ─────────────────────────┘
      (平滑跳转至永久规范详情页)
```

> [!NOTE]
> **为何解耦新问题的服务端渲染？**
> 提问新问题意味着需要调用上游大语言模型。如果让 SSR 同步等待模型推理，首字节到达时间（TTFB）将被模型延迟完全绑架；一旦超时或失败，正常提问也会直接报错 502。
> 通过即刻返回 `noindex` 骨架屏：
> 1. 真实用户能获得零延迟的视觉反馈，并在客户端平滑轮询。
> 2. 爬虫机器人（通常不执行异步脚本）不会执行轮询，从而避免触发无效且昂贵的大模型推理，同时有效节省全站抓取预算。

---

## ⚡ 为什么必须是服务端渲染 (SSR)？

采用 `output: 'server'` 是刻意的架构设计决策，而非过渡方案。静态网站生成（`getStaticPaths()`）在设计上无法满足以下关键需求：

- **真实 HTTP 状态码与规范路径权重**：标题优化会改变 slug，旧 URL 必须发出 `301 Moved Permanently` 永久重定向至最新规范路径，否则外链权重丢失；问题不存在必须返回真实 `404`，若返回 `200` 空页面即为软 404（Soft 404），严重拖累全站抓取预算。
- **页面先于构建而存在**：全站依靠用户持续提问产生新问答，静态构建会在 build 那一刻将页面集合彻底冻结。
- **按单次请求动态判定索引**：问答状态（`status` 与 `demoted`）会随时变更；静态构建会将 `noindex` 写入死 HTML 直到下次重新打包部署。

---

## 🛠️ 技术栈

| 模块 | 技术选型 | 说明 |
| :--- | :--- | :--- |
| **基础框架** | [Astro 5](https://astro.build/) | `output: 'server'`，配合 Cloudflare 适配器 |
| **边缘运行时** | [Cloudflare Workers](https://workers.cloudflare.com/) | 依赖 `@astrojs/cloudflare`（锁定 12.x 版本） |
| **开发语言** | [TypeScript 5](https://www.typescriptlang.org/) | 严格模式，启用 `verbatimModuleSyntax` |
| **单元测试** | [Vitest](https://vitest.dev/) | 纯 Node 隔离环境快速测试 |
| **运行时依赖** | 零外部依赖 (Zero Dependencies) | `src/lib/` 内部核心领域逻辑纯原生 |

> [!IMPORTANT]
> 代码必须严格受限于 Cloudflare Workers 原生 API 范围（`fetch`、`crypto.subtle`、`TextEncoder`、`Intl.*` 等）。严禁在 `src/` 中引入 Node.js 专属模块（如 `fs`、`path`、`child_process` 等）。`wrangler.jsonc` 中的 `nodejs_compat` 仅供 Astro 自身的 SSR 构建产物运行。

---

## 🚀 快速开始

### 环境依赖

- **Node.js 22+**（`wrangler` 强制要求；Astro 核心本身兼容 18.20.8+）
- 可正常通信的后端 JSON API 服务（契约规范见后文）

### 本地启动

```bash
# 1. 克隆代码仓库并安装依赖
git clone https://github.com/sjmdsky/jumyjumy-web.git
cd jumyjumy-web
npm install

# 2. 配置本地环境变量
cp .env.example .env
# 编辑 .env 配置后端 API_BASE_URL (与可选的 GATEWAY_TOKEN)

# 3. 启动本地开发服务
npm run dev
# 本地服务运行于 http://localhost:4321
```

> [!TIP]
> 当本地未启动后端服务时，访问首页 `/` 依然返回 `200`（因为首页为预渲染静态资源），而访问任意 `/q/*` 详情页将返回 `502 Bad Gateway`。这是由于配置缺失或上游不可达时的正常符合预期表现。

### 脚本命令清单

| 命令 | 用途说明 |
| :--- | :--- |
| `npm run dev` | 启动本地 Astro 开发服务 (`:4321`)，自动读取 `.env` |
| `npm run build` | 编译构建生产环境客户端资源与 Worker 产物至 `dist/` |
| `npm run preview` | 使用 `wrangler dev` (workerd 引擎) 运行本地构建产物 |
| `npm run deploy` | 自动化执行打包并发布上线至 Cloudflare Workers |
| `npm run check` | 执行 `astro check` 进行 TypeScript 及模板语法诊断 |
| `npm test` | 单次运行全部 Vitest 单元测试 |
| `npm run test:watch` | 进入 Vitest 交互式监听与持续测试模式 |

---

## ⚙️ 环境变量与密钥配置

环境变量在 `astro.config.mjs` 中通过 `astro:env` 强类型 schema 声明，并在服务端页面中以 `import { ... } from 'astro:env/server'` 安全引用：

| 变量名 | 必填 | 默认值 | 作用说明 |
| :--- | :---: | :--- | :--- |
| `API_BASE_URL` | 否 | `http://localhost:3000` | 后端 JSON API 服务的根地址。 |
| `GATEWAY_TOKEN` | 否 | *无* | 网关通信共享密钥，在发送 `x-gateway-token` 鉴权以及透传访客真实 IP 时使用。 |

### 不同运行方式的配置来源

| 运行环境 | 配置读取来源 |
| :--- | :--- |
| `astro dev` / `astro build` | `.env` |
| `wrangler dev` (本地 workerd 预览) | `.dev.vars`（**不读取** `.env`） |
| 生产 Cloudflare Workers | `wrangler secret put <NAME>` 设置的边缘 Secret |
| 未设置时的回退 | Schema 默认值（`API_BASE_URL`）或缺省（`GATEWAY_TOKEN`） |

> [!NOTE]
> 在 `astro.config.mjs` 中使用 `access: 'secret'` 属于功能性选择而非纯机密声明：只有 secret 才能在**运行时**动态从 `process.env` 获取。若选用 `access: 'public'`，变量值会被直接内联至打包静态代码中，导致更换环境必须重新执行 build 打包。
> 
> 请勿将密钥填入 `wrangler.jsonc` 的 `vars` 字段，该文件为明文版本受控文件。

---

## 📂 目录架构

```text
jumyjumy-web/
├── public/
│   ├── .assetsignore             # 极重要: 强制 Worker 静态资源排除 _worker.js 服务端产物
│   ├── favicon.svg               # 站点图标
│   └── robots.txt                # 搜索引擎爬虫协议规则
├── src/
│   ├── components/               # 品牌视觉与全局 UI 组件 (如 Logo.astro)
│   ├── layouts/                  # 基础页面骨架、SEO 元信息、JSON-LD 注入
│   ├── lib/                      # 核心领域逻辑 (纯函数、无依赖、高单测覆盖率)
│   │   ├── __tests__/            # Vitest 单元测试套件
│   │   ├── api.ts                # 后端通信契约、信封解析与映射、校验、规范重定向判定
│   │   ├── slug.ts               # /q/<slug>-<id> 路径解析、Base36 ID 与 URL 编码
│   │   ├── markdown.ts           # 默认转义的高安全 Markdown 渲染器 (支持 GFM 表格)
│   │   ├── json-ld.ts            # 安全转义的结构化数据嵌入工具 (防 script 逃逸)
│   │   ├── datetime.ts           # 客户端与服务端统一的时间戳本地化格式化工具
│   │   └── types.ts              # 领域模型定义 (所有字段均为 readonly 不可变)
│   ├── pages/
│   │   ├── index.astro           # 首页提问框 (预渲染静态资源)
│   │   ├── q/[slugId].astro      # 问答详情页 (SSR 服务端渲染)
│   │   ├── q/pending/[query].astro # 过渡态 noindex 骨架屏
│   │   └── api/q/[segment].ts    # 骨架屏异步轮询专用端点
│   └── styles/                   # 极简全局样式变量与 Typography 规则
├── astro.config.mjs              # Astro 配置与 astro:env 校验 schema
├── package.json                  # 项目依赖与运行脚本
├── tsconfig.json                 # TypeScript 严格编译规则
├── vitest.config.ts              # Vitest 单测运行配置
└── wrangler.jsonc                # Cloudflare Workers 部署配置
```

---

## 🧪 单元测试与质量保障

```bash
# 执行全部测试套件
npm test

# 针对特定文件执行测试
npx vitest run src/lib/__tests__/slug.test.ts

# 针对特定测试用例正则运行
npx vitest run -t 'escapes < so an embedded </script> cannot close the tag'

# 统计测试覆盖率 (限制在 src/lib/** 核心逻辑层)
npx vitest run --coverage
```

- **纯正的单测设计**：Vitest 仅在 Node 环境中高速运行，无需启动昂贵的 `jsdom`。
- **架构职责分界**：`.astro` 文件不参与 Vitest 收集；所有业务与算法逻辑必须统一下沉到 `src/lib/` 进行可靠测试。
- **严格遵循 AAA 范式**：测试用例遵循 Arrange-Act-Assert（准备-执行-断言）结构，并使用具有明确行为描述的用例名称（如 `'returns error instead of throwing when the backend is unreachable'`）。

---

## 🚢 发布部署到 Cloudflare Workers

项目通过 `wrangler` 部署上线至 Cloudflare Workers：

```bash
npm run deploy
```

构建生成的两部分产物由 `wrangler.jsonc` 显式分配：
1. `dist/_worker.js/index.js` — SSR 服务端入口（`main`）。
2. `dist/` 静态目录 — 静态客户端资产（`assets.directory`）。

> [!IMPORTANT]
> **`public/.assetsignore` 的防御意义：**
> 在 Workers 架构中，静态资产优先级高于 Worker 脚本路由。服务端代码包（`_worker.js`）恰好位于打包生成的资源目录中。如果没有该忽略文件，Cloudflare Workers 会在收到 `GET /_worker.js/index.js` 请求时直接作为静态文本吐出整个服务端源码！该文件放置在 `public/` 目录下，以防每次 `astro build` 清理 `dist/` 时被误删。

### 私有化部署流程

1. 修改 [wrangler.jsonc](file:///home/debian/workspace/jumyjumy-web/wrangler.jsonc) 中的 `name` 与自定义路由 `routes`。
2. 修改 [astro.config.mjs](file:///home/debian/workspace/jumyjumy-web/astro.config.mjs) 中的 `site` 域名配置。
3. 在 Cloudflare 设置生产环境变量与安全密钥：
   ```bash
   wrangler secret put API_BASE_URL
   wrangler secret put GATEWAY_TOKEN    # 可选：后端鉴权与真实 IP 透传令牌
   ```
4. 执行发布：
   ```bash
   npm run deploy
   ```

---

## 📄 版权与许可

**All rights reserved.** 版权所有 © 2026 [jumyjumy.com](https://www.jumyjumy.com)。

本仓库源代码发布仅供阅读、学习和技术研究参考。未获授权严禁擅自使用、复制、修改或重新分发，且严禁任何形式的商业用途。唯一的例外是 GitHub [服务条款](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)赋予公开仓库访问者的既定权限：在 GitHub 平台内浏览代码与 Fork 仓库。

欢迎在 GitHub Issues 提出技术交流与建议。由于目前尚未设立贡献者许可协议（CLA），暂不接受 Pull Request。
