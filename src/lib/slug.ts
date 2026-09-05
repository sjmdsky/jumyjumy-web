/**
 * URL 结构：/q/<slug>-<id>
 *
 * id 是永久主键，slug 只是可读装饰。标题优化后 slug 变化 → 301 到规范路径，
 * 权重不丢。这让「随时改标题提升 CTR」成为零风险操作。
 */

const MAX_SLUG_LENGTH = 80
const FALLBACK_SLUG = 'q'

/**
 * id 的形状：首位十进制数字 + 其余小写 base36，总长 10–12。
 *
 * 与后端 `question.rs` 的 `is_id` 是同一个约定（`ID_MIN_LENGTH`..`ID_MAX_LENGTH`），
 * 任何一侧改动都必须同步，否则所有规范 URL 都会失配。两点不是随手定的：
 *
 * - **首位强制数字**：英文单词不以数字开头，`/q/learn-kubernetes`、
 *   `/q/rust-webassembly` 这类提问因此不会被误判成规范 URL 而 404。
 *   旧的「末尾 6 位 base36」没有这道闸，`nodejs-sqlite` 就会误伤。
 * - **写成长度范围**：后端将来把生成长度提到 12 位时，已经发出去的 10 位 id
 *   仍然解析得动——那时两侧都不必再动，也不必迁移数据或发 301。
 *
 * 旧的 6 位形状不保留兼容分支，旧 URL 也不做重定向表——是彻底放弃，不是待办。
 * 后端已经不认它，前端多认一种只会把 `enable-bbr-zzzzzz` 这类提问错误地送进
 * 阻塞取数的 id 分支；而两侧都不认之后，这种段落自然回落成提问，由后端按新
 * id 重新作答。别再往这里加第二种形状。
 */
const ID_PATTERN = /^[0-9][0-9a-z]{9,11}$/

export function toSlug(title: string): string {
  const normalized = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')

  if (!normalized) return FALLBACK_SLUG
  if (normalized.length <= MAX_SLUG_LENGTH) return normalized

  const clipped = normalized.slice(0, MAX_SLUG_LENGTH)
  const lastBoundary = clipped.lastIndexOf('-')
  const trimmed = lastBoundary > 0 ? clipped.slice(0, lastBoundary) : clipped
  return trimmed.replace(/-+$/, '') || FALLBACK_SLUG
}

export function buildPath(title: string, id: string): string {
  return `/q/${toSlug(title)}-${id}`
}

/**
 * 把逻辑路径编码成可以直接写进 Location 头或 href 的形式。
 *
 * `toSlug` 刻意保留 CJK——中文 slug 对中文检索是加分项。代价是这样的
 * 路径不能原样进 HTTP 头：头部值是 ByteString，`开`（U+5F00）会让
 * `new Response` 抛 TypeError，整页变成 500。
 *
 * 编码只发生在「路径变成 URL」这一步；`resolveCanonicalRedirect` 的比较
 * 仍在解码态进行，否则规范 URL 会不停 301 到它自己。
 */
export function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/**
 * 从路径片段中取回 id。slug 部分只作参考——真正的存在性由仓储层判定，
 * 所以这里只查形状（末段符合 ID_PATTERN 即视为候选 id）。
 *
 * 按最后一个连字符切分，与后端 `extract_id` 的 `rsplit_once('-')` 对齐：
 * slug 自己带连字符是常态，从前往后切会把 id 切碎。
 */
export function parseSlugId(segment: string): { slug: string; id: string } | null {
  const separator = segment.lastIndexOf('-')
  if (separator <= 0) return null

  const id = segment.slice(separator + 1)
  if (!ID_PATTERN.test(id)) return null

  return { slug: segment.slice(0, separator), id }
}

/**
 * 这一段会不会被后端当成「按 id 查」？
 *
 * 后端的分流规则是形状判定：无空白字符，且最后一个 `-` 之后符合 ID_PATTERN。
 * 命中就直接查存量记录（不调模型，快），否则一律当成提问走生成流程（调模型，慢）。
 *
 * 前端必须用同一条规则决定要不要阻塞 SSR。加上首位数字规则之后，两者只剩空白
 * 这一点分歧：`parseSlugId` 刻意不排空白，而首页提问框发出的是
 * `encodeURIComponent(问题原文)`，多词问题解码后必然带空格。`debian 13-1xwndu4p7c`
 * 在 parseSlugId 眼里是规范 URL，在后端眼里是一句提问——按前者去阻塞取数，
 * 页面就会卡在模型调用上，最终 502。
 *
 * 形状规则本身只在 ID_PATTERN 里写一次，避免两个正则各自漂移。
 */
export function isIdLookupSegment(segment: string): boolean {
  if (/\s/.test(segment)) return false
  return parseSlugId(segment) !== null
}
