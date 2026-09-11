/**
 * sitemap.xml。
 *
 * 本站的问答页是孤岛——首页是提问框，它的跳转是脚本而不是链接，详情页只
 * 链回首页与站外来源。因此 Googlebot 没有任何一条爬取路径能到达
 * /q/<slug>-<id>，**这份文档是本站目前唯一的发现通道**。下面那条「失败一律
 * 503」的规则全部由这句话推出。
 *
 * 逻辑在 src/lib/sitemap.ts，本文件只负责接线：取配置、读写缓存、映射失败。
 */
import type { APIRoute } from 'astro'
import { API_BASE_URL, GATEWAY_TOKEN } from 'astro:env/server'
import { buildSitemap, fetchIndexable } from '../lib/sitemap'

export const prerender = false

/** 边缘缓存的生存期。一天，与「每日刷新足够」这个需求一致。 */
const CACHE_TTL_SECONDS = 86_400

/** 取数总超时。翻页是串行的，给足余量但不能没有上限。 */
const FEED_TIMEOUT_MS = 20_000

/** Astro.site 缺失时的兜底，与详情页同一个写法。 */
const FALLBACK_SITE = 'https://www.jumyjumy.com'

/**
 * 取边缘缓存。`astro dev` 跑在 node 里，没有 caches 这个全局量，因此必须
 * 守卫——不守的话本地开发会直接 500。
 */
function edgeCache(): Cache | undefined {
  return typeof caches === 'undefined' ? undefined : (caches as unknown as { default: Cache }).default
}

export const GET: APIRoute = async ({ url, site, request }) => {
  const cache = edgeCache()

  // 缓存键**必须**丢掉查询串，只留 origin + 路径。用完整 URL 当键的话，
  // /sitemap.xml?x=1、?x=2 每一个都是新键，各自绕过缓存并触发一轮翻页取数
  // 加一次全表扫——一个查询串就能把边缘缓存变成摆设。
  const cacheKey = new Request(new URL('/sitemap.xml', url.origin).toString())

  const cached = await cache?.match(cacheKey)
  if (cached) return cached

  const result = await fetchIndexable(API_BASE_URL, {
    gatewayToken: GATEWAY_TOKEN,
    // 照常转发访客 IP，与详情页、骨架页取数端点完全一致。漏到后端的请求
    // 因此落在发起者自己的限流桶上，而不是边缘地址那个共用桶。
    clientIp: request.headers.get('cf-connecting-ip'),
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  })

  // 取数失败一律 503，绝不 200 加一个空 urlset。空 urlset 是合法文档：
  // 能解析、零报错、Search Console 里安静地显示 0 条，而本站唯一的发现
  // 通道已经断了。503 让 Google 稍后重试并继续沿用上次抓到的那一份。
  // 这与后端用 401 而不是裸 404、存储 Worker 用 miss 头区分两种 404，
  // 是同一条纪律。
  if (result.kind === 'error') {
    console.error(`[sitemap.xml] ${result.message}`)
    return new Response('sitemap upstream unavailable', { status: 503 })
  }

  // 截断不是失败：半份 sitemap 仍然让这些页面可被发现。但必须是 error
  // 而不是 warn——静默截断在 Search Console 里只表现为「已发现的网址数
  // 不再增长」，没人会盯着那个数字。
  if (result.truncated) {
    console.error(
      `[sitemap.xml] feed truncated at ${result.entries.length} urls; ` +
        '限流豁免与 sitemap 分片必须同期解决，见 spec §11',
    )
  }

  const xml = buildSitemap(result.entries, (site ?? new URL(FALLBACK_SITE)).origin)
  const response = new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
    },
  })

  // 只有成功的响应进缓存。把 503 缓存起来会让一次抖动持续一整天。
  //
  // 用显式的 Cache API 而不是仪表盘上的 Cache Rule：Cloudflare 不会自动
  // 缓存 Worker 生成的响应，必须有人显式写；而仪表盘规则对仓库不可见，
  // 评审读不到、改动无记录、新环境重建时会漏。
  await cache?.put(cacheKey, response.clone())

  return response
}
