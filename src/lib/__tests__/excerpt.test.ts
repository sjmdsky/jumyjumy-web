import { describe, test, expect } from 'vitest'
import { toPlainText, buildExcerpt, EXCERPT_MAX_CHARS } from '../excerpt'

describe('toPlainText — 剥除结构标记', () => {
  test('strips heading markers but keeps the heading text', () => {
    // Arrange
    const markdown = '## 启用 BBR\n\n两行 sysctl 就够了。'

    // Act
    const text = toPlainText(markdown)

    // Assert
    expect(text).toBe('启用 BBR 两行 sysctl 就够了。')
  })

  test('strips list markers from unordered and ordered lists', () => {
    expect(toPlainText('- first\n- second')).toBe('first second')
    expect(toPlainText('1. first\n2. second')).toBe('first second')
  })

  test('strips blockquote markers', () => {
    expect(toPlainText('> quoted line')).toBe('quoted line')
  })

  test('strips bold and italic markers', () => {
    expect(toPlainText('a **bold** and *thin* word')).toBe('a bold and thin word')
  })

  test('unwraps inline code and keeps the code text', () => {
    expect(toPlainText('run `sysctl -w` now')).toBe('run sysctl -w now')
  })

  test('keeps link text and drops the URL', () => {
    expect(toPlainText('see [the manual](https://example.com/a?b=c)')).toBe('see the manual')
  })

  test('strips horizontal rules', () => {
    expect(toPlainText('before\n\n---\n\nafter')).toBe('before after')
  })

  test('collapses newlines and repeated spaces into single spaces', () => {
    expect(toPlainText('one\n\n\ntwo   three\tfour')).toBe('one two three four')
  })
})

describe('toPlainText — 丢弃纯结构内容', () => {
  test('drops fenced code blocks entirely', () => {
    // Arrange —— 代码块在一句话的卡片摘要里全是噪声，留下来只会挤掉正文。
    const markdown = '执行这条：\n\n```bash\nsysctl -w net.ipv4.tcp_congestion_control=bbr\n```\n\n然后重启。'

    // Act
    const text = toPlainText(markdown)

    // Assert
    expect(text).toBe('执行这条： 然后重启。')
  })

  test('drops an unterminated fenced code block instead of leaking the fence', () => {
    expect(toPlainText('intro\n\n```\nnever closed')).toBe('intro')
  })

  test('drops table rows so the card never shows a broken pipe grid', () => {
    // Arrange
    const markdown = ['开销对比：', '', '| Command | Purpose |', '| --- | --- |', '| `df -h` | disk |'].join('\n')

    // Act
    const text = toPlainText(markdown)

    // Assert
    expect(text).toBe('开销对比：')
  })

  test('strips raw HTML tags but keeps the text between them', () => {
    expect(toPlainText('<span>visible</span> tail')).toBe('visible tail')
  })

  test('returns an empty string for empty or missing input', () => {
    expect(toPlainText('')).toBe('')
    expect(toPlainText(null)).toBe('')
  })
})

