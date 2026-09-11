/**
 * sitemap 的取数与拼装。
 *
 * 为什么整个模块在 src/lib 而不是在那个 .astro 端点里：vitest 只收集
 * src/**\/*.test.ts 且跑在 node 环境，src/pages 下的东西永远不进覆盖率。
 * 逻辑放在这里，端点只剩接线。
 *
 * 为什么 XML 在前端拼而不是后端：slug 只有一个生产者——本目录的
 * `buildPath`。后端从不生成 slug（Rust 侧只解析 <slug>-<id> 取 id），
 * 一旦它也开始拼 URL，两处的规范化规则只要有一点分歧，sitemap 里就会
 * 塞满立刻 301 的地址，而这种漂移没有任何本地信号：两侧测试都全绿，
 * 页面照常可访问，只有 Search Console 的重定向计数在几周后慢慢涨起来。
 *
 * 副作用（fetch）以参数注入，与 `api.ts` 同一条理由：本模块可单测，
 * 且不绑定运行时。
 */

import { buildPath, encodePath } from './slug'

/** 每页条数。存储 Worker checkLimit 的天花板，超过它对端稳定 400。 */
const FEED_PAGE_SIZE = 1000

/**
 * 一次刷新最多翻几页。
 *
 * 取值是 config/default.toml 里 [rate_limit].burst_size（当前 10）的一半。
 * 网关的限流层挂在**所有**路由上，令牌桶可突发 10 次、之后每 2 秒补 1 个，
 * 因此连续翻页会被自家网关 429。留一半余量给同一时刻的其他请求。
 *
 * 与 FEED_PAGE_SIZE 相乘是 5000 条 URL 的软上限。真到那天，限流豁免与
 * sitemap 分片是同一件事的两面，必须同期解决——见设计文档 §11。
 *
 * 两个常量都不做成配置项：它们不是偏好，是从别处推出来的约束，开成旋钮
 * 等于给人机会把它们调到与来源互相矛盾的取值。
 */
export const MAX_FEED_PAGES = 5

export interface SitemapEntry {
  readonly id: string
  /** 规范化后的查询词，同时充当页面标题。slug 由它推导。 */
  readonly title: string
  /** Unix 毫秒。 */
  readonly updatedAt: number
}

export type FeedResult =
  | { readonly kind: 'ok'; readonly entries: readonly SitemapEntry[]; readonly truncated: boolean }
  | { readonly kind: 'error'; readonly message: string }

export interface FetchIndexableOptions {
  readonly fetchImpl?: typeof globalThis.fetch
  /** 网关的前端共享密钥。与 clientIp 要么一起发，要么都不发。 */
  readonly gatewayToken?: string | null
  /**
   * 访客的真实 IP，取自本跳收到的 `cf-connecting-ip`。
   *
   * 与 `api.ts` 的同名参数完全一致，**本路径没有例外**：发出去用
   * `x-real-ip` 这个名字，边缘会把自家 Worker 发来的它提升成下一跳的
   * `cf-connecting-ip`，那才是网关读取的头。
   *
   * 为什么这条路径也必须转发：`/sitemap.xml` 的缓存键归一化掉了查询串，
   * 但真有请求漏到后端时，限流只有拿到发起者的 IP 才管得住。不转发的话
   * 这些请求全落在边缘地址那个桶里，滥用不可归因，共用那个桶的其他东西
   * 跟着遭殃。
   */
  readonly clientIp?: string | null
  readonly signal?: AbortSignal
}

/**
 * 把一页的 items 收窄成 SitemapEntry[]。任何一条不合约就整体失败。
 *
 * **不做「跳过坏的那一条」**：少一个条目就是少一个永远不被发现的页面，
 * 而 sitemap 是本站唯一的发现通道。宁可整份失败让上层返回 503——Google
 * 会稍后重试并沿用上一份好的。
 */
function parseItems(raw: unknown): SitemapEntry[] | null {
  if (!Array.isArray(raw)) return null

  const entries: SitemapEntry[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null
    const { id, query, updatedAt } = item as Record<string, unknown>
    if (typeof id !== 'string' || id.length === 0) return null
    if (typeof query !== 'string' || query.length === 0) return null
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null
    entries.push({ id, title: query, updatedAt })
  }
  return entries
}

/**
 * 翻页取全部可索引记录。
 *
 * 循环在这里而不是在网关里：config/default.toml 的超时预算是按「一次请求
 * 最多两次 store 调用」建立的，服务端循环会直接推翻它。Worker 的墙钟时间
 * 不受那条预算约束。
 *
 * 访客 IP 照常转发，**本路径没有例外**——见 `clientIp` 的说明。UA 不转发，
 * 那不是例外而是它自己的理由用尽了：转发 UA 的唯一目的是让访问量统计不把
 * 真实访客判成爬虫，而本路径根本不经过统计。
 */
