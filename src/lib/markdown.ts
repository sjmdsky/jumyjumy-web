/**
 * 安全极简的 Markdown 渲染器。
 *
 * 核心设计约束（防 XSS 与 SEO 权重安全）：
 *  1. 默认全面转义原始 HTML（包括代码块内），彻底杜绝存储型 XSS 漏洞。
 *  2. 严禁执行 `javascript:` 伪协议，非安全协议链接直接降级为纯文本。
 *  3. 所有外链强制注入 `rel="nofollow noopener"`，保护全站出站链接权重并防反向 tab-nabbing。
 *  4. 零外部 npm 依赖，完全兼容 Cloudflare Workers 运行时环境。
 */

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderInline(rawText: string): string {
  // 1. 提取行内代码块，避免代码内部的 Markdown 语法或 HTML 被重复转义
  const codeTokens: string[] = []
  const textWithoutCode = rawText.replace(/`([^`]+)`/g, (_match, code) => {
    const placeholder = `\x00CODE${codeTokens.length}\x00`
    codeTokens.push(`<code>${escapeHtml(code)}</code>`)
    return placeholder
  })

  // 2. 提取并安全处理链接 [text](url)
  const linkTokens: string[] = []
  const textWithoutLinks = textWithoutCode.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText, url) => {
    const trimmedUrl = url.trim()
    const isSafeHttp = /^https?:\/\//i.test(trimmedUrl)
    const isRelative = /^\/[^/\\]/i.test(trimmedUrl)
    const placeholder = `\x00LINK${linkTokens.length}\x00`

    if (isSafeHttp || isRelative) {
      linkTokens.push(`<a href="${escapeHtml(trimmedUrl)}" rel="nofollow noopener">${escapeHtml(linkText)}</a>`)
    } else {
      // 针对 javascript: 或未知伪协议，直接降级展示为纯文本
      linkTokens.push(escapeHtml(linkText))
    }
    return placeholder
  })

  // 3. 转义其余所有普通文本的原始 HTML
  let result = escapeHtml(textWithoutLinks)

  // 4. 解析粗体与斜体
  result = result
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')

  // 5. 还原链接 Token
  result = result.replace(/\x00LINK(\d+)\x00/g, (_match, index) => {
    return linkTokens[Number(index)] || ''
  })

  // 6. 还原行内代码 Token
  result = result.replace(/\x00CODE(\d+)\x00/g, (_match, index) => {
    return codeTokens[Number(index)] || ''
  })

  return result
}

type TableAlign = 'left' | 'center' | 'right' | null

/**
 * 清理单个单元格内容：
 * 将转义的 \| 还原为普通管道符 |，并去除单元格首尾冗余空白。
 */
function cleanCell(cell: string): string {
  return cell.trim().replace(/\\\|/g, '|')
}

/**
 * 将表格行切分为单元格。
 *
 * 关键规则与边界处理：
 * 1. 兼容标准 GFM 表格首尾可选的闭合管道符 `|`。
 * 2. 避免在行内代码块（`...`）内部误切管道符（如命令行示例 `cat file | grep text`）。
 * 3. 尊重转义的管道符 `\|`，避免因内容中的转义符号导致表格错位。
 */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim()
  if (!trimmed) return []

  let startIndex = 0
  if (trimmed.startsWith('|')) {
    startIndex = 1
  }

  let endIndex = trimmed.length
  if (trimmed.endsWith('|')) {
    // 检查末尾的 | 是否被奇数个反斜杠转义
    let backslashCount = 0
    for (let k = trimmed.length - 2; k >= 0 && trimmed[k] === '\\'; k--) {
      backslashCount++
    }
    if (backslashCount % 2 === 0) {
      endIndex = trimmed.length - 1
    }
  }

  const cells: string[] = []
  let currentCell = ''
  let inBacktick = false
  let escaped = false

  for (let idx = startIndex; idx < endIndex; idx++) {
    const char = trimmed[idx]

    if (escaped) {
      currentCell += char
      escaped = false
      continue
    }

    if (char === '\\') {
      escaped = true
      currentCell += char
      continue
    }

    if (char === '`') {
      inBacktick = !inBacktick
      currentCell += char
      continue
    }

    if (char === '|' && !inBacktick) {
      cells.push(cleanCell(currentCell))
      currentCell = ''
      continue
    }

    currentCell += char
  }

  cells.push(cleanCell(currentCell))
  return cells
}

/**
 * 解析表格分隔对齐行（如 `| :--- | :---: | ---: |`）。
 *
 * 约束要求：
 * 每个单元格仅允许包含 `-` 与两侧可选的 `:`。
 * 任何单元格不符合格式即视为非分隔行，防止普通带有管道符的正文段落被误判为表格。
 */
function parseDelimiterRow(line: string): TableAlign[] | null {
  const cells = splitTableRow(line)
  if (cells.length === 0) return null

  const aligns: TableAlign[] = []
  for (const cell of cells) {
    const match = cell.match(/^(:?)-+(:?)$/)
    if (!match) {
      return null
    }
    const leftColon = Boolean(match[1])
    const rightColon = Boolean(match[2])
    if (leftColon && rightColon) {
      aligns.push('center')
    } else if (rightColon) {
      aligns.push('right')
    } else if (leftColon) {
      aligns.push('left')
    } else {
      aligns.push(null)
    }
  }
  return aligns
}

