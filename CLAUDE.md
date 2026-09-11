# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # astro dev — http://localhost:4321 (reads .env)
npm run build      # astro build → dist/
npm run preview    # wrangler dev — runs the built worker in workerd (build first)
npm run deploy     # astro build && wrangler deploy → Cloudflare Workers
npm run check      # astro check — TypeScript + .astro diagnostics
npm test           # vitest run (single pass)
npm run test:watch # vitest watch
```

Single test file / single test:

```bash
npx vitest run src/lib/__tests__/slug.test.ts
npx vitest run -t 'escapes < so an embedded </script> cannot close the tag'
npx vitest run --coverage       # coverage is scoped to src/lib/**
```

Vitest only collects `src/**/*.test.ts` in a `node` environment — there is no jsdom/component-test setup, so `.astro` files are never covered. Logic that needs a test belongs in `src/lib/`.

The site needs a backend on `API_BASE_URL` to serve anything under `/q/`. With no backend running, `/` still returns 200 (prerendered) and `/q/*` returns 502.

### Environment gotcha

`node_modules` in this checkout was once installed in a way that left `node_modules/.bin/*` as 0-byte files and stripped the exec bit from the esbuild binaries, which surfaces as `astro: Permission denied` (exit 127) or `spawn .../esbuild EACCES`. Repair without reinstalling:

```bash
npm rebuild                                   # recreates .bin symlinks
chmod +x node_modules/**/esbuild/bin/esbuild  # restores exec bit
```

If more binaries misbehave, do a clean `rm -rf node_modules && npm install` from Linux — not from the Windows side of the WSL mount.

`@astrojs/cloudflare` must stay on the **12.x** line: 13.x requires Astro 6 and 14.x requires Astro 7, while this project is on Astro 5. `npm install @astrojs/cloudflare` without a version pin fails with ERESOLVE.

## What this is

A question-and-answer site built for Google indexing: two page types only — a homepage ask-box, and an answer detail page. A third route exists but is not a page type: a skeleton the detail route rewrites to while an answer is still being generated.

Content comes from a backend JSON API. The frontend owns rendering and HTTP semantics; the backend owns answers, dedup and persistence.

```
browser  GET /q/<slug>-<id>            (canonical, id-lookup shape)
   -> astro (SSR)  GET <API_BASE_URL>/q/<slug>-<id>   [JSON]
   -> 200 rendered | 301 canonical | 404 | 502

browser  GET /q/<raw question>         (anything else — backend must call the model)
   -> astro rewrites to the skeleton, 200 immediately, URL unchanged
   -> browser  GET /api/q/<raw question>
        -> astro (SSR)  GET <API_BASE_URL>/q/<raw question>   [JSON]
        -> 200 {path} -> location.replace(path) -> the canonical page above
        -> 404 | 502  -> the skeleton's own not-found / retry state
```

`output: 'server'` with `@astrojs/cloudflare` is deliberate and not a temporary state. It is what makes three things possible, none of which a static build can do:

1. **Real status codes.** Retitling changes the slug, so a stale URL must 301 to the canonical path or link equity is lost. A missing question must be a real 404 — returning 200 with an empty page is a soft 404 and costs crawl budget.
2. **Pages that exist before the next build.** Users mint new questions continuously; `getStaticPaths()` would freeze the page set at build time.
3. **Per-request index decisions.** `status` and `demoted` flip over time; a static build bakes `noindex` into HTML until the next deploy.

The site **runs on Cloudflare Workers** (`@astrojs/cloudflare`), so everything must stay inside that runtime's API surface (`crypto.subtle`, `fetch`, `TextEncoder`, `Intl.*`; no Node-only built-ins). The `nodejs_compat` flag in `wrangler.jsonc` is there for Astro's own SSR bundle, not licence to reach for Node APIs in `src/`.

## Configuration

Two variables are declared in `astro.config.mjs` via `astro:env` (`envField.string` with `access: 'secret'`):
- `API_BASE_URL`: root URL of the backend JSON API (default: `http://localhost:3000`). Read by pages through `import { API_BASE_URL } from 'astro:env/server'`.
- `GATEWAY_TOKEN`: shared secret for backend `/q/` authorization and visitor IP forwarding endorsement (optional: true). Read by pages through `import { GATEWAY_TOKEN } from 'astro:env/server'`.

