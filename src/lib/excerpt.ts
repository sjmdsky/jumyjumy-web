/**
 * 把答案 markdown 压成一句纯文本摘要，供 `<meta name="description">` 使用。
 *
 * 这个字段同时服务两个消费者，而它们的裁剪长度差一个数量级：
 *   - 搜索引擎摘要约 155 字符，超出的部分被省略号吃掉；
 *   - 微信的链接卡片只显示约两行，中文四五十字。
 * 两者都从同一句开头读起，所以一份 150 字符的摘要够用，不需要两套。上限按
 * 搜索引擎定，微信自己会截断。
 *
 * **为什么不能直接把标题塞进 description。** 卡片的标题和摘要是两栏，喂同一
 * 句话进去，转发出去就是同一行文字重复两遍。摘要必须来自答案正文。
 *
 * 剥除规则有一条不对称：行内标记（粗体、行内代码、链接）保留文字、去掉符号；
 * 而纯结构内容（围栏代码块、表格）整段丢弃。理由是 150 字符里塞一段 sysctl
 * 命令或者半张 `| --- | --- |` 表格，卡片看上去就是坏的——正文句子远比它们
 * 有信息量。代价是「整篇答案只有一个代码块」时摘要为空，由调用方回落。
 *
 * 零依赖纯函数，只用 String 与 RegExp，保持 Cloudflare Workers 兼容。
 */

/** 摘要上限。按搜索引擎摘要长度定，见文件头。 */
export const EXCERPT_MAX_CHARS = 150

/**
 * 断句点最早允许出现的位置，按上限的比例算。
 *
 * 没有这道闸时，「好。」后面跟四十个字的答案会被截成两个字——开头第一个句号
 * 就在第 1 个字符上，采纳它等于把摘要扔掉。低于这个比例的边界一律不采纳，
 * 宁可硬切加省略号。
 */
const MIN_BOUNDARY_RATIO = 0.6

const ELLIPSIS = '…'

/** 句末标点的候选。是不是真的句末由 isSentenceEnd 判，见那里。 */
const SENTENCE_END = /[。！？.!?]/g

/** 中文句末标点无条件成立，不看后一个字符。 */
const CJK_SENTENCE_END = /[。！？]/

/** 落单的高位代理码元，出现在按 UTF-16 码元切分的末尾。 */
const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF]$/

/** 围栏代码块的起止行，``` 与 ~~~ 两种写法。 */
const FENCE = /^(?:```|~~~)/

/**
 * 行首竖线。表格的识别主力是 findTableLines（锚在分隔行上），这条只是兜底：
 * 分隔行本身缺失或畸形时，带行首竖线的残行仍然不该漏进摘要。
 */
const TABLE_ROW = /^\|/

/**
 * 分隔线，以及 setext 标题的下划线——`---` 与 `===` 都是，两种都该丢。
 * 少了 `=` 那一条，`My Heading\n===` 会把三个等号原样带进摘要。
 */
const HORIZONTAL_RULE = /^(?:-{3,}|\*{3,}|_{3,}|={2,})$/

/**
 * 表格的分隔行，例如 `| --- | --- |` 或省略行首竖线的 `--- | ---`。
 *
 * 它是识别表格的锚点：GFM 里表格必须有这一行，而 markdown.ts 的
 * splitTableRow 明确支持省略首尾竖线。只按行首竖线判会漏掉渲染器认账的那一半
 * 表格，半张管道网格就会漏进卡片。
 */
const TABLE_DELIMITER_ROW = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?$/

/** 行首的块级标记：引用、标题、无序列表、有序列表。 */
const LINE_MARKERS: readonly RegExp[] = [/^>+\s*/, /^#{1,6}\s+/, /^[-*+]\s+/, /^\d+[.)]\s+/]

/**
 * 剥成一行纯文本。空输入返回空串——调用方据此决定回落文案。
 */
export function toPlainText(markdown: string | null): string {
  if (!markdown) return ''
  return stripInline(keepProseLines(markdown).join(' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 逐行过滤：丢掉围栏代码块、表格、分隔线与空行，剥掉留下来那些行的行首标记。
 *
 * 按行处理而不是拿正则匹配整块，是为了未闭合的围栏——答案被上游截断时
 * 结尾只有一个 ``` 开头，正则匹配不到配对的结束标记，会把整段代码原样漏进
 * 摘要。行内状态机把「开了就一直开到结尾」这件事表达成了默认行为。
 */
function keepProseLines(markdown: string): string[] {
  const lines = markdown.split('\n').map((line) => line.trim())
  const tableLines = findTableLines(lines)
  const kept: string[] = []
  let isInsideFence = false

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]

    if (FENCE.test(line)) {
      isInsideFence = !isInsideFence
      continue
    }
    if (isInsideFence) continue
    if (!line) continue
    if (tableLines.has(index)) continue
    if (TABLE_ROW.test(line)) continue
    if (HORIZONTAL_RULE.test(line)) continue

    kept.push(stripLineMarkers(line))
  }

  return kept
}

