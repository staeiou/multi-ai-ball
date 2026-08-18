// The mad-libs renderer — one pass, left to right, semantics ported from
// Auditomatic's renderPromptTemplate (their v2 renderer):
//   - a name may hold anything but braces, and is trimmed
//   - a placeholder with no binding at all stays literal (a typo stays visible)
//   - a binding that is present but empty renders as nothing (an empty cell)
//   - lookup is own-property only (a `{{toString}}` never walks the prototype)
//   - a value is never rescanned, so it can never be interpreted as markup
//
// THE LEAN-PROMPT INVARIANT: this is the only place a rendered prompt is
// produced. Nothing stores or carries a rendered prompt; callers render at the
// wire edge (RunSpec construction) and at export only.

const PLACEHOLDER = /\{\{([^{}]+)\}\}/g

export function normalizeBindingValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return formatJsNumber(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/** ECMAScript Number::toString — shortest round-trip digits. */
export function formatJsNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN'
  if (value === Infinity) return 'Infinity'
  if (value === -Infinity) return '-Infinity'
  return String(value)
}

export function renderPromptTemplate(template: string, bindings: Readonly<Record<string, unknown>>): string {
  if (!template) return template ?? ''

  const placeholders = [...template.matchAll(PLACEHOLDER)]
  if (placeholders.length === 0) return template

  let rendered = ''
  let cursor = 0
  for (const match of placeholders) {
    const start = match.index ?? 0
    rendered += template.slice(cursor, start)
    const name = match[1]!.trim()
    rendered += Object.prototype.hasOwnProperty.call(bindings, name)
      ? normalizeBindingValue(bindings[name])
      : match[0]
    cursor = start + match[0].length
  }
  return rendered + template.slice(cursor)
}

/** Unique placeholder names in a template, in first-appearance order. */
export function promptPlaceholderNames(...channels: Array<string | null | undefined>): string[] {
  const seen: string[] = []
  for (const channel of channels) {
    if (!channel) continue
    for (const match of channel.matchAll(PLACEHOLDER)) {
      const name = match[1]!.trim()
      if (!name || seen.includes(name)) continue
      seen.push(name)
    }
  }
  return seen
}