`access: 'secret'` is load-bearing, not a claim that the URL is sensitive. It is the only setting that resolves the value **at runtime**; `access: 'public'` inlines it into the build output, which would mean rebuilding to change environments.

How values are resolved, verified by test:

| Mode | Source |
| :--- | :--- |
| `astro dev` / `astro build` | `.env` |
| deployed Worker | secrets set with `wrangler secret put <NAME>`; the adapter copies every `env.schema` key into `process.env` per request |
| `wrangler dev` | `.dev.vars` — **not** `.env` |
| nothing set | `API_BASE_URL` uses schema `default` (`http://localhost:3000`); `GATEWAY_TOKEN` is omitted (frontend sends neither IP nor token header) |

Neither value lives in `wrangler.jsonc` `vars`. This repository is public, and `vars` is plaintext: committing secrets or backend origins there publishes an unauthenticated endpoint that spends model quota on every call. Secrets keep them out of the tree while still reaching `process.env` per request. With nothing configured, `/q/*` returns 502 across the board — that is the expected symptom of a missing config, not a bug.

## Deployment

Cloudflare Workers, configured in `wrangler.jsonc`. `npm run deploy` builds and ships. Live at `https://www.jumyjumy.com` — a Workers custom domain on the existing `jumyjumy.com` zone, whose DNS record wrangler created on first deploy.

The build splits in two, and `wrangler.jsonc` names both halves:

- `dist/_worker.js/index.js` — the SSR entry (`main`).
- everything else in `dist/` — static assets (`assets.directory`). The homepage is `prerender = true`, so `/` is served from the asset layer and never wakes the Worker; `/q/*` misses the assets and falls through to SSR.

`public/.assetsignore` is load-bearing, not tidiness. The server bundle sits *inside* the assets directory, and Workers does **not** exclude `_worker.js` automatically the way Pages did — measured: without that file, `GET /_worker.js/index.js` returns **200 and serves the whole server bundle**. It lives in `public/` rather than `dist/` because `astro build` rebuilds `dist/` from scratch each time, which would delete it. `_routes.json` is excluded for a related reason: the adapter emits it for Pages, Workers never reads it, and serving it only publishes the route table.

`compatibility_date` is pinned to the installed `workerd` build so `wrangler dev` does not warn and fall back. Moving it forward is a runtime behavior change — verify it, don't bump it in passing.

## Architecture

Domain logic lives in `src/lib/` as pure, dependency-free modules; `src/pages/` holds the routes. Each lib module defends a specific constraint — read its Chinese header comment before changing behavior:

