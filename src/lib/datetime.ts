/**
 * 详情页的更新时间格式化。
 *
 * 时间要精确到秒、按访客本地时区显示，但 SSR 拿不到访客时区——服务端只能先渲染
 * 一个确定的值，再由客户端脚本换成本地时区。所以这里只有一个函数，两边共用：
 * 服务端不传 timeZone（默认 UTC），客户端传 resolvedOptions().timeZone。
 *
 * 默认 UTC 而不是服务器本地时区，有两个理由：
 *   1. 同一份 HTML 对所有访客一致，才能安全地放进边缘缓存（s-maxage=60）；
 *   2. 部署环境的 TZ 不该泄漏到页面上，也不该让输出随部署机器变化。
 *
 * 输出恒带时区缩写。没有 JS 时页面会停在服务端渲染的 UTC 上，不标注时区就是把
 * UTC 冒充成本地时间。机器可读的那一份在 <time datetime> 里，是完整 ISO 瞬时值。
 *
 * 只用 Intl.*，不碰 Node 内置模块，保持 Cloudflare Workers 兼容。
 */

const FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  // 24 小时制：AM/PM 在「精确到秒」的场景里只会增加读数负担。
  hour12: false,
  timeZoneName: 'short',
}

const FALLBACK_TIME_ZONE = 'UTC'

export function formatTimestamp(ms: number, timeZone: string = FALLBACK_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-US', {
    ...FORMAT_OPTIONS,
    timeZone: resolveTimeZone(timeZone),
  }).format(new Date(ms))
}

/**
 * 时区字符串来自浏览器，属于边界输入。Intl 对无法识别的值直接抛 RangeError，
 * 会把整个脚本打断、时间停在服务端渲染的值上——宁可回落 UTC，也不静默炸掉。
 */
function resolveTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return timeZone
  } catch {
    return FALLBACK_TIME_ZONE
  }
}
