// Built-in parsers: definitions as data + TS implementations.
//
// Fidelity model (see ARCHITECTURE.md): the corpus fixture is the executable
// spec. These TS implementations and the Python twin inside the generated
// script both pass it; drift on either side fails tests. There are no
// user-authored parsers and no Pyodide by design.
//
// Two halves, like Auditomatic:
//   - extraction (response -> object): string-aware balanced-brace scanner,
//     strict parse then jsonrepair, largest-by-key-count selection with
//     later-wins-ties, NaN/Infinity rejected even after repair, PARSER_ERROR
//     sentinel distinct from null.
//   - columns (object -> columns/cells): sorted dotted keys, depth cap 4,
//     every node a column, compact JSON for subtree/array cells.

import { jsonrepair } from 'jsonrepair'

import type { BuiltinParserDef, ParsedValue } from './types'
import { PARSER_ERROR } from './types'

// --- extraction half ---------------------------------------------------------

export function scanJsonObjects(text: string): string[] {
  const found: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') {
      if (depth === 0) start = i
      depth++
    } else if (char === '}') {
      if (depth === 0) continue
      depth--
      if (depth === 0 && start >= 0) {
        found.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }
  return found
}

function containsNonFinite(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isFinite(value)
  if (Array.isArray(value)) return value.some(containsNonFinite)
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(containsNonFinite)
  return false
}

type JsonObject = Record<string, unknown>

/** Strict parse first; repair on failure; never completes a truncated object
 * (the scanner only yields balanced candidates). Plain objects only; NaN and
 * Infinity rejected even after repair. Returns null when nothing usable. */
export function parseJsonObject(candidate: string): JsonObject | null {
  try {
    const parsed = JSON.parse(candidate)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : null
  } catch {
    // fall through to repair
  }
  try {
    // jsonrepair returns repaired TEXT, not an object.
    const repaired = JSON.parse(jsonrepair(candidate)) as unknown
    if (!repaired || typeof repaired !== 'object' || Array.isArray(repaired)) return null
    if (containsNonFinite(repaired)) return null
    return repaired as JsonObject
  } catch {
    return null
  }
}

/** Largest object by key count; ties take the later one. A brace-shaped
 * candidate that neither parse nor repair could use makes the whole response a
 * PARSER_ERROR (distinct from null = no JSON-like content at all). */
export function extractLargestJsonObject(content: string): JsonObject | null | typeof PARSER_ERROR {
  const candidates = scanJsonObjects(content)
  if (candidates.length === 0) return null
  let best: JsonObject | null = null
  let bestSize = -1
  let anyFailed = false
  for (const candidate of candidates) {
    const parsed = parseJsonObject(candidate)
    if (parsed === null) {
      anyFailed = true
      continue
    }
    if (Object.keys(parsed).length >= bestSize) {
      bestSize = Object.keys(parsed).length
      best = parsed
    }
  }
  if (best === null && anyFailed) return PARSER_ERROR
  return best
}

// --- column half (language-neutral contract) ---------------------------------

export const MAX_UNSTACK_DEPTH = 4

export function collectUnstackColumns(
  obj: JsonObject | null,
  seen: Set<string>,
  prefix: 'parsed' | 'postparsed' = 'parsed',
): void {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return
  const walk = (value: JsonObject, path: string, depth: number): void => {
    for (const [key, child] of Object.entries(value)) {
      const nextPath = path ? `${path}.${key}` : key
      seen.add(`${prefix}_${nextPath}`)
      if (
        depth < MAX_UNSTACK_DEPTH &&
        child !== null &&
        typeof child === 'object' &&
        !Array.isArray(child)
      ) {
        walk(child as JsonObject, nextPath, depth + 1)
      }
    }
  }
  walk(obj, '', 1)
}

export function discoverUnstackColumns(
  objects: Array<JsonObject | null>,
  prefix: 'parsed' | 'postparsed' = 'parsed',
): string[] {
  const seen = new Set<string>()
  for (const obj of objects) collectUnstackColumns(obj, seen, prefix)
  return [...seen].sort()
}

