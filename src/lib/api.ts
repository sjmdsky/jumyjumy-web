/**
 * 后端契约层：/q/<query> -> <API_BASE_URL>/q/<query>（后端返回 JSON）。
 *
 * 这里承担三件事，每一件都对应一条硬约束：
 *
 * 1. 路径编码。<query> 直接来自 URL，是用户可控输入。不编码的话
 *    `/q/../../internal/admin` 会被后端当成路径穿越。encodeURIComponent 把整段
 *    压成单个 path segment，斜杠变 %2F，穿越不成立。
 * 2. 边界校验。后端返回的 JSON 一律视为不可信数据。响应统一包在信封
 *    `{ success, data, error }` 里，`success` 是契约的一部分——跳过它就等于
 *    把一条失败响应当成内容渲染。尤其 `sources[].uri`——
 *    详情页把它直接写进 <a href>，一旦放进 `javascript:` / `data:` 就是 XSS。
 *    所以协议白名单只留 http/https，不合规的来源整条丢弃而非渲染。
 * 3. 规范路径判定。slug 只是装饰，id 才是永久主键；请求段与
 *    buildPath(title, id) 不一致时必须 301 到规范路径，外链权重不丢。
 *    这是「随时改标题提升 CTR」能成为零风险操作的前提。
 *
 * 副作用（fetch）以参数注入，保证本模块可单测、且不绑定运行时——
 * 之后迁到 Cloudflare Workers 时无需改动。
 */

import { buildPath, encodePath, toSlug } from './slug'
import type { Question, QuestionStatus, Source } from './types'

const VALID_STATUSES: readonly string[] = ['pending', 'ready', 'rejected']
const SAFE_URL_PROTOCOLS: readonly string[] = ['http:', 'https:']

/**
 * 取数结果用判别联合表达，而不是抛异常或返回 null。
 * 页面层必须显式区分「不存在」（发 404）和「后端故障」（发 502），
 * 两者混为一谈会产生 soft 404，拖累全站抓取预算。
 */
export type QuestionResult =
  | { readonly kind: 'ok'; readonly question: Question }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'error'; readonly message: string }

export interface FetchQuestionOptions {
  readonly fetchImpl?: typeof globalThis.fetch
  readonly nowMs?: number
  /** 中止信号。代理端点用它给后端调用设超时，否则一次慢的模型调用会一直占着连接。 */
  readonly signal?: AbortSignal
  /**
   * 访客的 User-Agent，原样透传给后端。缺失/为空时不发这个头。
   *
   * 存在的理由只有一个：SSR 是访客与后端之间的唯一一跳。Worker 的出站
   * fetch 默认只带 Host / Accept / CF-Worker，**不带 UA**，于是后端收到的
   * 每一个请求都「没有 UA」——而它把无 UA 判定为爬虫，真实访客因此一个
   * 都不计入访问量。这个字段就是把访客的身份接回那一跳。
   *
   * 必须原样转发：补一个默认浏览器 UA 会把爬虫洗成真人，后端的热门度
   * 统计随即退化成「爬虫抓得最勤的页面榜」；缺失时伪造一个同理。
   */
  readonly userAgent?: string | null
}

export function buildQuestionUrl(baseUrl: string, query: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, '')
  return `${normalizedBase}/q/${encodeURIComponent(query)}`
}

/**
 * 后端 JSON -> 领域模型。任何一项必需字段不合规即返回 null，宁可报错也不渲染半个页面。
 *
 * 入参是整个信封 `{ success, data, error }`，不是里面的 data。
 *
 * 两侧的词汇不同——后端说 query / text / uri，本前端说 title / answerMarkdown / url。
 * 翻译只发生在这里；页面层只认识领域模型，不该知道后端叫什么。
 */
export function parseQuestionPayload(raw: unknown, nowMs: number): Question | null {
  const envelope = readObject(raw)
  if (!envelope || envelope['success'] !== true) return null

  const data = readObject(envelope['data'])
  if (!data) return null

  const id = readNonEmptyString(data['id'])
  // 后端的 query 就是本站的标题：问题原文即页面主题。
  const title = readNonEmptyString(data['query'])
  if (!id || !title) return null

  // status 决定是否 noindex，缺省成任何一个值都是错的（误索引 or 误屏蔽），因此必填。
  const status = readStatus(data['status'])
  if (!status) return null

  const base: Question = {
    id,
    // slug 恒由 title 派生，与 buildPath 保持单一真相；后端若下发 slug 一律忽略。
    slug: toSlug(title),
    fingerprint: readNonEmptyString(data['fingerprint']) ?? '',
    title,
    status,
    answerMarkdown: readNullableString(data['text']),
    sources: readSources(data['sources']),
    views: readFiniteNumber(data['views']) ?? 0,
    createdAt: readFiniteNumber(data['createdAt']) ?? nowMs,
    updatedAt: readFiniteNumber(data['updatedAt']) ?? nowMs,
  }

  const tags = readTags(data['tags'])
  const demoted = data['demoted'] === true

  // 可选字段缺省时不落键，避免下游把 undefined 当成「显式为空」。
  return {
    ...base,
    ...(tags ? { tags } : {}),
    ...(demoted ? { demoted } : {}),
  }
}