- **`api.ts`** — the backend contract, and the only place the two vocabularies meet. `buildQuestionUrl` percent-encodes `<query>` into a single path segment (it is user-controlled; unencoded it enables path traversal). `parseQuestionPayload` takes the **whole envelope** `{success, data, error}` — `success` is part of the contract, and skipping it would render a failure response as content — then translates the backend's words into the domain model: `data.query` → `title`, `data.text` → `answerMarkdown`, `sources[].uri` → `sources[].url`. It validates everything as untrusted data and rejects anything malformed rather than half-rendering. `resolveCanonicalRedirect` decides the 301 and returns a **percent-encoded** path (see `slug.ts`). `fetchQuestion` returns a discriminated union `ok | notFound | error` so callers *cannot* conflate "missing" with "backend down" — that distinction is what keeps 404 and 502 apart. A backend `400` (empty, overlong, or upstream-rejected query) maps to `notFound`, not `error`: such a URL can never come to exist, so 502 would only make crawlers retry a dead link forever. `fetch` is injected, which keeps the module testable and runtime-agnostic, and an optional `signal` lets a caller bound how long it will wait. `toPendingResolution` is the same translation for the skeleton's endpoint: `ok` → 200 plus the **encoded** canonical path, `notFound` → 404, `error` → 502 with the backend detail kept in `logMessage` — that string contains `API_BASE_URL`, so it goes to the server log and never into a response body. Visitor IP forwarding passes the visitor's `cf-connecting-ip` to the backend via `x-real-ip` alongside `x-gateway-token` (matching `GATEWAY_TOKEN`); Cloudflare edge promotes `x-real-ip` from its own Workers to `cf-connecting-ip` on the backend hop while stripping forged external headers, and headers are checked against legal byte characters to eliminate CRLF injection.
- **`slug.ts`** — URLs are `/q/<slug>-<id>`. The trailing `id` is the permanent key; the slug is decorative. `ID_PATTERN` (`/^[0-9][0-9a-z]{9,11}$/`) is the one place the id shape is written — a leading digit plus base36, 10–12 chars, mirroring the backend `is_id`. The leading digit is load-bearing: English words never start with one, so `/q/learn-kubernetes` stays a question instead of 404ing as a crawler-invented canonical URL — the old 6-char rule mistook `nodejs-sqlite` for an id. The length is a range, not 10, so the backend can grow the id without a frontend change or a 301. There is no legacy 6-char branch, and there is no redirect map for the URLs that shape produced — those URLs are **abandoned deliberately**, not pending migration. Accepting the old shape here would only route a question into the blocking id path; with neither side recognising it, such a segment falls back to being a question and the backend answers it under a fresh id. Do not add a second accepted shape. Retitling changes the slug and 301s to the canonical path without losing link equity — that's what makes "rewrite the title to raise CTR" a zero-risk operation. `parseSlugId` matches loosely on purpose; existence is the backend's call, not the parser's. `toSlug` keeps CJK, so `encodePath` exists to make a path safe for a `Location` header: header values are ByteString, and a raw `开` (U+5F00) makes `new Response` throw `TypeError` and the page 500. Encode only where a path becomes a URL — comparisons stay in decoded form, or a CJK canonical URL 301s to itself forever. `isIdLookupSegment` answers a different question from `parseSlugId`: not "can I read an id out of this?" but "will the backend resolve this by id?" — it mirrors the backend's own shape rule, **whitespace rejection included**. Since the leading-digit rule landed, whitespace is the *only* difference between the two: `parseSlugId` does not reject it, so `debian 13-1xwndu4p7c` reads as canonical to the parser while the backend calls it a question and goes to the model. The route branches on `isIdLookupSegment`, and using the loose parser there is what puts a page back on the blocking slow path.
- **`sitemap.ts`** — dynamic sitemap generation and upstream feed ingestion. XML is constructed in the frontend because `buildPath` is the sole producer of canonical slugs; backend URL construction would risk normalization drift and 301 redirect churn in Search Console. Paginates `/q/sitemap/feed` (bounded by `MAX_FEED_PAGES = 5` to respect gateway rate-limit burst budgets). Strictly fails whole document if any entry is malformed or if `nextCursor` is missing (must be explicitly `null` to complete), rather than quietly dropping URLs or pages. Upstream failure returns `{ kind: 'error' }` mapping to 503 rather than empty 200 `<urlset>`, ensuring search crawlers retain existing index state and retry later. `escapeXml` escapes XML entities (`&`, `<`, `>`).
- **`markdown.ts`** — escape-by-default renderer. Raw HTML is escaped (including inside code fences), `javascript:` links degrade to plain text, `http(s)` links get `rel="nofollow noopener"`.
- **`json-ld.ts`** — `toInlineJsonLd` escapes `<` as `\u003c` before the payload is inlined into `<script type="application/ld+json">`. Plain `JSON.stringify` is unsafe here: a `</script>` anywhere in backend-supplied text closes the tag early and the remainder parses as HTML.
- **`datetime.ts`** — `formatTimestamp(ms, timeZone?)`, shared by the server render and the client script. SSR cannot know the visitor's zone, so the page ships UTC and a script re-renders it in `resolvedOptions().timeZone`. The default is UTC rather than the server's zone for two reasons: one HTML for every visitor is what makes `s-maxage=60` safe, and the deploy host's `TZ` should not leak into the page. The output always carries the zone abbreviation — without JS the page stays on UTC, and an unlabelled UTC passed off as local time is a lie. The machine-readable value stays in `<time datetime>` as a full ISO instant; the script only rewrites what humans read.
- **`types.ts`** — `Question` is the domain model and every field is `readonly`. Derive new objects; never mutate in place.