export function extractUnstackCell(
  obj: JsonObject | null,
  columnId: string,
  prefix: 'parsed' | 'postparsed' = 'parsed',
): string | number | boolean | null {
  if (!obj || typeof obj !== 'object') return null
  let value: unknown = obj
  for (const key of columnId.slice(prefix.length + 1).split('.')) {
    if (value === null || typeof value !== 'object') return null
    value = (value as Record<string, unknown>)[key]
  }
  if (value === undefined || value === null) return null
  if (typeof value === 'object') return JSON.stringify(value)
  return value as string | number | boolean
}

// --- whole-column typing (mirrors the Python twin's export decision) ---------

const BOOL_TRUE = new Set(['true', 'yes', '1'])
const BOOL_FALSE = new Set(['false', 'no', '0'])
const PLAIN_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

export type ColumnType = 'string' | 'number' | 'boolean' | 'json'

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (typeof value === 'number' && Number.isNaN(value))
}

function isNumberLike(value: unknown): boolean {
  if (typeof value === 'boolean') return false
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'string') return false
  return PLAIN_DECIMAL.test(value.trim())
}

function isBooleanLike(value: unknown): boolean {
  if (typeof value === 'boolean') return true
  if (typeof value !== 'string') return false
  return BOOL_TRUE.has(value.trim().toLowerCase()) || BOOL_FALSE.has(value.trim().toLowerCase())
}

export function inferColumnType(values: readonly unknown[]): ColumnType {
  const present = values.filter(v => !isEmpty(v))
  if (present.length === 0) return 'string'
  if (present.every(v => typeof v === 'object' && v !== null)) return 'json'
  if (present.every(isBooleanLike)) return 'boolean'
  if (present.every(isNumberLike)) return 'number'
  return 'string'
}

export function coerceCell(value: unknown, columnType: ColumnType): unknown {
  if (isEmpty(value)) return null
  if (columnType === 'number') {
    if (typeof value === 'boolean') return null
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    const text = String(value).trim()
    if (!PLAIN_DECIMAL.test(text)) return null
    return text.includes('.') ? Number(text) : Number(text)
  }
  if (columnType === 'boolean') {
    if (typeof value === 'boolean') return value
    const text = String(value).trim().toLowerCase()
    if (BOOL_TRUE.has(text)) return true
    if (BOOL_FALSE.has(text)) return false
    return null
  }
  if (columnType === 'json') return value && typeof value === 'object' ? value : null
  return value
}

// --- built-in registry -------------------------------------------------------

