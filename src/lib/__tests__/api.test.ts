import { describe, test, expect } from 'vitest'
import {
  buildQuestionUrl,
  parseQuestionPayload,
  resolveCanonicalRedirect,
  fetchQuestion,
  toPendingResolution,
} from '../api'
import type { Question } from '../types'

const NOW = 1_700_000_000_000

/**
 * 构造一个合法的后端响应，测试内按需覆盖 data 里的单个字段。
 *
 * 注意这里用的是后端的词汇——信封 + query / text / uri，而不是本前端的
 * 领域模型。两者的翻译正是 parseQuestionPayload 的职责。
 */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    success: true,
    data: {
      id: '9k3f8p2wqz',
      fingerprint: 'abc123',
      query: 'How to boil an egg',
      status: 'ready',
      text: 'Boil water, add egg.',
      sources: [{ title: 'Egg Docs', uri: 'https://example.com/egg', publisher: 'Example' }],
      views: 42,
      createdAt: NOW - 1000,
      updatedAt: NOW,
      ...overrides,
    },
    error: null,
  }
}

function stubFetch(response: Response | Error): typeof globalThis.fetch {
  return (async () => {
    if (response instanceof Error) throw response
    return response
  }) as typeof globalThis.fetch
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('buildQuestionUrl', () => {
  test('maps a path segment to <base>/q/<query>', () => {
    // Arrange
    const base = 'http://localhost:3000'

    // Act
    const url = buildQuestionUrl(base, 'how-to-boil-an-egg-9k3f8p2wqz')

    // Assert
    expect(url).toBe('http://localhost:3000/q/how-to-boil-an-egg-9k3f8p2wqz')
  })

  test('strips a trailing slash from the base url', () => {
    // Arrange
    const base = 'http://localhost:3000/'

    // Act
    const url = buildQuestionUrl(base, 'abc-9k3f8p2wqz')

    // Assert
    expect(url).toBe('http://localhost:3000/q/abc-9k3f8p2wqz')
  })

  test('percent-encodes the query so traversal stays one path segment', () => {
    // Arrange
    const base = 'http://localhost:3000'

    // Act
    const url = buildQuestionUrl(base, '../../internal/admin')

    // Assert
    expect(url).toBe('http://localhost:3000/q/..%2F..%2Finternal%2Fadmin')
  })

  test('encodes spaces and CJK in a raw question', () => {
    // Arrange
    const base = 'http://localhost:3000'

    // Act
    const url = buildQuestionUrl(base, 'how to 煮鸡蛋')

    // Assert
    expect(url).toBe('http://localhost:3000/q/how%20to%20%E7%85%AE%E9%B8%A1%E8%9B%8B')
  })
})

describe('parseQuestionPayload', () => {
  test('returns null for a non-object payload', () => {
    // Arrange / Act / Assert
    expect(parseQuestionPayload(null, NOW)).toBeNull()
    expect(parseQuestionPayload('a string', NOW)).toBeNull()
    expect(parseQuestionPayload([], NOW)).toBeNull()
  })

  test('returns null when id or title is missing', () => {
    // Arrange
    const noId = payload({ id: undefined })
    const blankTitle = payload({ query: '   ' })

    // Act / Assert
    expect(parseQuestionPayload(noId, NOW)).toBeNull()
    expect(parseQuestionPayload(blankTitle, NOW)).toBeNull()
  })

  test('returns null for an unknown status', () => {
    // Arrange
    const raw = payload({ status: 'archived' })

    // Act / Assert
    expect(parseQuestionPayload(raw, NOW)).toBeNull()
  })

  test('defaults answerMarkdown to null when absent', () => {
    // Arrange
    const raw = payload({ text: undefined, status: 'pending' })

    // Act
    const question = parseQuestionPayload(raw, NOW)

    // Assert
    expect(question?.answerMarkdown).toBeNull()
  })

  test('drops sources whose url is not http or https', () => {
    // Arrange — 详情页把 source.url 直接写进 href，非 http(s) 协议即是 XSS 入口
    const raw = payload({
      sources: [
        { title: 'Safe', uri: 'https://example.com/ok' },
        { title: 'Evil', uri: 'javascript:alert(1)' },
        { title: 'Data', uri: 'data:text/html,<script>alert(1)</script>' },
        { title: 'Missing uri' },
      ],
    })

    // Act
    const question = parseQuestionPayload(raw, NOW)

    // Assert
    expect(question?.sources).toHaveLength(1)
    expect(question?.sources[0]?.url).toBe('https://example.com/ok')
  })

  test('drops a source whose uri is not a parseable url', () => {
    // Arrange — 后端投毒或字段串位时 uri 可能根本不是 URL，白名单必须先扛住解析失败
    const raw = payload({
      sources: [
        { title: 'Broken', uri: 'not a url at all' },
        { title: 'Safe', uri: 'https://example.com/ok' },
      ],
    })

    // Act
    const question = parseQuestionPayload(raw, NOW)

    // Assert — 解析不出协议就当作不安全，而不是让它进 href
    expect(question?.sources).toEqual([{ title: 'Safe', url: 'https://example.com/ok' }])
  })

  test('defaults views to 0 and timestamps to the supplied now', () => {
    // Arrange
    const raw = payload({ views: undefined, createdAt: undefined, updatedAt: undefined })

    // Act
    const question = parseQuestionPayload(raw, NOW)

    // Assert
    expect(question?.views).toBe(0)
    expect(question?.createdAt).toBe(NOW)
    expect(question?.updatedAt).toBe(NOW)
  })

  test('preserves tags and the demoted flag when present', () => {
    // Arrange
    const raw = payload({ tags: ['Cooking', 'Eggs'], demoted: true })

    // Act
    const question = parseQuestionPayload(raw, NOW)

    // Assert
    expect(question?.tags).toEqual(['Cooking', 'Eggs'])
    expect(question?.demoted).toBe(true)
  })

  test('reads the backend envelope rather than a bare object', () => {
    // Arrange — 后端所有响应都包在 { success, data, error } 里
    const raw = payload()

    // Act
    const question = parseQuestionPayload(raw, NOW)

    // Assert — 后端说 query / text，领域模型说 title / answerMarkdown
    expect(question?.id).toBe('9k3f8p2wqz')
    expect(question?.title).toBe('How to boil an egg')
    expect(question?.answerMarkdown).toBe('Boil water, add egg.')
    expect(question?.fingerprint).toBe('abc123')
  })

  test('returns null for a failure envelope', () => {
    // Arrange
    const raw = { success: false, data: null, error: 'service unavailable' }

    // Act / Assert — 失败信封绝不能被当成半个页面渲染出去
    expect(parseQuestionPayload(raw, NOW)).toBeNull()
  })

  test('returns null when the envelope carries no data', () => {
    // Act / Assert
    expect(parseQuestionPayload({ success: true, data: null, error: null }, NOW)).toBeNull()
  })

  test('returns null for a bare object that is not wrapped in an envelope', () => {
    // Arrange — 旧契约的形状不该被悄悄接受
    const raw = {
      id: '9k3f8p2wqz',
      query: 'How to boil an egg',
      status: 'ready',
      text: 'Boil water, add egg.',
    }

    // Act / Assert
    expect(parseQuestionPayload(raw, NOW)).toBeNull()
  })

  test('maps a source uri onto the domain url field', () => {
    // Arrange — 后端叫 uri，详情页写进 href 的是 url
    const raw = payload({
      sources: [{ title: 'Egg Docs', uri: 'https://example.com/egg', publisher: 'Example' }],
    })

    // Act
    const question = parseQuestionPayload(raw, NOW)

    // Assert
    expect(question?.sources).toEqual([
      { title: 'Egg Docs', url: 'https://example.com/egg', publisher: 'Example' },
    ])
  })

  test('always derives the slug from the title so it matches the canonical path', () => {
    // Arrange — 后端给的 slug 一律忽略，规范路径只认 toSlug(title)，避免两处真相打架
    const omitted = payload({ slug: undefined })
    const conflicting = payload({ slug: 'some-stale-backend-slug' })

    // Act / Assert
    expect(parseQuestionPayload(omitted, NOW)?.slug).toBe('how-to-boil-an-egg')
    expect(parseQuestionPayload(conflicting, NOW)?.slug).toBe('how-to-boil-an-egg')
  })
})

describe('resolveCanonicalRedirect', () => {
  const question: Question = {
    id: '9k3f8p2wqz',
    slug: 'how-to-boil-an-egg',
    fingerprint: 'abc',
    title: 'How to boil an egg',
    status: 'ready',
    answerMarkdown: 'x',
    sources: [],
    views: 0,
    createdAt: NOW,
    updatedAt: NOW,
  }

  test('returns null when the requested segment is already canonical', () => {
    // Act
    const target = resolveCanonicalRedirect('how-to-boil-an-egg-9k3f8p2wqz', question)

    // Assert
    expect(target).toBeNull()
  })

  test('returns the canonical path when the slug is stale', () => {
    // Act — 标题优化后旧 slug 必须 301 到新规范路径，外链权重不丢
    const target = resolveCanonicalRedirect('how-do-i-boil-eggs-9k3f8p2wqz', question)

    // Assert
    expect(target).toBe('/q/how-to-boil-an-egg-9k3f8p2wqz')
  })

  test('returns a header-safe path when the canonical slug contains CJK', () => {
    // Arrange — 301 的 Location 必须能放进 HTTP 头，否则整页 500
    const cjk: Question = {
      ...question,
      id: '1xwndu4p7c',
      slug: 'debian13开启bbr',
      title: 'debian13开启bbr',
    }

    // Act
    const target = resolveCanonicalRedirect('debian13开启bbr', cjk)

    // Assert
    expect(target).toBe('/q/debian13%E5%BC%80%E5%90%AFbbr-1xwndu4p7c')
  })

  test('returns null when a CJK segment is already canonical', () => {
    // Arrange — 比较必须发生在解码态，否则规范 URL 会不断 301 到自己
    const cjk: Question = {
      ...question,
      id: '1xwndu4p7c',
      slug: 'debian13开启bbr',
      title: 'debian13开启bbr',
    }

    // Act
    const target = resolveCanonicalRedirect('debian13开启bbr-1xwndu4p7c', cjk)

    // Assert
    expect(target).toBeNull()
  })

  test('returns the canonical path when a raw question was requested', () => {
    // Act
    const target = resolveCanonicalRedirect('how to boil an egg', question)

    // Assert
    expect(target).toBe('/q/how-to-boil-an-egg-9k3f8p2wqz')
  })
})

describe('fetchQuestion', () => {
  test('returns ok with the parsed question on 200', async () => {
    // Arrange
    const fetchImpl = stubFetch(jsonResponse(payload()))

    // Act
    const result = await fetchQuestion('http://localhost:3000', 'abc-9k3f8p2wqz', { fetchImpl, nowMs: NOW })

    // Assert
    expect(result.kind).toBe('ok')
    expect(result.kind === 'ok' && result.question.title).toBe('How to boil an egg')
  })

  test('returns notFound on 404', async () => {
    // Arrange
    const fetchImpl = stubFetch(new Response(null, { status: 404 }))

    // Act
    const result = await fetchQuestion('http://localhost:3000', 'missing-000000', { fetchImpl, nowMs: NOW })

    // Assert
    expect(result.kind).toBe('notFound')
  })

  test('treats a rejected query as missing rather than as a backend fault', async () => {
    // Arrange — 后端对空/超长/被拒的提问返回 400，这类 URL 永远不会成立
    const fetchImpl = stubFetch(jsonResponse({ success: false, data: null, error: 'x' }, 400))

    // Act
    const result = await fetchQuestion('http://localhost:3000', ' ', { fetchImpl, nowMs: NOW })

    // Assert — 404 让搜索引擎剔除它；502 会让爬虫无限重试一个死链
    expect(result.kind).toBe('notFound')
  })

  test('returns error on a 500 from the backend', async () => {
    // Arrange
    const fetchImpl = stubFetch(new Response('boom', { status: 500 }))

    // Act
    const result = await fetchQuestion('http://localhost:3000', 'abc-9k3f8p2wqz', { fetchImpl, nowMs: NOW })

    // Assert
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.message).toContain('500')
  })

  test('returns error when the payload fails validation', async () => {
    // Arrange
    const fetchImpl = stubFetch(jsonResponse({ id: '9k3f8p2wqz' }))

    // Act
    const result = await fetchQuestion('http://localhost:3000', 'abc-9k3f8p2wqz', { fetchImpl, nowMs: NOW })

    // Assert
    expect(result.kind).toBe('error')
  })

  test('returns error instead of throwing when the backend is unreachable', async () => {
    // Arrange — 后端没起时不能让整页 500 白屏
    const fetchImpl = stubFetch(new TypeError('fetch failed'))

    // Act
    const result = await fetchQuestion('http://localhost:3000', 'abc-9k3f8p2wqz', { fetchImpl, nowMs: NOW })

    // Assert
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.message).toContain('fetch failed')
  })

  test('returns error when the response body is not valid json', async () => {
    // Arrange
    const fetchImpl = stubFetch(new Response('<html>oops</html>', { status: 200 }))

    // Act
    const result = await fetchQuestion('http://localhost:3000', 'abc-9k3f8p2wqz', { fetchImpl, nowMs: NOW })

    // Assert
    expect(result.kind).toBe('error')
  })
})

