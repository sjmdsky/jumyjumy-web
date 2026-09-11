import { describe, test, expect } from 'vitest'
import { buildSitemap, fetchIndexable, MAX_FEED_PAGES } from '../sitemap'
import { buildPath } from '../slug'

const SITE = 'https://www.jumyjumy.com'
const UPDATED = 1_788_052_974_592

/** buildSitemap 的入参形状：标题字段叫 title。 */
function entry(overrides: Partial<{ id: string; title: string; updatedAt: number }> = {}) {
  return { id: '1abcdefghi', title: 'how to enable bbr', updatedAt: UPDATED, ...overrides }
}

/**
 * feed 线上返回的一条：标题字段叫 **query**，不是 title——与网关的
 * `IndexableEntry` 逐字一致。两个形状刻意分开，混用会让「线上契约」与
 * 「模块内部类型」悄悄粘在一起。
 */
function feedItem(overrides: Partial<{ id: string; query: string; updatedAt: number }> = {}) {
  return { id: '1abcdefghi', query: 'how to enable bbr', updatedAt: UPDATED, ...overrides }
}

/** 造一个按页返回的 fetch 替身。每次调用返回 pages 里的下一份。 */
function pagingFetch(pages: { items: unknown[]; nextCursor: string | null }[]): typeof globalThis.fetch {
  let call = 0
  return (async () => {
    const page = pages[Math.min(call, pages.length - 1)]
    call += 1
    return new Response(JSON.stringify({ success: true, data: page, error: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof globalThis.fetch
}

describe('buildSitemap', () => {
  test('renders one url element per entry plus the homepage', () => {
    // Arrange
    const entries = [entry(), entry({ id: '2bcdefghij', title: 'second question' })]

    // Act
    const xml = buildSitemap(entries, SITE)

    // Assert
    expect(xml.match(/<url>/g)).toHaveLength(3)
    expect(xml).toContain(`<loc>${SITE}/</loc>`)
  })

  test('loc matches the canonical path the detail page would build', () => {
    // Arrange —— 这是本模块存在的全部意义：slug 只有一个生产者
    const one = entry()

    // Act
    const xml = buildSitemap([one], SITE)

    // Assert
    expect(xml).toContain(`<loc>${SITE}${buildPath(one.title, one.id)}</loc>`)
  })

  test('percent-encodes CJK titles into a legal url', () => {
    // Arrange
    const one = entry({ title: '如何给 div 居中' })

    // Act
    const xml = buildSitemap([one], SITE)

    // Assert —— 原样的 CJK 不能出现在 loc 里，编码后的地址必须可解析
    expect(xml).not.toContain('如何给')
    const loc = /<loc>(https:\/\/[^<]*1abcdefghi)<\/loc>/.exec(xml)?.[1]
    expect(loc).toBeDefined()
    expect(loc).toContain('%')
    expect(() => new URL(loc as string)).not.toThrow()
  })

  test('escapes ampersands and angle brackets in the site URL so the document stays well formed', () => {
    // Arrange —— toSlug 会把特殊字符变连字符，所以标题里的 & < 到不了 escapeXml。
    // 只有 siteUrl 是原样传的。这个测试确认 escapeXml 会被调用并工作。
    const one = entry()
    const siteWithSpecials = 'https://example.com?param=a&b<injected>'

    // Act
    const xml = buildSitemap([one], siteWithSpecials)

    // Assert —— 原样的 & 与 < 不能出现在 XML 文本节点里
    expect(xml).toContain('&amp;')
    expect(xml).toContain('&lt;')
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;)/) // 未转义的 & 只能是 HTML 实体的一部分
    expect(xml).not.toContain('<injected>')
  })

  test('lastmod is an ISO timestamp with no milliseconds', () => {
    // Act
    const xml = buildSitemap([entry()], SITE)

    // Assert
    expect(xml).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z<\/lastmod>/)
    expect(xml).not.toMatch(/\.\d{3}Z<\/lastmod>/)
  })

  test('omits changefreq and priority because Google ignores both', () => {
    // Act
    const xml = buildSitemap([entry()], SITE)

    // Assert
    expect(xml).not.toContain('changefreq')
    expect(xml).not.toContain('priority')
  })

  test('an empty entry list still yields a valid urlset with the homepage', () => {
    // Act
    const xml = buildSitemap([], SITE)

    // Assert —— 「库里确实没有可索引记录」是事实，如实报告是对的
    expect(xml).toContain('<urlset')
    expect(xml.match(/<url>/g)).toHaveLength(1)
  })
})

describe('fetchIndexable', () => {
  test('follows the cursor until the feed says there is no next page', async () => {
    // Arrange
    const fetchImpl = pagingFetch([
      { items: [feedItem({ id: '1aaaaaaaaa' })], nextCursor: '1aaaaaaaaa' },
      { items: [feedItem({ id: '2bbbbbbbbb' })], nextCursor: null },
    ])

    // Act
    const result = await fetchIndexable('https://gateway.example', { fetchImpl })

    // Assert
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.entries.map((item) => item.id)).toEqual(['1aaaaaaaaa', '2bbbbbbbbb'])
    expect(result.truncated).toBe(false)
  })

  test('stops at MAX_FEED_PAGES and reports truncation', async () => {
    // Arrange —— 永远还有下一页
    const fetchImpl = pagingFetch([{ items: [feedItem()], nextCursor: '1abcdefghi' }])

    // Act
    const result = await fetchIndexable('https://gateway.example', { fetchImpl })

    // Assert —— 截断不是失败：半份 sitemap 仍然让这些页面可被发现
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.entries).toHaveLength(MAX_FEED_PAGES)
    expect(result.truncated).toBe(true)
  })

  test('forwards the visitor ip and the token together, like every other backend call', async () => {
    // Arrange
    let seen: Request | undefined
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Request(input as RequestInfo, init)
      return new Response(JSON.stringify({ success: true, data: { items: [], nextCursor: null } }), {
        status: 200,
      })
    }) as typeof globalThis.fetch

    // Act
    await fetchIndexable('https://gateway.example', {
      fetchImpl,
      gatewayToken: 'secret-token',
      clientIp: '203.0.113.7',
    })

    // Assert —— x-real-ip 而不是 cf-connecting-ip：边缘会把自家 Worker 发来的
    // x-real-ip 提升成下一跳的 cf-connecting-ip，后端读的是提升后的那个
    expect(seen?.headers.get('x-gateway-token')).toBe('secret-token')
    expect(seen?.headers.get('x-real-ip')).toBe('203.0.113.7')
    // UA 不转发：它的唯一用途是访问量统计的爬虫判定，本路径不经过统计
    expect(seen?.headers.get('user-agent')).toBeNull()
  })

  test('sends neither header when the token is missing', async () => {
    // Arrange —— 与 api.ts 的 buildHeaders 同一条绑定：要么一起发，要么都不发
    let seen: Request | undefined
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Request(input as RequestInfo, init)
      return new Response(JSON.stringify({ success: true, data: { items: [], nextCursor: null } }), {
        status: 200,
      })
    }) as typeof globalThis.fetch

    // Act
    await fetchIndexable('https://gateway.example', { fetchImpl, clientIp: '203.0.113.7' })

    // Assert
    expect(seen?.headers.get('x-real-ip')).toBeNull()
    expect(seen?.headers.get('x-gateway-token')).toBeNull()
  })

  test('sends token alone when clientIp is absent (local development case)', async () => {
    // Arrange —— 本地开发（astro dev on node）没有 cf-connecting-ip，但仍需转发密钥
    let seen: Request | undefined
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Request(input as RequestInfo, init)
      return new Response(JSON.stringify({ success: true, data: { items: [], nextCursor: null } }), {
        status: 200,
      })
    }) as typeof globalThis.fetch

    // Act
    await fetchIndexable('https://gateway.example', {
      fetchImpl,
      gatewayToken: 'local-dev-token',
    })

    // Assert —— 密钥独立发送，IP 不依赖它
    expect(seen?.headers.get('x-gateway-token')).toBe('local-dev-token')
    expect(seen?.headers.get('x-real-ip')).toBeNull()
  })

  test('a non-2xx response is an error, never an empty page', async () => {
    // Arrange
    const fetchImpl = (async () => new Response('', { status: 503 })) as typeof globalThis.fetch

    // Act
    const result = await fetchIndexable('https://gateway.example', { fetchImpl })

    // Assert —— 取数失败绝不能退化成「库里没有记录」
    expect(result.kind).toBe('error')
  })

  test('an envelope with success false is an error', async () => {
    // Arrange
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ success: false, data: null, error: 'nope' }), {
        status: 200,
      })) as typeof globalThis.fetch

    // Act
    const result = await fetchIndexable('https://gateway.example', { fetchImpl })

    // Assert
    expect(result.kind).toBe('error')
  })

  test('a malformed item is an error rather than a silently dropped url', async () => {
    // Arrange —— 少一个字段就少一个页面，静默丢弃会让它永远不被发现
    const fetchImpl = pagingFetch([{ items: [{ id: '1abcdefghi' }], nextCursor: null }])

    // Act
    const result = await fetchIndexable('https://gateway.example', { fetchImpl })

    // Assert
    expect(result.kind).toBe('error')
  })

  test('fetch throwing is an error, not an empty result', async () => {
    // Arrange —— fetchImpl 拒绝（网络故障）
    const fetchImpl = (async () => {
      throw new Error('network timeout')
    }) as typeof globalThis.fetch

    // Act
    const result = await fetchIndexable('https://gateway.example', { fetchImpl })

    // Assert —— 取数失败绝不能退化成「库里没有记录」
    expect(result.kind).toBe('error')
    expect(result.message).toContain('feed request failed')
  })

  test('response.json() throwing is an error, not an empty result', async () => {
    // Arrange —— 响应看起来 OK 但 JSON 格式错误
    const fetchImpl = (async () =>
      new Response('not valid json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof globalThis.fetch

    // Act
    const result = await fetchIndexable('https://gateway.example', { fetchImpl })

    // Assert
    expect(result.kind).toBe('error')
    expect(result.message).toContain('invalid JSON')
  })

  test('an envelope that is not an object is an error', async () => {
    // Arrange —— 成功的状态码但返回原始值而非对象
    const fetchImpl = (async () =>
      new Response(JSON.stringify('just a string'), {
        status: 200,
      })) as typeof globalThis.fetch

    // Act
    const result = await fetchIndexable('https://gateway.example', { fetchImpl })

    // Assert
    expect(result.kind).toBe('error')
    expect(result.message).toContain('envelope was not an object')
  })
})
