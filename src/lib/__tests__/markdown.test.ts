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

  test('renders markdown tables with headers, alignments, and body rows', () => {
    const md = [
      '| Command | Purpose | Best For |',
      '| :--- | :---: | ---: |',
      '| `df -h` | System-wide disk usage | Seeing overall disk capacity |',
      '| `du -sh` | Directory/File usage | Finding large folders |',
    ].join('\n')

    const html = renderAnswer(md)
    expect(html).toContain('<div class="table-container">')
    expect(html).toContain('<table>')
    expect(html).toContain('<thead>')
    expect(html).toContain('<th style="text-align: left;">Command</th>')
    expect(html).toContain('<th style="text-align: center;">Purpose</th>')
    expect(html).toContain('<th style="text-align: right;">Best For</th>')
    expect(html).toContain('<tbody>')
    expect(html).toContain('<td style="text-align: left;"><code>df -h</code></td>')
    expect(html).toContain('<td style="text-align: center;">System-wide disk usage</td>')
    expect(html).toContain('<td style="text-align: right;">Finding large folders</td>')
  })

  test('renders tables with pipes inside code spans and escaped pipes', () => {
    const md = [
      '| Tool | Syntax | Note |',
      '| --- | --- | --- |',
      '| `ls \\| grep` | `cat file \\| wc -l` | Pipe \\| filter |',
    ].join('\n')

    const html = renderAnswer(md)
    expect(html).toContain('<code>ls | grep</code>')
    expect(html).toContain('<code>cat file | wc -l</code>')
    expect(html).toContain('Pipe | filter')
  })

  test('escapes raw HTML and unsafe links inside table cells', () => {
    const md = [
      '| Name | Danger |',
      '| --- | --- |',
      '| <script>alert(1)</script> | [hack](javascript:alert(1)) |',
    ].join('\n')

    const html = renderAnswer(md)
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('href="javascript')
    expect(html).toContain('hack')
  })

  test('does not parse standalone lines with pipes as tables when no delimiter exists', () => {
    const md = 'just a line | with pipes | but no table'
    const html = renderAnswer(md)
    expect(html).not.toContain('<table>')
    expect(html).toBe('<p>just a line | with pipes | but no table</p>')
  })

  test('renders disk usage reference table correctly', () => {
    const md = [
      '### Summary Table',
      '| Command | Purpose | Best For |',
      '| :--- | :--- | :--- |',
      '| `df -h` | System-wide disk usage | Seeing overall disk capacity and availability. |',
      '| `du -sh` | Directory/File usage | Finding out which folders are taking up the most space. |',
      '| `ncdu` | Interactive analysis | Visually exploring and cleaning up large files. |',
    ].join('\n')

    const html = renderAnswer(md)
    expect(html).toContain('<h3>Summary Table</h3>')
    expect(html).toContain('<div class="table-container">')
    expect(html).toContain('<th style="text-align: left;">Command</th>')
    expect(html).toContain('<td style="text-align: left;"><code>df -h</code></td>')
    expect(html).toContain('<td style="text-align: left;">System-wide disk usage</td>')
    expect(html).toContain('<td style="text-align: left;">Seeing overall disk capacity and availability.</td>')
    expect(html).toContain('<code>du -sh</code>')
    expect(html).toContain('<code>ncdu</code>')
  })

  test('handles default alignment and pads missing cells in body rows', () => {
    const md = [
      '| Col A | Col B | Col C |',
      '| --- | --- | --- |',
      '| Only A |',
    ].join('\n')

    const html = renderAnswer(md)
    expect(html).toContain('<th>Col A</th>')
    expect(html).toContain('<td>Only A</td>')
    expect(html).toContain('<td></td>')
  })

  test('does not parse table when delimiter column count differs from header', () => {
    const md = [
      '| Col A | Col B |',
      '| --- | --- | --- |',
      '| 1 | 2 |',
    ].join('\n')

    const html = renderAnswer(md)
    expect(html).not.toContain('<table>')
  })
})
