// Guesses the sheet makes for the user, so a two-column task needs no
// configuration: which columns the model should read, which it should fill in,
// and what kind of answer each output column holds. Every guess is shown and
// changeable; none is silent.

import { isBlank } from './partition'
import type { Row } from './partition'
import type { ColumnRole, ContractField } from './types'

const PLAIN_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/
const PLAIN_INTEGER = /^-?(?:0|[1-9]\d*)$/

export interface ColumnFacts {
  name: string
  filled: number
  blank: number
  /** Average length of filled values, in characters. */
  avgLength: number
  distinct: number
  numeric: boolean
  integer: boolean
  /** Up to 12 distinct filled values, in first-seen order. */
  sample: string[]
}

export function columnFacts(rows: readonly Row[], column: string): ColumnFacts {
  let filled = 0, blank = 0, total = 0, numeric = true, integer = true
  const seen = new Map<string, number>()
  for (const row of rows) {
    const value = row[column]
    if (isBlank(value)) { blank++; continue }
    filled++
    const text = String(value).trim()
    total += text.length
    if (!PLAIN_DECIMAL.test(text)) numeric = false
    if (!PLAIN_INTEGER.test(text)) integer = false
    if (seen.size < 5000) seen.set(text, (seen.get(text) ?? 0) + 1)
  }
  return {
    name: column,
    filled,
    blank,
    avgLength: filled ? total / filled : 0,
    distinct: seen.size,
    numeric: filled > 0 && numeric,
    integer: filled > 0 && integer,
    sample: [...seen.keys()].slice(0, 12),
  }
}

/** Default roles for a freshly loaded sheet: the longest text column is read
 * by the model; columns that are partly filled (some rows blank) are filled
 * in; everything else is kept and never sent. */
export function guessRoles(rows: readonly Row[], columns: readonly string[]): Record<string, ColumnRole> {
  const facts = columns.map(c => columnFacts(rows, c))
  const roles: Record<string, ColumnRole> = {}
  for (const f of facts) roles[f.name] = 'metadata'
  // Partly filled, short values, and at least two filled cells: one stray
  // note in an otherwise empty column is not a human-coded column.
  const partlyFilled = facts.filter(f => f.filled >= 2 && f.blank > 0 && f.avgLength < 80 && !(f.numeric && f.distinct === f.filled && f.filled > 20))
  for (const f of partlyFilled) roles[f.name] = 'output'
  const readable = facts.filter(f => roles[f.name] !== 'output' && f.filled > 0 && !f.numeric).sort((a, b) => b.avgLength - a.avgLength)
  if (readable[0]) roles[readable[0].name] = 'input'
  else if (facts[0] && roles[facts[0].name] !== 'output') roles[facts[0].name] = 'input'
  return roles
}

/** A field definition for an output column, guessed from its filled values. */
export function guessField(rows: readonly Row[], column: string): ContractField {
  const f = columnFacts(rows, column)
  if (f.filled === 0) return { name: column, type: 'string' }
  if (f.integer && f.distinct > 8) return { name: column, type: 'integer' }
  if (f.numeric && f.distinct > 8) return { name: column, type: 'number' }
  // Choices: a few distinct values that repeat, or a few short label-like
  // values (one or two words). Five distinct sentences are text, not choices.
  const labelLike = f.sample.every(v => v.length <= 20 && v.trim().split(/\s+/).length <= 2)
  if (f.distinct >= 2 && f.distinct <= 8 && f.sample.every(v => v.length <= 40) && (f.distinct < f.filled || labelLike)) {
    // Numeric-looking labels with few distinct values (1..5 scales) are choices
    // too, but a whole-number type keeps them sortable in the export.
    if (f.integer) return { name: column, type: 'integer', min: Math.min(...f.sample.map(Number)), max: Math.max(...f.sample.map(Number)) }
    return { name: column, type: 'enum', values: f.sample }
  }
  if (f.distinct === 1 && f.filled > 1 && f.sample[0]!.length <= 40) return { name: column, type: 'enum', values: f.sample }
  return { name: column, type: 'string' }
}

/** The per-row template generated from the input columns: one line per
 * column, so the model sees each value with its name. */
export function generatedItemTemplate(inputColumns: readonly string[]): string {
  if (inputColumns.length === 1) return `{{${inputColumns[0]}}}`
  return inputColumns.map(c => `${c}: {{${c}}}`).join('\n')
}
