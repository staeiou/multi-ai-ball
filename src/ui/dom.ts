// DOM helpers. Every element in the app is created here, and every untrusted
// string (model IDs, provider text, LLM output) enters as a text node — never
// as markup — so there is exactly one place where injection would have to be
// defended and it is not used for raw HTML.

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean> = {},
  ...children: Array<Node | string | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue
    if (key === 'class') el.className = String(value)
    else if (value === true) el.setAttribute(key, '')
    else el.setAttribute(key, String(value))
  }
  for (const child of children) {
    if (child == null || child === false) continue
    el.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return el
}