describe('toPendingResolution', () => {
  const question: Question = {
    id: '9k3f8p2wqz',
    slug: 'how-to-boil-an-egg',
    fingerprint: 'abc',
    title: 'How to boil an egg',
    status: 'ready',
    answerMarkdown: 'x',
    sources: [],
    views: 0,
    createdAt: NOW,
    updatedAt: NOW,
  }

  test('resolves to 200 plus the canonical path the browser should jump to', () => {
    // Act
    const resolution = toPendingResolution({ kind: 'ok', question })

    // Assert
    expect(resolution).toEqual({ status: 200, path: '/q/how-to-boil-an-egg-9k3f8p2wqz' })
  })

  test('percent-encodes a CJK canonical path so location.replace lands on the right URL', () => {
    // Arrange
    const cjk: Question = { ...question, id: '1xwndu4p7c', slug: 'debian13开启bbr', title: 'debian13开启bbr' }

    // Act
    const resolution = toPendingResolution({ kind: 'ok', question: cjk })

    // Assert
    expect(resolution).toEqual({ status: 200, path: '/q/debian13%E5%BC%80%E5%90%AFbbr-1xwndu4p7c' })
  })

  test('maps notFound to 404 so the shell stops waiting instead of spinning forever', () => {
    // Act
    const resolution = toPendingResolution({ kind: 'notFound' })

    // Assert
    expect(resolution).toEqual({ status: 404 })
  })

  test('maps error to 502 and keeps the backend detail for the server log only', () => {
    // Arrange — message 含 API_BASE_URL，只能进服务端日志，不能回给浏览器
    const result = { kind: 'error', message: 'Backend request to http://localhost:3000/q/x failed' } as const

    // Act
    const resolution = toPendingResolution(result)

    // Assert
    expect(resolution).toEqual({ status: 502, logMessage: result.message })
  })
})

