# jumyjumy-web

**[jumyjumy.com](https://www.jumyjumy.com) is an AI Agent Search.** You ask a question in plain language; an agent researches it and returns one clear, sourced answer. Every answer becomes a real page at its own permanent URL — indexable, linkable, and stable enough to cite.

This repository is the **frontend**: the Astro application that renders those pages and owns their HTTP semantics. The agent that produces the answers is a separate backend service and is not part of this repository.

---

## How it works

Two page types, and nothing else:

1. **The ask box** (`/`) — a single input, prerendered to static HTML.
2. **The answer page** (`/q/<slug>-<id>`) — the canonical, indexable page for one question.

A third route exists but is not a page type: a `noindex` skeleton that the detail route rewrites to while an answer is still being generated.

```
browser  GET /q/<slug>-<id>            (canonical, id-lookup shape)
   -> Astro SSR   GET <API_BASE_URL>/q/<slug>-<id>   [JSON]
   -> 200 rendered | 301 canonical | 404 | 502

browser  GET /q/<raw question>         (anything else — the agent must run)
   -> Astro rewrites to the skeleton, 200 immediately, URL unchanged
   -> browser  GET /api/q/<raw question>
        -> Astro SSR   GET <API_BASE_URL>/q/<raw question>   [JSON]
        -> 200 {path} -> location.replace(path) -> the canonical page above
        -> 404 | 502  -> the skeleton's own not-found / retry state
```

A raw question means a model call. Blocking the server render on that would put TTFB at the mercy of model latency, and a slow or failed call would surface as a 502 on a perfectly valid question. Handing the browser an immediate `noindex` skeleton moves the wait client-side. It also means crawlers — which never run the script — stop triggering model calls at all, which is a crawl-budget and cost win as much as a latency one.

## Why server-side rendering

`output: 'server'` is deliberate, not a stepping stone toward a static build. Three things depend on it, none of which a static build can do:

- **Real status codes.** Retitling a question changes its slug, so the stale URL must `301` onto the canonical path or its link equity is lost. A question that does not exist must be a real `404`; answering `200` with an empty page is a soft 404 and burns crawl budget.
- **Pages that exist before the next build.** Users mint new questions continuously. `getStaticPaths()` would freeze the page set at build time.
- **Per-request index decisions.** `status` and `demoted` flip over time; a static build bakes `noindex` into the HTML until the next deploy.

## Stack

| | |
| :--- | :--- |
| Framework | Astro 5, `output: 'server'` |
| Runtime | Cloudflare Workers, via `@astrojs/cloudflare` |
| Language | TypeScript — `astro/tsconfigs/strict` plus `verbatimModuleSyntax` |
| Tests | Vitest |
| Runtime dependencies | none beyond the above; `src/lib/` is dependency-free |

Everything stays inside the Workers API surface (`crypto.subtle`, `fetch`, `TextEncoder`, `Intl.*`). The `nodejs_compat` flag in `wrangler.jsonc` is there for Astro's own SSR bundle, not licence to reach for Node built-ins in `src/`.

## Requirements

- **Node.js 22+** — required by `wrangler` (Astro itself accepts 18.20.8+)
- A backend serving the JSON API this frontend expects — the contract is documented in `CLAUDE.md`

## Getting started

```bash
npm install
cp .env.example .env      # point API_BASE_URL at your backend
npm run dev               # http://localhost:4321
```

With no backend reachable on `API_BASE_URL`, `/` still returns 200 because it is prerendered, and every `/q/*` returns 502.

### Commands

| Command | What it does |
| :--- | :--- |
| `npm run dev` | Astro dev server on `:4321`, reads `.env` |
| `npm run build` | build to `dist/` |
| `npm run preview` | run the built Worker in workerd — build first |
| `npm run deploy` | build and ship to Cloudflare Workers |
| `npm run check` | `astro check` — TypeScript and `.astro` diagnostics |
| `npm test` | Vitest, single pass |
| `npm run test:watch` | Vitest in watch mode |

## Configuration

Declared in `astro.config.mjs` through `astro:env` and read by pages via `astro:env/server`:

| Variable | Required | Description |
| :--- | :--- | :--- |
| `API_BASE_URL` | No (defaults to `http://localhost:3000`) | Root URL of the backend JSON API. |
| `GATEWAY_TOKEN` | No (optional) | Shared secret with the backend (`x-gateway-token`), gating `/q/` requests and endorsing visitor IP forwarding. |

Resolution sources:

| Mode | Source |
| :--- | :--- |
| `astro dev` / `astro build` | `.env` |
| `wrangler dev` | `.dev.vars` |
| deployed Worker | `wrangler secret put <NAME>` |
| nothing set | schema default (`API_BASE_URL`), or omitted (`GATEWAY_TOKEN`) |

`access: 'secret'` in the schema is a functional choice, not a secrecy claim: it is the only setting that resolves values **at runtime**. `access: 'public'` would inline them into the build output, so switching environments would mean rebuilding.

Neither value is stored in `wrangler.jsonc`. `vars` there is plaintext, and this repository is public.

## Project layout

```
src/
├── lib/                          pure, dependency-free domain logic — the tested layer
│   ├── api.ts                    backend contract: URL building, envelope parsing,
│   │                             validation, canonical redirects, fetch
│   ├── slug.ts                   /q/<slug>-<id> parsing, canonical paths, path encoding
│   ├── markdown.ts               escape-by-default markdown renderer (GFM tables, code, links)
│   ├── json-ld.ts                safe inlining of structured data
│   ├── datetime.ts               timestamp formatting, shared by server and client
│   └── types.ts                  the domain model — every field readonly
├── pages/
│   ├── index.astro               the ask box, prerendered
│   ├── q/[slugId].astro          the answer page
│   ├── q/pending/[query].astro   the noindex skeleton
│   └── api/q/[segment].ts        the endpoint the skeleton polls
├── layouts/ · components/ · styles/
```

Domain modules are pure and side-effect free; I/O is injected rather than imported, which is what keeps them testable and runtime-agnostic. Each one defends a specific constraint, explained in its header comment.

## Tests

```bash
npm test
npx vitest run src/lib/__tests__/slug.test.ts
npx vitest run -t 'escapes < so an embedded </script> cannot close the tag'
npx vitest run --coverage        # scoped to src/lib/**
```

Vitest collects `src/**/*.test.ts` in a `node` environment. There is no jsdom or component-test setup, so `.astro` files are never covered — logic that needs a test belongs in `src/lib/`.

Tests follow Arrange-Act-Assert with behavior-describing names, for example `'returns error instead of throwing when the backend is unreachable'`.

## Deployment

Cloudflare Workers, configured in `wrangler.jsonc`. `npm run deploy` builds and ships.

The build splits in two, and `wrangler.jsonc` names both halves:

- `dist/_worker.js/index.js` — the SSR entry (`main`)
- everything else in `dist/` — static assets (`assets.directory`)

A request matches the asset layer first and only falls through to the Worker on a miss, so the prerendered homepage never wakes it.

`public/.assetsignore` is load-bearing, not tidiness. The server bundle sits *inside* the assets directory, and Workers does **not** exclude `_worker.js` automatically the way Pages did — without that file, `GET /_worker.js/index.js` returns 200 and serves the whole server bundle. It lives in `public/` rather than `dist/` because `astro build` rebuilds `dist/` from scratch on every run.

To deploy to your own account, change `name` and `routes` in `wrangler.jsonc` and `site` in `astro.config.mjs`, then configure the backend URL and optional gateway token secrets:

```bash
wrangler secret put API_BASE_URL
wrangler secret put GATEWAY_TOKEN    # optional: shared secret for backend gateway auth
npm run deploy
```

## License

**All rights reserved.** Copyright © 2026 jumyjumy.com

This source is published for reading and reference only. No licence is granted to use, copy, modify, or redistribute it, and commercial use of any kind is not permitted. The sole exception is what GitHub's [Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) already grant every user of a public repository: viewing the code, and forking it within GitHub.

Issues and questions are welcome. Pull requests are not being accepted, because no licence is in place to cover contributed code. If you want to do anything beyond reading, please open an issue and ask.
