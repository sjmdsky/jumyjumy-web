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