/**
 * 标出属于表格的行号：表头、分隔行，以及其后连续含竖线的表体。
 *
 * 锚点是分隔行而不是竖线本身，这样「正文里出现一个竖线」不会被误伤——
 * `run ls | grep foo` 没有分隔行跟着，markdown.ts 也把它当普通段落渲染，
 * 两边的判定因此一致。
 */
function findTableLines(lines: string[]): Set<number> {
  const tableLines = new Set<number>()

  for (let index = 1; index < lines.length; index++) {
    if (!TABLE_DELIMITER_ROW.test(lines[index])) continue
    // 分隔行的上一行必须是表头，否则它只是一条分隔线。
    if (!lines[index - 1].includes('|')) continue

    tableLines.add(index - 1)
    tableLines.add(index)
    for (let body = index + 1; body < lines.length && lines[body].includes('|'); body++) {
      tableLines.add(body)
    }
  }

  return tableLines
}

/**
 * 反复剥行首标记直到不再变化。一行可能叠着好几层，例如 `> - item`。
 */
function stripLineMarkers(line: string): string {
  let current = line
  let previous = ''

  while (current !== previous) {
    previous = current
    current = LINE_MARKERS.reduce((text, marker) => text.replace(marker, ''), current)
  }

  return current
}

/**
 * 剥行内标记，保留文字。
 *
 * 斜体那条的 `_` 带前后零宽断言，`tcp_congestion_control` 这类标识符才不会被
 * 拆成 `tcpcongestioncontrol`。`*` 不需要这道防护——它不出现在标识符里。
 */
function stripInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '') // 图片整个丢掉，alt 文字对摘要没用
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接只留文字
    .replace(/`([^`]*)`/g, '$1') // 行内代码去掉反引号
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    // 尖括号后必须紧跟字母才算标签。写成 /<[^>]*>/ 会把「kernel < 4.9 and
    // memory > 2 GB」中间整段静默删掉——技术问答里这种比较式太常见了。
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
}

/**
 * 截成摘要。`maxChars` 只为测试而开——生产调用一律用默认值。
 *
 * 落点优先级：完整句子 > 词边界 > 硬切。断在句末时不加省略号，那本来就是一
 * 句读得通的话；另两条会加，用来说明后面还有内容。
 */
export function buildExcerpt(markdown: string | null, maxChars: number = EXCERPT_MAX_CHARS): string {
  const text = toPlainText(markdown)
  if (text.length <= maxChars) return text

  // slice 按 UTF-16 码元切，表情符号这类星际字符会被拦腰截断，剩下的半个
  // 码元会原样写进 <meta content>。切完先把它去掉。
  const clipped = text.slice(0, maxChars).replace(LONE_HIGH_SURROGATE, '')
  const earliestBoundary = Math.floor(maxChars * MIN_BOUNDARY_RATIO)

  const sentenceEnd = lastSentenceEnd(text, clipped, earliestBoundary)
  if (sentenceEnd !== -1) return clipped.slice(0, sentenceEnd + 1)

  // 多取一个字符再找空格：截断点正好落在词末时，那个空格在 clipped 之外，
  // 只看 clipped 会把最后一个完整的词也丢掉。
  const wordEnd = text.slice(0, maxChars + 1).lastIndexOf(' ')
  if (wordEnd >= earliestBoundary) return text.slice(0, wordEnd) + ELLIPSIS

  // 中文没有空格，走到这里是常态，不是异常。
  return clipped.trimEnd() + ELLIPSIS
}

/**
 * clipped 里最后一个句末标点的下标，早于 `earliestBoundary` 的一概不算。
 * 找不到返回 -1。
 */
function lastSentenceEnd(text: string, clipped: string, earliestBoundary: number): number {
  let found = -1

  // 正则带 /g，复用会带着上次的 lastIndex，因此每次新建一个。
  const pattern = new RegExp(SENTENCE_END.source, 'g')
  let match: RegExpExecArray | null

  while ((match = pattern.exec(clipped)) !== null) {
    if (match.index < earliestBoundary) continue
    if (!isSentenceEnd(text, match.index)) continue
    found = match.index
  }

  return found
}

/**
 * 这个位置是不是句末。**判定对着完整的 text 做，不对着 clipped。**
 *
 * 曾经写成正则里的 `(?=\s|$)` 直接在 clipped 上匹配，那个 `$` 锚的是人工截断
 * 点而不是答案真正的结尾：`4.9` 的点只要恰好落在第 maxChars 个字符上，就会被
 * 当成句末，摘要停在「…4.」——正是这条规则本来要防的情况。
 */
function isSentenceEnd(text: string, index: number): boolean {
  if (CJK_SENTENCE_END.test(text[index])) return true

  const next = text[index + 1]
  return next === undefined || /\s/.test(next)
}
