/**
 * 骨架页的取数端点：GET /api/q/<segment> -> { success, data: { path }, error }。
 *
 * 为什么必须有这一层，而不是让浏览器直接打后端：
 *   1. API_BASE_URL 是 access:'secret' 的服务端变量，浏览器根本拿不到；
 *   2. 后端没有给浏览器开 CORS。
 *
 * 返回体只给规范路径，不给答案正文——答案由 /q/<slug>-<id> 的 SSR 页渲染，
 * markdown 转义、来源协议白名单、JSON-LD 转义那套防线不在浏览器里重来一遍。
 */
import type { APIRoute } from 'astro'
import { API_BASE_URL } from 'astro:env/server'
import { fetchQuestion, toPendingResolution } from '../../../lib/api'

export const prerender = false

/** 后端命中指纹要调模型，慢是常态；但不能没有上限，否则一次卡死会一直占着连接。 */
const BACKEND_TIMEOUT_MS = 90_000

export const GET: APIRoute = async ({ params, request }) => {
  const segment = params.segment ?? ''

  // 与详情页同一条理由：Worker 的出站 fetch 不带 UA，后端会把每一位访客
  // 当成爬虫。骨架页问的通常是原始提问（后端不为这条分支计数），但这一跳
  // 同样可能落在规范路径上，两处保持一致比留一个例外更省心。
  const result = await fetchQuestion(API_BASE_URL, segment, {
    signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    userAgent: request.headers.get('user-agent'),
  })
  const resolution = toPendingResolution(result)

  // 后端地址只进服务端日志。响应体里给固定错误码，不回具体原因。
  if (resolution.status === 502) {
    console.error(`[api/q/${segment}] ${resolution.logMessage}`)
  }

  const body =
    resolution.status === 200
      ? { success: true, data: { path: resolution.path }, error: null }
      : {
          success: false,
          data: null,
          error: resolution.status === 404 ? 'notFound' : 'upstreamUnavailable',
        }

  return new Response(JSON.stringify(body), {
    status: resolution.status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // 结果随时可能从「不存在」翻成「已生成」，任何一层都不许缓存。
      'cache-control': 'private, no-store',
    },
  })
}
