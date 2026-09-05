/**
 * 把结构化数据序列化成可以安全内联进 <script type="application/ld+json"> 的字符串。
 *
 * 为什么不能直接用 JSON.stringify：HTML 解析器在 <script> 内部只认 `</script`，
 * 一旦载荷里出现这个字面量（答案正文、标题都来自后端，均不可信），script 元素会被
 * 提前闭合，其后的内容按 HTML 解析——这就是一个完整的注入点。
 *
 * 把 `<` 转义成 \u003c 即可根除：这是合法的 JSON 转义，JSON.parse 会还原成 `<`，
 * Google 的结构化数据解析器同样正常读取，但 HTML 解析器再也看不到闭合标签。
 *
 * 只需转义 `<`：`>` 单独出现无法闭合任何标签。
 */
export function toInlineJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}
