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
- A backend serving the [JSON contract](#backend-contract) below

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

One variable: `API_BASE_URL`, the root of the backend JSON API. It is declared in `astro.config.mjs` through `astro:env` and read by pages via `astro:env/server`.

| Mode | Source |
| :--- | :--- |
| `astro dev` / `astro build` | `.env` |
| `wrangler dev` | `.dev.vars` |
| deployed Worker | `wrangler secret put API_BASE_URL` |
| nothing set | schema default, `http://localhost:3000` |

`access: 'secret'` in the schema is a functional choice, not a secrecy claim: it is the only setting that resolves the value **at runtime**. `access: 'public'` would inline it into the build output, so switching environments would mean rebuilding.

The value is deliberately absent from `wrangler.jsonc`. `vars` there is plaintext, and this repository is public.

## Backend contract

Not included here. Any service that answers `GET <API_BASE_URL>/q/<segment>` with this envelope will work:

```json
{
  "success": true,
  "data": {
    "id": "1xwndu4p7c",
    "fingerprint": "41d1…",
    "query": "how to enable bbr on debian 13",
    "text": "…markdown…",
    "sources": [{ "title": "…", "uri": "https://…" }],
    "status": "ready",
    "createdAt": 1788052974592,
    "updatedAt": 1788052974592
  },
  "error": null
}
```

`<segment>` resolves in three steps, and the frontend's HTTP semantics depend on all three:

1. Shaped like `<slug>-<id>` — no whitespace, and after the last `-` an id of one `[0-9]` followed by 9–11 `[0-9a-z]` — is **looked up by id**. A hit returns the stored record *without* calling the model, so an indexed page stays reachable while the model is rate-limited. A miss is **404**: a crawler-invented URL must not mint a page or burn a model call.
2. Anything else is validated as a question. Empty or overlong is **400**, which the frontend maps to `notFound` rather than `error` — such a URL can never come to exist, so a 502 would only make crawlers retry a dead link forever.
3. A fingerprint hit — whitespace folded, lowercased — returns the stored record. This is the dedup. Only a real miss calls the model, stores the result, and returns it.

The id is derived from the fingerprint of the normalized query rather than generated randomly, so the same question always resolves to the same id even after the store is lost.

## Project layout

```
src/
├── lib/                          pure, dependency-free domain logic — the tested layer
│   ├── api.ts                    backend contract: URL building, envelope parsing,
│   │                             validation, canonical redirects, fetch
│   ├── slug.ts                   /q/<slug>-<id> parsing, canonical paths, path encoding
│   ├── markdown.ts               escape-by-default markdown renderer
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

## Security invariants

Everything the backend returns is untrusted input. Three defences exist and must not be weakened:

1. **`sources[].uri` is protocol-allowlisted** to `http`/`https` as it becomes `sources[].url`, because the answer page writes it straight into an `href`.
2. **Answer bodies go through `renderAnswer`**, never `set:html` with raw markdown. Raw HTML is escaped — inside code fences too — and `javascript:` links degrade to plain text.
3. **Structured data goes through `toInlineJsonLd`**, never bare `JSON.stringify`. A `</script>` anywhere in backend text would otherwise close the tag early and let the remainder parse as HTML.

The API route at `src/pages/api/q/[segment].ts` returns only the canonical path, never the answer body, so all three defences stay server-side rather than being reimplemented in the browser. The client validates that the returned path starts with `/q/` before calling `location.replace` — the endpoint is ours, but a redirect target read out of a response body is an open redirect if left unchecked.

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

To deploy to your own account, change `name` and `routes` in `wrangler.jsonc` and `site` in `astro.config.mjs`, then set the backend URL as a secret:

```bash
wrangler secret put API_BASE_URL
npm run deploy
```

## License

**All rights reserved.** Copyright © 2026 jumyjumy.com

This source is published for reading and reference only. No licence is granted to use, copy, modify, or redistribute it, and commercial use of any kind is not permitted. The sole exception is what GitHub's [Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) already grant every user of a public repository: viewing the code, and forking it within GitHub.

Issues and questions are welcome. Pull requests are not being accepted, because no licence is in place to cover contributed code. If you want to do anything beyond reading, please open an issue and ask.