describe('fetchQuestion abort support', () => {
  test('forwards the abort signal to the injected fetch', async () => {
    // Arrange — 代理端点要能给后端调用设超时，否则慢的模型调用会一直占着连接
    const controller = new AbortController()
    let seenSignal: AbortSignal | null | undefined
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      seenSignal = init?.signal
      return jsonResponse(payload())
    }) as unknown as typeof globalThis.fetch

    // Act
    await fetchQuestion('http://localhost:3000', 'abc-9k3f8p2wqz', {
      fetchImpl,
      nowMs: NOW,
      signal: controller.signal,
    })

    // Assert
    expect(seenSignal).toBe(controller.signal)
  })

  test('returns error instead of throwing when the request is aborted', async () => {
    // Arrange
    const fetchImpl = stubFetch(new DOMException('The operation was aborted.', 'TimeoutError'))

    // Act
    const result = await fetchQuestion('http://localhost:3000', 'abc-9k3f8p2wqz', { fetchImpl, nowMs: NOW })

    // Assert
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.message).toContain('aborted')
  })
})

describe('fetchQuestion user agent forwarding', () => {
  /** 取出注入的 fetch 实际收到的头，统一成 Headers 再断言。 */
  function captureHeaders(): {
    fetchImpl: typeof globalThis.fetch
    seen: () => Headers
  } {
    let captured: Headers = new Headers()
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      captured = new Headers(init?.headers)
      return jsonResponse(payload())
    }) as unknown as typeof globalThis.fetch
    return { fetchImpl, seen: () => captured }
  }

  test('forwards the visitor user agent so the backend can tell a browser from a crawler', async () => {
    // Arrange —— SSR 是访客与后端之间的唯一一跳，这里不带 UA，后端就只能
    // 看到一个没有 UA 的请求，把每一个真实访客都当成爬虫
    const { fetchImpl, seen } = captureHeaders()
    const chrome =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

    // Act
    await fetchQuestion('http://localhost:3000', 'abc-9k3f8p2wqz', {
      fetchImpl,
      nowMs: NOW,
      userAgent: chrome,
    })

    // Assert
    expect(seen().get('user-agent')).toBe(chrome)
  })

  test('forwards a crawler user agent unchanged rather than laundering it into a browser', async () => {
    // Arrange —— 透传必须是原样的：改写或补一个默认浏览器 UA，会让爬虫流量
    // 在后端被算成真人访问，热门榜随即退化成爬虫榜
    const { fetchImpl, seen } = captureHeaders()
    const googlebot = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'

    // Act
    await fetchQuestion('http://localhost:3000', 'abc-9k3f8p2wqz', {
      fetchImpl,
      nowMs: NOW,
      userAgent: googlebot,
    })

    // Assert
    expect(seen().get('user-agent')).toBe(googlebot)
  })

  test('sends no user-agent header when the visitor did not send one', async () => {
    // Arrange —— 缺失就是缺失，不能补一个代表本站的 UA：后端把「无 UA」
    // 判成爬虫是它的既定规则，这里伪造一个等于替访客撒谎
    const { fetchImpl, seen } = captureHeaders()

    // Act
    await fetchQuestion('http://localhost:3000', 'abc-9k3f8p2wqz', { fetchImpl, nowMs: NOW })

    // Assert
    expect(seen().has('user-agent')).toBe(false)
    expect(seen().get('accept')).toBe('application/json')
  })

  test('sends no user-agent header when the visitor sent an empty one', async () => {
    // Arrange —— 空串与缺失同义，后端对两者的判定也相同
    const { fetchImpl, seen } = captureHeaders()

    // Act
    await fetchQuestion('http://localhost:3000', 'abc-9k3f8p2wqz', {
      fetchImpl,
      nowMs: NOW,
      userAgent: '',
    })

    // Assert
    expect(seen().has('user-agent')).toBe(false)
  })

  test('drops a user agent that is not a legal header value instead of failing the request', async () => {
    // Arrange —— UA 是访客可控输入。带 CR/LF 的值若原样拼进出站请求就是
    // 头注入；宁可丢掉这次计数，也不能让一个畸形 UA 把页面变成 500
    const { fetchImpl, seen } = captureHeaders()

    // Act
    const result = await fetchQuestion('http://localhost:3000', 'abc-9k3f8p2wqz', {
      fetchImpl,
      nowMs: NOW,
      userAgent: 'Mozilla/5.0\r\nX-Injected: 1',
    })

    // Assert
    expect(seen().has('user-agent')).toBe(false)
    expect(seen().get('accept')).toBe('application/json')
    expect(result.kind).toBe('ok')
  })

  test('sends no user-agent header when the caller passes null', async () => {
    // Arrange —— 两个调用点拿到的都是 headers.get() 的返回值，也就是
    // string | null 而非 undefined；null 这条分支必须被钉住
    const { fetchImpl, seen } = captureHeaders()

    // Act
    await fetchQuestion('http://localhost:3000', 'abc-9k3f8p2wqz', {
      fetchImpl,
      nowMs: NOW,
      userAgent: null,
    })

    // Assert
    expect(seen().has('user-agent')).toBe(false)
    expect(seen().get('accept')).toBe('application/json')
  })
})