export async function fetchIndexable(
  baseUrl: string,
  options: FetchIndexableOptions = {},
): Promise<FeedResult> {
  const call = options.fetchImpl ?? globalThis.fetch
  const headers = new Headers()
  // 两个头要么一起发要么都不发，与 api.ts 的 buildHeaders 同一条绑定：
  // 网关未配密钥时保持开放，所以两边先后上线的中间态不会白屏。
  if (options.clientIp && options.gatewayToken) {
    headers.set('x-real-ip', options.clientIp)
    headers.set('x-gateway-token', options.gatewayToken)
  } else if (options.gatewayToken) {
    headers.set('x-gateway-token', options.gatewayToken)
  }

  const entries: SitemapEntry[] = []
  let cursor: string | null = null

  for (let page = 0; page < MAX_FEED_PAGES; page += 1) {
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}/q/sitemap/feed`)
    url.searchParams.set('limit', String(FEED_PAGE_SIZE))
    if (cursor !== null) url.searchParams.set('cursor', cursor)

    let response: Response
    try {
      response = await call(url.toString(), { headers, signal: options.signal })
    } catch (error) {
      return { kind: 'error', message: `feed request failed: ${String(error)}` }
    }

    if (!response.ok) {
      return { kind: 'error', message: `feed answered HTTP ${response.status}` }
    }

    let envelope: unknown
    try {
      envelope = await response.json()
    } catch {
      return { kind: 'error', message: 'feed answered with invalid JSON' }
    }

    // success 是契约的一部分，跳过它等于把一条失败响应当成内容。
    if (typeof envelope !== 'object' || envelope === null) {
      return { kind: 'error', message: 'feed envelope was not an object' }
    }
    const { success, data } = envelope as Record<string, unknown>
    if (success !== true || typeof data !== 'object' || data === null) {
      return { kind: 'error', message: 'feed reported failure' }
    }

    const { items, nextCursor } = data as Record<string, unknown>
    const parsed = parseItems(items)
    if (parsed === null) {
      return { kind: 'error', message: 'feed returned an item that does not match the contract' }
    }
    entries.push(...parsed)

    if (typeof nextCursor !== 'string' || nextCursor.length === 0) {
      return { kind: 'ok', entries, truncated: false }
    }
    cursor = nextCursor
  }

  // 翻满上限仍有下一页：截断，但不失败。半份 sitemap 仍然让这些页面
  // 可被发现，而 503 会让全部页面在这一轮都不可发现。
  return { kind: 'ok', entries, truncated: true }
}

/** XML 文本节点里必须转义的三个字符。& 必须先换，否则会把后两个的实体再转一次。 */
function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Unix 毫秒 -> W3C datetime，去掉毫秒段。
 *
 * 形如 2026-09-10T03:12:45Z。毫秒合法但没有信息量，去掉更好读。
 */
function toLastmod(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * 拼出 sitemap.xml 的正文。
 *
 * 只发 loc 与 lastmod：Google 明确忽略 changefreq 与 priority，发出去只是
 * 噪声，还会随时间与事实不符。
 *
 * lastmod 取 updatedAt。这个字段的语义正好是 Google 期望的「内容更新时间」，
 * 而且 TTL 评估与访问量统计两期都专门保证过不触碰它。
 *
 * 首页条目**不带 lastmod**：首页是 prerender 的，它的更新时间是部署时间，
 * 运行时拿不到。写一个假的会让整份文档的 lastmod 不再可信，而 Google 只在
 * lastmod 一贯准确时才采信它——宁可少给一个可选元素。
 *
 * 转义仍然做，尽管今天不做也正确：encodeURIComponent 会把 & 与 < 编成
 * %26、%3C，它保留的 '!*() 没有一个是 XML 文本节点里需要转义的字符。
 * 做的理由是这条正确性依赖上游函数的保留字符集，而那不是本模块能控制的，
 * 首页条目也不经过 encodePath。
 */
export function buildSitemap(entries: readonly SitemapEntry[], siteUrl: string): string {
  const root = siteUrl.replace(/\/+$/, '')

  const urls = entries.map((entry) => {
    const loc = escapeXml(`${root}${encodePath(buildPath(entry.title, entry.id))}`)
    return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${toLastmod(entry.updatedAt)}</lastmod>\n  </url>`
  })

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url>\n    <loc>${escapeXml(`${root}/`)}</loc>\n  </url>`,
    ...urls,
    '</urlset>',
    '',
  ].join('\n')
}