### Fonts, SVG logo, and layout stability

The brand logo is rendered directly via SVG (`Logo.astro`) using the sunset glow gradient palette. Because it is vector SVG rather than text subject to webfont swapping, it has zero layout shifts (0 CLS) and zero render blocking on initial paint.

The site uses modern system font stacks for body and UI typography, removing the need for external woff2 downloads and eliminating all font-swap reflows.

### Security invariants

Everything the backend returns is untrusted input. Three defenses exist and must not be weakened:

1. `sources[].uri` is protocol-allowlisted to http/https as it becomes `sources[].url` in `parseQuestionPayload`, because `[slugId].astro` writes it straight into `href`.
2. Answer bodies go through `renderAnswer`, never `set:html` with raw markdown.
3. Structured data goes through `toInlineJsonLd`, never bare `JSON.stringify`.

### Page responsibilities

`src/pages/q/[slugId].astro` branches on `isIdLookupSegment` **before** it fetches anything. An id-shaped segment is fetched at request time and returns 404 / 502 / 301 before rendering; `cache-control` is set only for `ready && !demoted` pages (`s-maxage=60, stale-while-revalidate=600`) to offset SSR's TTFB, everything else is `no-store` because those states can flip at any time.

Anything else is a raw question, which the backend answers by calling the model. Blocking SSR on that puts TTFB at the mercy of model latency, and a slow or failed call surfaces as a 502 on a perfectly valid question. So the route `Astro.rewrite`s to `src/pages/q/pending/[query].astro` — the URL stays `/q/<question>`, the response is an immediate 200, and the wait moves to the browser. Two things make this safe to do on an SEO site:

- The skeleton is **`noindex`** and `no-store`. It has no answer in it; the indexable page is the canonical one the browser replaces into. Nothing here is a soft 404, because nothing here is indexable.
- Crawlers get the skeleton and never run the script, so `/q/<raw question>` **stops triggering a model call**. That is a crawl-budget and cost win, not just a latency one.

The accepted cost, decided deliberately — **do not "fix" it by restoring the 301**: a raw-question URL used to 301 and consolidate link equity onto the canonical page; a `noindex` 200 does not, and the client-side `location.replace` cannot stand in for it, because Googlebot skips rendering entirely when it sees `noindex` in the initial HTML. The exposure is small: nothing links to raw-question URLs, and `location.replace` leaves no history entry, so the URL a user can copy is the canonical one within seconds. If this ever needs to be reclaimed, the fix is a lookup-only backend entry point (`HEAD /q/<segment>` or `?peek=1`) that never calls the model — peek first, 301 on a hit, skeleton on a miss. A short SSR race (301 if the backend answers within ~1.5s, skeleton otherwise) is the cheaper approximation, and was considered and declined.

`src/pages/api/q/[segment].ts` is the endpoint the skeleton calls. It exists because `API_BASE_URL` is `access: 'secret'` (the browser cannot see it) and the backend sends no CORS headers. It returns only the canonical path, never the answer body — the markdown escaping, source-protocol allowlist and JSON-LD escaping stay server-side rather than being reimplemented in the browser. It bounds the backend call with `AbortSignal.timeout` (90s); the client's own timeout is 100s so the endpoint's clean 502 wins the race. The client validates that the returned path starts with `/q/` before `location.replace` — the endpoint is ours, but a redirect target taken from a response body is an open redirect if left unchecked.

`src/pages/index.astro` sets `prerender = true` — it has no dynamic data, so it is served as static HTML. Its ask-box navigates to `/q/<encodeURIComponent(question)>`; fingerprint dedup is the backend's job, and the page 301s to the canonical URL once the backend resolves it.