export const BUILTIN_PARSERS: readonly BuiltinParserDef[] = [
  { id: 'json-unstack', name: 'JSON Object (Unstack to Columns)', kind: 'json', outputType: 'json' },
  { id: 'json-object', name: 'JSON Object (as text)', kind: 'json', outputType: 'text' },
  { id: 'first-number', name: 'First Number', kind: 'regex', outputType: 'number', pattern: '(\\d+(?:\\.\\d+)?)', captureGroup: 1 },
  { id: 'last-number', name: 'Last Number', kind: 'regex', outputType: 'number', pattern: '[\\s\\S]*\\b(\\d+(?:\\.\\d+)?)', captureGroup: 1 },
  { id: 'first-word', name: 'First Word', kind: 'regex', outputType: 'text', pattern: '\\b(\\w+)\\b', captureGroup: 1 },
  { id: 'last-word', name: 'Last Word', kind: 'regex', outputType: 'text', pattern: '[\\s\\S]*\\b(\\w+)\\b', captureGroup: 1 },
  { id: 'first-sentence', name: 'First Sentence', kind: 'regex', outputType: 'text', pattern: '^([^.!?]+)[.!?]?', captureGroup: 1 },
  { id: 'last-sentence', name: 'Last Sentence', kind: 'regex', outputType: 'text', pattern: '([^.!?]+)[.!?]?$', captureGroup: 1 },
  { id: 'first-line', name: 'First Line', kind: 'text', outputType: 'text' },
  { id: 'last-line', name: 'Last Line', kind: 'text', outputType: 'text' },
  { id: 'yes-no', name: 'Yes/No', kind: 'regex', outputType: 'boolean', pattern: '\\b(yes|no)\\b', flags: 'i', captureGroup: 1 },
  { id: 'true-false', name: 'True/False', kind: 'regex', outputType: 'boolean', pattern: '\\b(true|false)\\b', flags: 'i', captureGroup: 1 },
  { id: 'percentage', name: 'Percentage', kind: 'regex', outputType: 'number', pattern: '(\\d+(?:\\.\\d+)?)\\s*%', captureGroup: 1 },
  { id: 'score-grade-result', name: 'Score/Grade/Result', kind: 'regex', outputType: 'number', pattern: '(?:score|grade|result|rating|mark|points?|total)[^0-9]*?(\\d+(?:\\.\\d+)?)', flags: 'i', captureGroup: 1 },
  { id: 'answer-response', name: 'Answer/Response', kind: 'regex', outputType: 'text', pattern: '(?:answer|response|solution)\\s*:?\\s*(.+?)(?:[.!?\\n]|$)', flags: 'i', captureGroup: 1 },
  { id: 'letter-grade', name: 'Letter Grade', kind: 'regex', outputType: 'text', pattern: '\\b([A-F][+-]?)\\b', flags: 'i', captureGroup: 1 },
  { id: 'multiple-choice', name: 'Multiple Choice (A-D)', kind: 'regex', outputType: 'text', pattern: '\\b([A-D])\\b', flags: 'i', captureGroup: 1 },
  { id: 'word-count', name: 'Word Count', kind: 'text', outputType: 'number' },
  { id: 'sum-numbers', name: 'Sum All Numbers', kind: 'text', outputType: 'number' },
]

const REGEX_FLAGS: Record<string, string> = { i: 'i', m: 'm', s: 's' }

export function builtinParserById(id: string): BuiltinParserDef | undefined {
  return BUILTIN_PARSERS.find(p => p.id === id)
}

function applyRegex(def: BuiltinParserDef, content: string): string | null {
  let flags = ''
  for (const letter of def.flags ?? '') {
    if (REGEX_FLAGS[letter]) flags += REGEX_FLAGS[letter]
  }
  const matcher = new RegExp(def.pattern!, flags)
  const match = matcher.exec(content)
  if (!match) return null
  const group = def.captureGroup ?? 1
  const captured = match[group]
  return typeof captured === 'string' ? captured.trim() : captured
}

function applyText(def: BuiltinParserDef, content: string): string | number | null {
  if (def.id === 'first-line') {
    const line = content.split('\n').map(l => l.trim()).find(l => l.length > 0)
    return line ?? null
  }
  if (def.id === 'last-line') {
    const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0)
    return lines.length ? lines[lines.length - 1] : null
  }
  if (def.id === 'word-count') return content.trim() ? content.trim().split(/\s+/).length : 0
  if (def.id === 'sum-numbers') {
    let total = 0
    for (const match of content.matchAll(/\d+(?:\.\d+)?/g)) total += Number(match[0])
    return total
  }
  return null
}

/** Run a built-in parser over a response. Values stay faithful (strings for
 * regex captures, real numbers from JSON); whole-column typing happens at
 * export, identically on both sides. */
export function parseWithBuiltin(id: string, content: string): ParsedValue {
  const def = builtinParserById(id)
  if (!def) return null
  if (def.kind === 'json') {
    if (id === 'json-object') {
      const candidate = scanJsonObjects(content)[0] ?? null
      return candidate
    }
    return extractLargestJsonObject(content)
  }
  if (def.kind === 'regex') return applyRegex(def, content)
  return applyText(def, content)
}