/**
 * 请求段与规范路径不一致时返回规范路径，一致时返回 null。
 *
 * 路由只在 isIdLookupSegment 为真时才走到这里，所以现实中的唯一场景是旧 slug
 * （标题改过）。原始提问文本不再从这里 301——它被 rewrite 成骨架页，由浏览器
 * 拿到规范路径后 location.replace 过去。函数本身仍按纯比较处理任意段。
 *
 * 比较用解码态的路径，返回值用编码态：`Astro.params` 给的是解码后的段，
 * 而 Location 头只接受 ByteString。两者混用会让含 CJK 的规范 URL 要么
 * 500，要么无限 301 到自己。
 */
export function resolveCanonicalRedirect(
  requestedSegment: string,
  question: Question,
): string | null {
  const canonicalPath = buildPath(question.title, question.id)
  return `/q/${requestedSegment}` === canonicalPath ? null : encodePath(canonicalPath)
}

/**
 * 骨架页的取数结果 -> 浏览器要看到的 HTTP 语义。
 *
 * 原始提问段不阻塞 SSR，而是先发 200 骨架页，由浏览器打代理端点等结果。
 * 这里把 QuestionResult 翻译成端点的状态码：
 *   ok       -> 200 + 规范路径，浏览器 location.replace 过去，由 SSR 渲染真正的答案页
 *   notFound -> 404，骨架页停止等待（后端对空/超长提问发 400，这类 URL 永远不会成立）
 *   error    -> 502，骨架页给出重试入口
 *
 * path 是编码态：它要进 location.replace，含 CJK 的规范路径不编码会落到错误的 URL。
 * error 分支单独留 logMessage 而不是塞进响应体——message 里含 API_BASE_URL，
 * 只能进服务端日志，回给浏览器就是把内网地址泄露出去。
 */
export type PendingResolution =
  | { readonly status: 200; readonly path: string }
  | { readonly status: 404 }
  | { readonly status: 502; readonly logMessage: string }

export function toPendingResolution(result: QuestionResult): PendingResolution {
  if (result.kind === 'notFound') return { status: 404 }
  if (result.kind === 'error') return { status: 502, logMessage: result.message }
  return { status: 200, path: encodePath(buildPath(result.question.title, result.question.id)) }
}

export async function fetchQuestion(
  baseUrl: string,
  query: string,
  options: FetchQuestionOptions = {},
): Promise<QuestionResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const nowMs = options.nowMs ?? Date.now()
  const url = buildQuestionUrl(baseUrl, query)

  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: buildHeaders(options.userAgent),
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (cause) {
    // 后端没起 / 网络不通：降级为 error，由页面发 502，绝不让异常冒泡成白屏。
    return { kind: 'error', message: `Backend request to ${url} failed: ${describeError(cause)}` }
  }

  // 400 与 404 都归为「这个页面不存在」：后端对空/超长/被上游拒答的提问返回
  // 400，这类 URL 永远不会成立，发 502 只会让爬虫无限重试一个死链。
  if (response.status === 404 || response.status === 400) return { kind: 'notFound' }
  if (!response.ok) {
    return { kind: 'error', message: `Backend responded ${response.status} for ${url}` }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (cause) {
    return {
      kind: 'error',
      message: `Backend returned invalid JSON for ${url}: ${describeError(cause)}`,
    }
  }

  const question = parseQuestionPayload(payload, nowMs)
  if (!question) return { kind: 'error', message: `Backend payload for ${url} failed validation` }

  return { kind: 'ok', question }
}

/**
 * 合法的头值字符集：制表符加可见 ASCII。
 *
 * 比 RFC 9110 的 field-value 更严，且刻意与后端 `HeaderValue::to_str` 的
 * 判据对齐——超出这个集合的 UA 到了后端也会被读成「没有 UA」，在这里就
 * 丢掉，两侧结论一致。真正要挡的是 CR/LF：UA 是访客可控输入，原样拼进
 * 出站请求就是头注入。
 */
const LEGAL_HEADER_VALUE = /^[\t\x20-\x7e]+$/

/**
 * 出站请求的头。UA 不合法就整个不发——宁可丢掉这一次计数，也不能让一个
 * 畸形 UA 把一个本来能渲染的页面变成 500。
 */
function buildHeaders(userAgent: string | null | undefined): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (userAgent && LEGAL_HEADER_VALUE.test(userAgent)) headers['user-agent'] = userAgent
  return headers
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readStatus(value: unknown): QuestionStatus | null {
  return typeof value === 'string' && VALID_STATUSES.includes(value)
    ? (value as QuestionStatus)
    : null
}

function readTags(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null
  const tags = value.flatMap((tag) => {
    const parsed = readNonEmptyString(tag)
    return parsed ? [parsed] : []
  })
  return tags.length > 0 ? tags : null
}

function readSources(value: unknown): readonly Source[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((item) => {
    const entry = readObject(item)
    if (!entry) return []

    const title = readNonEmptyString(entry['title'])
    // 后端叫 uri，领域模型叫 url——详情页写进 href 的是后者。
    const url = readNonEmptyString(entry['uri'])
    if (!title || !url || !isSafeHttpUrl(url)) return []

    const publisher = readNonEmptyString(entry['publisher'])
    return [publisher ? { title, url, publisher } : { title, url }]
  })
}

/** 只放行 http/https。详情页的来源链接是原样写进 href 的，协议白名单是唯一的防线。 */
function isSafeHttpUrl(value: string): boolean {
  try {
    return SAFE_URL_PROTOCOLS.includes(new URL(value).protocol)
  } catch {
    return false
  }
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