export function renderAnswer(markdown: string | null | undefined): string {
  if (!markdown || !markdown.trim()) {
    return ''
  }

  // 预处理：标准化换行
  const raw = markdown.replace(/\r\n/g, '\n')
  const lines = raw.split('\n')
  const output: string[] = []

  let inCodeBlock = false
  let codeBlockLang = ''
  let codeBlockLines: string[] = []

  let inList: 'ul' | 'ol' | null = null
  let listItems: string[] = []

  function flushList() {
    if (inList && listItems.length > 0) {
      output.push(`<${inList}>\n${listItems.map((item) => `  <li>${item}</li>`).join('\n')}\n</${inList}>`)
      listItems = []
      inList = null
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    // 代码块处理 ```lang
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        // 结束代码块
        const codeContent = escapeHtml(codeBlockLines.join('\n'))
        const langClass = codeBlockLang ? ` class="language-${escapeHtml(codeBlockLang)}"` : ''
        output.push(`<pre><code${langClass}>${codeContent}</code></pre>`)
        inCodeBlock = false
        codeBlockLang = ''
        codeBlockLines = []
      } else {
        // 开始代码块
        flushList()
        inCodeBlock = true
        codeBlockLang = line.trim().slice(3).trim()
        codeBlockLines = []
      }
      continue
    }

    if (inCodeBlock) {
      codeBlockLines.push(line)
      continue
    }

    // 表格解析：当前行为表头且下一行为有效的分隔行
    if (i + 1 < lines.length && line.includes('|')) {
      const headerCells = splitTableRow(line)
      const aligns = parseDelimiterRow(lines[i + 1]!)
      // 表头与分隔行的列数必须一致，确认为合法 GFM 表格
      if (headerCells.length > 0 && aligns && headerCells.length === aligns.length) {
        flushList()
        const colCount = aligns.length
        const bodyRows: string[][] = []

        let j = i + 2
        while (j < lines.length) {
          const bodyLine = lines[j]!
          // 遇到空行、代码块、标题、引用块、列表或不含管道符的行，代表表格自然结束
          if (!bodyLine.trim()) break
          if (bodyLine.trim().startsWith('```')) break
          if (bodyLine.match(/^#{1,6}\s+/)) break
          if (bodyLine.startsWith('>')) break
          if (bodyLine.match(/^[-*]\s+/)) break
          if (bodyLine.match(/^\d+\.\s+/)) break
          if (!bodyLine.includes('|')) break

          bodyRows.push(splitTableRow(bodyLine))
          j++
        }

        const headerHtml = headerCells
          .map((text, idx) => {
            const align = aligns[idx]
            const alignStyle = align ? ` style="text-align: ${align};"` : ''
            return `        <th${alignStyle}>${renderInline(text)}</th>`
          })
          .join('\n')

        const bodyHtml = bodyRows
          .map((row) => {
            const cellsHtml = Array.from({ length: colCount }, (_, idx) => {
              const text = row[idx] || ''
              const align = aligns[idx]
              const alignStyle = align ? ` style="text-align: ${align};"` : ''
              return `        <td${alignStyle}>${renderInline(text)}</td>`
            }).join('\n')
            return `      <tr>\n${cellsHtml}\n      </tr>`
          })
          .join('\n')

        const tbodyPart = bodyRows.length > 0
          ? `\n    <tbody>\n${bodyHtml}\n    </tbody>`
          : ''

        output.push(
          `<div class="table-container">\n  <table>\n    <thead>\n      <tr>\n${headerHtml}\n      </tr>\n    </thead>${tbodyPart}\n  </table>\n</div>`
        )

        i = j - 1
        continue
      }
    }

    // 标题处理 #, ##, ###, ####, #####, ######
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      flushList()
      const level = headingMatch[1]!.length
      const headingContent = renderInline(headingMatch[2]!.trim())
      output.push(`<h${level}>${headingContent}</h${level}>`)
      continue
    }

    // 引用块处理 >
    if (line.startsWith('>')) {
      flushList()
      const quoteText = line.replace(/^>\s?/, '').trim()
      output.push(`<blockquote><p>${renderInline(quoteText)}</p></blockquote>`)
      continue
    }

    // 无序列表项 - / *
    const ulMatch = line.match(/^[-*]\s+(.+)$/)
    if (ulMatch) {
      if (inList !== 'ul') {
        flushList()
        inList = 'ul'
      }
      listItems.push(renderInline(ulMatch[1]!.trim()))
      continue
    }

    // 有序列表项 1. / 2.
    const olMatch = line.match(/^\d+\.\s+(.+)$/)
    if (olMatch) {
      if (inList !== 'ol') {
        flushList()
        inList = 'ol'
      }
      listItems.push(renderInline(olMatch[1]!.trim()))
      continue
    }

    // 空行：分隔段落与列表
    if (!line.trim()) {
      flushList()
      continue
    }

    // 普通文本行 / 段落
    flushList()
    output.push(`<p>${renderInline(line.trim())}</p>`)
  }

  // 闭合可能遗留的代码块或列表
  if (inCodeBlock) {
    const codeContent = escapeHtml(codeBlockLines.join('\n'))
    output.push(`<pre><code>${codeContent}</code></pre>`)
  }
  flushList()

  return output.join('\n\n')
}
