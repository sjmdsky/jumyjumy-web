<div align="center">

# jumyjumy-web

**High-performance, SEO-first frontend for AI Agent Search.**

[English](README.md) • [简体中文](README.zh-CN.md)

<br />

[![Astro](https://img.shields.io/badge/Astro-5.x-BC52EE?style=flat-square&logo=astro&logoColor=white)](https://astro.build/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vitest](https://img.shields.io/badge/Vitest-3.x-6E9F18?style=flat-square&logo=vitest&logoColor=white)](https://vitest.dev/)
[![License](https://img.shields.io/badge/License-All_Rights_Reserved-red?style=flat-square)](#license)

</div>

---

## 📖 Overview

**[jumyjumy.com](https://www.jumyjumy.com)** is an AI Agent Search platform. Users ask a question in natural language; an autonomous agent performs research and produces a single, well-sourced, authoritative answer. Every answer is published at a permanent, stable URL — indexable by search engines, citeable, and linkable.

This repository hosts the **frontend**: an Astro application running on Cloudflare Workers that handles server-side rendering (SSR), HTTP semantics, and strict security boundaries. The AI agent that researches and synthesizes answers lives in a separate backend service.

---

## ✨ Key Highlights

- **⚡ Edge-Native SSR**: Powered by Cloudflare Workers for sub-millisecond edge routing and ultra-fast global delivery.
- **🎯 SEO & Indexation Precision**: Emits strictly truthful HTTP status codes (`200`, `301`, `404`, `502`) to optimize Google crawl budget and protect link equity.
- **⏳ Zero-Latency Skeleton Routing**: New model queries instantly render a `noindex` skeleton on the client side, isolating TTFB from AI generation latency and stopping search bots from triggering costly LLM runs.
- **🛡️ Defense-in-Depth Security**: Strict protocol whitelisting (`http`/`https` only), default-escaped Markdown parsing, and script-tag injection guards on JSON-LD structured data.
- **📦 Pure Domain Core**: `src/lib/` is completely pure, dependency-free, runtime-agnostic, and thoroughly unit-tested.

---

## 🔄 How It Works

The site consists of two user-facing page types:

1. **The Ask Box** (`/`) — A minimalist, centered query interface prerendered to static HTML at the edge.
2. **The Answer Page** (`/q/<slug>-<id>`) — The canonical, indexable document for a specific question.

A transitional route also exists: a lightweight `noindex` skeleton that the router renders while a brand-new answer is being synthesized.

### Request Lifecycle & Routing

```text
1. Canonical Question Flow (Direct or Crawled):
   Browser ──GET /q/<slug>-<id>──> [ Astro SSR ] ──GET /q/<slug>-<id>──> [ Backend API ]
                                         │                                      │
                                         ├─ 200 OK (Rendered HTML) <────────────┘
                                         ├─ 301 Moved Permanently (Slug retitled / Canonical)
                                         ├─ 404 Not Found (Question nonexistent)
                                         └─ 502 Bad Gateway (Backend failure)

2. Raw Question Flow (User submitting a new prompt):
   Browser ──GET /q/<raw-query>──> [ Astro SSR ] (Internal rewrite to noindex skeleton)
      │                                  │
      │                                  └─ 200 OK (Instant skeleton, URL unchanged)
      │
      ├── Immediate UI: Loading skeleton rendered; client-side polling starts
      └── Client Fetch ──GET /api/q/<raw-query>──> [ Astro SSR ] ──> [ Backend API ]
                                                         │                  │
                                                         └── 200 { path } ──┘
                                                                 │
      Client: location.replace(path) ────────────────────────────┘
      (Redirects to permanent canonical URL)
```

> [!NOTE]
> **Why decouple raw question rendering?**
> A new question requires upstream LLM inference. Blocking SSR on inference would tether Time-To-First-Byte (TTFB) directly to model latency. Slow responses or timeouts would surface as `502` errors for valid queries. 
> By immediately serving a `noindex` skeleton:
> 1. Real visitors experience immediate visual feedback while polling asynchronously.
> 2. Web crawlers (which do not execute JavaScript) never execute polling scripts, eliminating unnecessary model consumption and saving crawl budget.

---

## ⚡ Why Server-Side Rendering (SSR)?

Using `output: 'server'` is an intentional architectural requirement. A static site generator (`getStaticPaths()`) fundamentally cannot satisfy these requirements:

- **True Status Codes & Canonical Redirects**: Updating a title changes the slug. Old URLs must issue a permanent `301 Moved Permanently` to pass link equity. Non-existent queries must return a genuine `404 Not Found`; returning a `200` with an empty state constitutes a *soft 404*, which harms crawl budget.
- **Dynamic Content Lifecycle**: Answers are generated continuously on demand. Static generation would freeze available pages to build time.
- **Per-Request Indexing Signals**: Question state (`status`, `demoted`) can change at any moment. SSR allows dynamic toggling of `<meta name="robots" content="noindex">` on every request without requiring a full redeployment.

---

## 🛠️ Tech Stack

| Component | Technology | Description |
| :--- | :--- | :--- |
| **Framework** | [Astro 5](https://astro.build/) | `output: 'server'` with Cloudflare adapter |
| **Runtime** | [Cloudflare Workers](https://workers.cloudflare.com/) | `@astrojs/cloudflare` (12.x pinned) |
| **Language** | [TypeScript 5](https://www.typescriptlang.org/) | Strict mode with `verbatimModuleSyntax` |
| **Testing** | [Vitest](https://vitest.dev/) | Unit tests in pure Node environment |
| **Dependencies** | None (Zero Runtime) | `src/lib/` has 0 external runtime dependencies |

> [!IMPORTANT]
> All code must stay strictly within the Cloudflare Workers runtime API (`fetch`, `crypto.subtle`, `TextEncoder`, `Intl.*`). Do not import Node.js built-ins (`fs`, `path`, etc.) into `src/`. The `nodejs_compat` flag in `wrangler.jsonc` is strictly for Astro's internal SSR bundle.

---

## 🚀 Getting Started

### Prerequisites

- **Node.js 22+** (required by `wrangler`; Astro itself supports 18.20.8+)
- Backend API running or accessible (contract detailed below)

### Quick Start

```bash
# 1. Clone the repository and install dependencies
git clone https://github.com/sjmdsky/jumyjumy-web.git
cd jumyjumy-web
npm install

# 2. Configure environment variables
cp .env.example .env
# Edit .env to set API_BASE_URL (and optional GATEWAY_TOKEN)

# 3. Start local development server
npm run dev
# Server running at http://localhost:4321
```

> [!TIP]
> When running without an active backend, `/` returns `200` (prerendered static asset), while `/q/*` routes return `502 Bad Gateway`. This is expected behavior indicating missing backend connectivity.

### Command Reference

| Command | Action |
| :--- | :--- |
| `npm run dev` | Starts local dev server at `localhost:4321` (reads `.env`) |
| `npm run build` | Builds the client assets and Worker bundle to `dist/` |
| `npm run preview` | Runs production bundle locally using `wrangler dev` (workerd) |
| `npm run deploy` | Builds and deploys directly to Cloudflare Workers |
| `npm run check` | Runs `astro check` for TypeScript and `.astro` diagnostics |
| `npm test` | Runs all Vitest unit tests |
| `npm run test:watch` | Starts Vitest in interactive watch mode |

---

## ⚙️ Configuration & Secrets

Environment variables are declared in `astro.config.mjs` via `astro:env` and consumed in server code via `astro:env/server`:

| Variable | Required | Default | Description |
| :--- | :---: | :--- | :--- |
| `API_BASE_URL` | No | `http://localhost:3000` | Base URL of backend JSON API. |
| `GATEWAY_TOKEN` | No | *None* | Shared secret sent via `x-gateway-token` to authenticate gateway and visitor IP forwarding. |

### Environment Resolution

| Mode / Environment | Configuration Source |
| :--- | :--- |
| `astro dev` / `astro build` | `.env` |
| `wrangler dev` (Local preview) | `.dev.vars` (ignores `.env`) |
| Production Cloudflare Worker | `wrangler secret put <NAME>` |
| Unset Fallback | Schema default (`API_BASE_URL`), or omitted (`GATEWAY_TOKEN`) |

> [!NOTE]
> `access: 'secret'` in `astro.config.mjs` is a functional mechanism rather than a secrecy label: it is the only mode that reads values at **runtime** from `process.env`. Using `access: 'public'` would bake values into the build output, forcing a rebuild across environments.
> 
> Neither key is stored in `wrangler.jsonc` `vars` because that configuration is committed in plain text.

---

## 📂 Project Structure

```text
jumyjumy-web/
├── public/
│   ├── .assetsignore             # CRITICAL: Excludes _worker.js from public static assets
│   ├── favicon.svg               # Site icon
│   └── robots.txt                # Crawler directives
├── src/
│   ├── components/               # Brand & shared UI components (Logo.astro, etc.)
│   ├── layouts/                  # Base layout, HTML skeleton, SEO meta, JSON-LD
│   ├── lib/                      # Pure domain layer (100% testable, zero side effects)
│   │   ├── __tests__/            # Vitest unit test suites
│   │   ├── api.ts                # Backend contract, envelope parsing, validation, fetch
│   │   ├── slug.ts               # /q/<slug>-<id> parser, base36 IDs, canonical URL logic
│   │   ├── markdown.ts           # Safe GFM markdown renderer with table support
│   │   ├── json-ld.ts            # Safe inline JSON-LD generator (anti-XSS)
│   │   ├── datetime.ts           # Client & server unified timestamp formatter
│   │   └── types.ts              # Readonly domain type definitions
│   ├── pages/
│   │   ├── index.astro           # The ask box (prerendered static HTML)
│   │   ├── q/[slugId].astro      # Canonical answer page (SSR)
│   │   ├── q/pending/[query].astro # Transitional noindex skeleton
│   │   └── api/q/[segment].ts    # Client polling endpoint for skeleton
│   └── styles/                   # Minimal typography and CSS variable tokens
├── astro.config.mjs              # Astro configuration + astro:env schema
├── package.json                  # Dependencies and build scripts
├── tsconfig.json                 # TypeScript strict configuration
├── vitest.config.ts              # Vitest test runner configuration
└── wrangler.jsonc                # Cloudflare Workers configuration
```

---

## 🧪 Testing & Quality Assurance

```bash
# Run test suite
npm test

# Target a specific module
npx vitest run src/lib/__tests__/slug.test.ts

# Target a specific test pattern
npx vitest run -t 'escapes < so an embedded </script> cannot close the tag'

# Collect coverage report (scoped to src/lib/**)
npx vitest run --coverage
```

- **Pure Unit Testing**: Vitest runs in Node.js without `jsdom` overhead.
- **Architectural Separation**: `.astro` files are never touched by Vitest; any business logic requiring verification is housed in `src/lib/`.
- **AAA Pattern**: Tests strictly follow Arrange-Act-Assert with descriptive, behavior-driven names (e.g., `'returns error instead of throwing when the backend is unreachable'`).

---

## 🚢 Deployment to Cloudflare Workers

Deployments run via `wrangler` on Cloudflare Workers:

```bash
npm run deploy
```

The build output splits into two parts configured in `wrangler.jsonc`:
1. `dist/_worker.js/index.js` — The SSR entrypoint (`main`).
2. `dist/` (static directory) — Static client assets (`assets.directory`).

> [!IMPORTANT]
> **The role of `public/.assetsignore`:**
> In Workers, static assets take precedence over Worker routing. The server code (`_worker.js`) resides inside the output asset directory. Without `public/.assetsignore`, Cloudflare Workers serves `GET /_worker.js/index.js` as a static file, leaking the entire server-side bundle! It resides in `public/` so Astro retains it across builds.

### Self-Hosting Instructions

1. Update `name` and `routes` in [wrangler.jsonc](file:///home/debian/workspace/jumyjumy-web/wrangler.jsonc).
2. Update `site` URL in [astro.config.mjs](file:///home/debian/workspace/jumyjumy-web/astro.config.mjs).
3. Set your production secrets on Cloudflare:
   ```bash
   wrangler secret put API_BASE_URL
   wrangler secret put GATEWAY_TOKEN    # Optional: shared secret for gateway auth
   ```
4. Deploy:
   ```bash
   npm run deploy
   ```

---

## 📄 License

**All rights reserved.** Copyright © 2026 [jumyjumy.com](https://www.jumyjumy.com).

This source code is published for reading, study, and reference only. No license is granted to use, copy, modify, or redistribute it, and commercial use of any kind is strictly prohibited. The sole exception is what GitHub's [Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) grants to users of a public repository: viewing the code and forking it within GitHub.

Questions and issues are welcome via GitHub Issues. Pull requests are not accepted at this time as there is no contributor license agreement in place.