describe('buildExcerpt', () => {
  test('returns the whole text unchanged when it fits the limit', () => {
    // Arrange
    const markdown = '## 标题\n\n很短的一句话。'

    // Act
    const excerpt = buildExcerpt(markdown)

    // Assert
    expect(excerpt).toBe('标题 很短的一句话。')
    expect(excerpt).not.toContain('…')
  })

  test('ends on a complete sentence without an ellipsis when one is near the limit', () => {
    // Arrange —— 句末标点落在允许区间内，截在那里比硬切加省略号干净。
    const markdown = '第一句话到这里结束。第二句话会被丢掉。'

    // Act
    const excerpt = buildExcerpt(markdown, 12)

    // Assert
    expect(excerpt).toBe('第一句话到这里结束。')
  })

  test('treats a period as a sentence end only when a space follows it', () => {
    // Arrange —— "4.9" 里的点不是句末，在那里断句会得到 "BBR 自 4."
    const markdown = 'BBR needs 4.9 kernels. Older ones cannot enable it.'

    // Act
    const excerpt = buildExcerpt(markdown, 30)

    // Assert
    expect(excerpt).toBe('BBR needs 4.9 kernels.')
  })

  test('falls back to a word boundary with an ellipsis when no sentence ends nearby', () => {
    // Arrange
    const markdown = 'alpha bravo charlie delta echo foxtrot golf hotel'

    // Act
    const excerpt = buildExcerpt(markdown, 30)

    // Assert
    expect(excerpt).toBe('alpha bravo charlie delta echo…')
  })

  test('hard-cuts a continuous CJK run and appends an ellipsis', () => {
    // Arrange —— 中文没有空格，按词切会一刀不切，只能按字符数硬切。
    const markdown = '一'.repeat(40)

    // Act
    const excerpt = buildExcerpt(markdown, 20)

    // Assert
    expect(excerpt).toBe('一'.repeat(20) + '…')
  })

  test('ignores a boundary that sits too early and would throw away most of the text', () => {
    // Arrange —— 句末标点在开头附近，采纳它会把摘要砍成两个字。
    const markdown = '好。' + '一'.repeat(40)

    // Act
    const excerpt = buildExcerpt(markdown, 20)

    // Assert
    expect(excerpt).not.toBe('好。')
    expect(excerpt.length).toBeGreaterThan(10)
  })

  test('never exceeds the limit by more than the ellipsis', () => {
    // Arrange
    const markdown = '一'.repeat(500)

    // Act
    const excerpt = buildExcerpt(markdown)

    // Assert
    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS + 1)
  })

  test('returns an empty string when the answer is missing, so callers can fall back', () => {
    expect(buildExcerpt(null)).toBe('')
    expect(buildExcerpt('')).toBe('')
  })

  test('returns an empty string when the answer is nothing but a code block', () => {
    expect(buildExcerpt('```\nsysctl -w a=b\n```')).toBe('')
  })
})

describe('toPlainText — 审查发现的漏网情况', () => {
  test('keeps comparison operators instead of deleting them as tags', () => {
    // Arrange —— 技术问答里「内核 < 4.9」极常见，按 <...> 一刀切会把中间整段吃掉。
    const markdown = 'kernel < 4.9 and memory > 2 GB'

    // Act
    const text = toPlainText(markdown)

    // Assert
    expect(text).toBe('kernel < 4.9 and memory > 2 GB')
  })

  test('still strips real HTML tags while keeping their text', () => {
    expect(toPlainText('<span>visible</span> tail')).toBe('visible tail')
    expect(toPlainText('<br/>a<hr>b')).toBe('ab')
  })

  test('drops a table written without leading pipes', () => {
    // Arrange —— markdown.ts 的 splitTableRow 支持省略行首竖线，渲染器认的表格
    // 这里也必须认，否则半张管道网格会漏进卡片。
    const markdown = ['开销对比：', '', 'Command | Purpose', '--- | ---', '`df -h` | disk usage here'].join('\n')

    // Act
    const text = toPlainText(markdown)

    // Assert
    expect(text).toBe('开销对比：')
  })

  test('keeps a prose line that merely contains a pipe', () => {
    // Arrange —— 没有分隔行就不是表格，markdown.ts 也把它当普通段落渲染。
    expect(toPlainText('run ls | grep foo to filter')).toBe('run ls | grep foo to filter')
  })

  test('drops a setext heading underline made of equals signs', () => {
    expect(toPlainText('My Heading\n===\n\nbody text')).toBe('My Heading body text')
  })
})

describe('buildExcerpt — 审查发现的漏网情况', () => {
  test('rejects a period that only looks final because the cut lands on it', () => {
    // Arrange —— "4.9" 的点落在人工截断点上时，正则里的 $ 会把它当成句末。
    // 真实文本在那之后还继续，所以它不是句末。
    const excerpt = buildExcerpt('ABCDEFGH4.9 kernels are required for BBR', 10)

    // Assert
    expect(excerpt).not.toBe('ABCDEFGH4.')
    expect(excerpt.endsWith('…')).toBe(true)
  })

  test('never splits a surrogate pair at the cut point', () => {
    // Arrange —— 表情符号占两个 UTF-16 码元，slice 拦腰截断会往 head 里写一个
    // 落单的代理码元。
    const excerpt = buildExcerpt('x'.repeat(19) + '😀' + 'y'.repeat(40), 20)

    // Assert
    expect(/[\uD800-\uDBFF]/.test(excerpt)).toBe(false)
    expect(excerpt).toBe('x'.repeat(19) + '…')
  })
})