`src/pages/sitemap.xml.ts` serves `/sitemap.xml` with explicit Cloudflare Cache API edge caching (`max-age=86400`). The cache key strips query parameters to prevent cache busting. Returns 503 on upstream error and only caches successful 200 responses.

## Conventions

- Domain modules are pure and side-effect free; I/O is injected, not imported. Keep Astro specifics out of `src/lib/`.
- TypeScript is `astro/tsconfigs/strict` plus `verbatimModuleSyntax` — import types with `import type`.
- Tests use Arrange-Act-Assert with behavior-describing names (`'returns error instead of throwing when the backend is unreachable'`), and live in `src/lib/__tests__/`.
- Explanatory comments in `src/lib/` are in Chinese and explain *why* a constraint exists. Match that when extending these files.
- All user-facing copy is English only.

## Backend contract

The backend is a separate service, not part of this repository, reached over `API_BASE_URL`. It wraps every response in one envelope:

```json
{"success":true,"data":{"id":"1xwndu4p7c","fingerprint":"41d1…","query":"debian13开启bbr","text":"…","sources":[{"title":"…","uri":"https://…"}],"status":"ready","createdAt":1788052974592,"updatedAt":1788052974592},"error":null}
```

`GET /q/<segment>` resolves in three steps, and the frontend's HTTP semantics depend on all three:

1. `<segment>` shaped like `<slug>-<id>` (no whitespace, and after the last `-` an id: one `[0-9]` then 9–11 `[0-9a-z]`) → lookup by id. Hit returns the stored record **without calling the upstream model**, so an indexed page stays reachable when Gemini is rate-limited. Miss returns **404** — a crawler-invented URL must not mint a page or burn a model call.
2. Otherwise validated as a question; empty or overlong gets **400**.
3. Fingerprint hit (normalized: whitespace folded, lowercased) returns the stored record — this is the dedup. Only a real miss calls the model, stores the result, and returns it.

`id` is 10 chars — a leading digit plus 9 base36 — derived from the SHA-256 fingerprint of the normalized query, so the same question always resolves to the same id even after the store is lost. Records append to `[q].store_path` (`data/questions.jsonl`); losing that file 404s every already-indexed URL, which is why it is persisted rather than held in memory.

## Current state

Deployed to Cloudflare Workers and verified in production against the real backend: `/` 200 from the asset layer, an immediate 200 `noindex` skeleton for a raw question segment, 200 on the canonical path with `cache-control: public, s-maxage=60, stale-while-revalidate=600`, 301 from a stale slug onto the canonical path, 404 for an unknown id, and 404 for `/_worker.js/*`, `/_routes.json` and `/.assetsignore`. Verified earlier under the node adapter and unchanged by the move: 502 when the backend is unreachable while the skeleton still returns 200 and its endpoint's 502 leaks no internal address, and the three skeleton states in headless chromium (it lands on the rendered answer page, and shows exactly one of loading / not-found / retry otherwise).

116 tests pass; coverage of `src/lib/` is 98.04% statements / 88.14% branches (`types.ts` reports 0% because it is type declarations only).

The apex `jumyjumy.com` does not resolve — only `www` is bound, so there is no apex→www redirect yet. Built: `favicon.ico` multi-resolution icon in `public/favicon.ico`, `robots.txt` in `public/robots.txt` (includes Cloudflare Content Signals policy reservation comments, `Content-signal: search=yes, ai-input=yes, ai-train=no`, `Disallow: /api/`, `Disallow: /q/pending/`, and `Sitemap: https://www.jumyjumy.com/sitemap.xml`), visitor IP forwarding (`cf-connecting-ip` via `x-real-ip`) with shared `x-gateway-token` authorization, and `/sitemap.xml` dynamic endpoint with Cloudflare Cache API edge caching, pagination validation, and 503 fail-safe semantics. Not yet built: any analytics or view counting. `Question.fingerprint` now comes from the backend's dedup key, but nothing in the frontend reads it — dedup happens server-side.
