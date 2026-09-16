// A breakdown of one results column: how the answers that have come back are
// distributed, overall and per model. Pure; the results screen feeds it the
// rows it is showing (so filters apply) and renders the counts as bars.
//
// Two kinds. Categorical: every distinct value counted, the top MAX_CATEGORIES
// kept and the rest folded into one "other" bucket. Numeric: when there are
// few distinct values (a 1–5 score) each value is its own bucket in numeric
// order; otherwise equal-width bins. A multi-choice answer (an array) counts
// once per choice.

export type FieldKind = 'categorical' | 'numeric'

export interface BreakdownItem {
  model: string
  /** The answer, or null/undefined/'' when this row has none yet. */
  value: unknown
}

export interface ValueCount {
  value: string
  count: number
}

export interface ModelBreakdown {
  model: string
  answered: number
  /** Aligned with Breakdown.values. */
  counts: number[]
  mean?: number
  median?: number
}

export interface Breakdown {
  kind: FieldKind
  /** Rows given. */
  total: number
  /** Rows with a usable value. */
  answered: number
  values: ValueCount[]
  stats?: { min: number; max: number; mean: number; median: number }
  byModel: ModelBreakdown[]
}

export const MAX_CATEGORIES = 12
const BINS = 10

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value)
  return null
}

function label(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** Short number for a bin edge or a statistic. */
export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n)
  return String(Number(n.toPrecision(3)))
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length
}

/** Values that are all numbers read as numeric; anything else is categorical.
 * A declared contract type should win over this when one exists. */
export function inferKind(items: readonly BreakdownItem[]): FieldKind {
  const present = items.filter(i => !isBlank(i.value))
  if (present.length === 0) return 'categorical'
  return present.every(i => asNumber(i.value) !== null) ? 'numeric' : 'categorical'
}

export function breakdown(items: readonly BreakdownItem[], kind: FieldKind, models: readonly string[]): Breakdown {
  return kind === 'numeric' ? numericBreakdown(items, models) : categoricalBreakdown(items, models)
}

function categoricalBreakdown(items: readonly BreakdownItem[], models: readonly string[]): Breakdown {
  // (model, label) pairs; an array answer contributes one pair per element.
  const pairs: Array<{ model: string; label: string }> = []
  let answered = 0
  for (const item of items) {
    if (isBlank(item.value)) continue
    answered++
    const values = Array.isArray(item.value) ? item.value : [item.value]
    for (const v of values) if (!isBlank(v)) pairs.push({ model: item.model, label: label(v) })
  }
  const totals = new Map<string, number>()
  for (const p of pairs) totals.set(p.label, (totals.get(p.label) ?? 0) + 1)
  const ordered = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const kept = ordered.slice(0, MAX_CATEGORIES)
  const folded = ordered.slice(MAX_CATEGORIES)
  const values: ValueCount[] = kept.map(([value, count]) => ({ value, count }))
  if (folded.length) values.push({ value: `other (${folded.length} values)`, count: folded.reduce((s, [, c]) => s + c, 0) })
  const slot = new Map(kept.map(([value], i) => [value, i]))
  const otherSlot = folded.length ? values.length - 1 : -1
  const byModel = models.map(model => {
    const counts = values.map(() => 0)
    let n = 0
    for (const item of items) if (item.model === model && !isBlank(item.value)) n++
    for (const p of pairs) {
      if (p.model !== model) continue
      const i = slot.get(p.label) ?? otherSlot
      if (i >= 0) counts[i]!++
    }
    return { model, answered: n, counts }
  })
  return { kind: 'categorical', total: items.length, answered, values, byModel }
}

function numericBreakdown(items: readonly BreakdownItem[], models: readonly string[]): Breakdown {
  const numbers: Array<{ model: string; n: number }> = []
  for (const item of items) {
    const n = asNumber(item.value)
    if (n !== null) numbers.push({ model: item.model, n })
  }
  if (numbers.length === 0) return { kind: 'numeric', total: items.length, answered: 0, values: [], byModel: models.map(model => ({ model, answered: 0, counts: [] })) }
  const all = numbers.map(x => x.n).sort((a, b) => a - b)
  const min = all[0]!
  const max = all[all.length - 1]!
  const distinct = [...new Set(all)]
  let values: ValueCount[]
  let bucketOf: (n: number) => number
  if (distinct.length <= MAX_CATEGORIES) {
    values = distinct.map(v => ({ value: formatNumber(v), count: 0 }))
    const index = new Map(distinct.map((v, i) => [v, i]))
    bucketOf = n => index.get(n)!
  } else {
    const width = (max - min) / BINS
    values = Array.from({ length: BINS }, (_, i) => ({ value: `${formatNumber(min + i * width)}–${formatNumber(i === BINS - 1 ? max : min + (i + 1) * width)}`, count: 0 }))
    bucketOf = n => Math.min(BINS - 1, Math.floor((n - min) / width))
  }
  for (const x of numbers) values[bucketOf(x.n)]!.count++
  const byModel = models.map(model => {
    const own = numbers.filter(x => x.model === model).map(x => x.n).sort((a, b) => a - b)
    const counts = values.map(() => 0)
    for (const n of own) counts[bucketOf(n)]!++
    return own.length ? { model, answered: own.length, counts, mean: mean(own), median: median(own) } : { model, answered: 0, counts }
  })
  return { kind: 'numeric', total: items.length, answered: numbers.length, values, stats: { min, max, mean: mean(all), median: median(all) }, byModel }
}
