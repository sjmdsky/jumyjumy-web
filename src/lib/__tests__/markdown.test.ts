import { describe, test, expect } from 'vitest'
import { renderAnswer } from '../markdown'

describe('renderAnswer — safety', () => {
  test('escapes raw HTML instead of rendering it', () => {
    const html = renderAnswer('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  test('escapes a script tag smuggled inside a code fence', () => {
    const html = renderAnswer('```\n</script><script>alert(1)</script>\n```')
    expect(html).not.toContain('<script')
  })

  test('refuses javascript: links and renders them as text', () => {
    const html = renderAnswer('[click](javascript:alert(1))')
    expect(html).not.toContain('href="javascript')
    expect(html).toContain('click')
  })

  test('allows http and https links and marks them rel-safe', () => {
    const html = renderAnswer('[MDN](https://developer.mozilla.org/)')
    expect(html).toContain('href="https://developer.mozilla.org/"')
    expect(html).toContain('rel="nofollow noopener"')
  })
})

describe('renderAnswer — formatting', () => {
  test('renders headings, paragraphs and inline code', () => {
    const html = renderAnswer('## Title\n\nUse `flex` and `<head>` here.')
    expect(html).toContain('<h2')
    expect(html).toContain('<code>flex</code>')
    expect(html).toContain('<code>&lt;head&gt;</code>')
  })

  test('renders unordered and ordered lists', () => {
    expect(renderAnswer('- a\n- b')).toContain('<ul>')
    expect(renderAnswer('1. a\n2. b')).toContain('<ol>')
  })

  test('renders fenced code blocks', () => {
    const html = renderAnswer('```css\n.a { color: red }\n```')
    expect(html).toContain('<pre')
    expect(html).toContain('color: red')
  })

  test('renders bold text', () => {
    expect(renderAnswer('a **bold** word')).toContain('<strong>bold</strong>')
  })

  test('returns an empty string for empty input', () => {
    expect(renderAnswer('')).toBe('')
    expect(renderAnswer(null)).toBe('')
  })
})
