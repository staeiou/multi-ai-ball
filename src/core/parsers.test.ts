import { describe, expect, it } from 'vitest'

import corpus from '../fixtures/json-parser-contract.json'
import {
  coerceCell,
  collectUnstackColumns,
  discoverUnstackColumns,
  extractUnstackCell,
  extractLargestJsonObject,
  inferColumnType,
  parseWithBuiltin,
  scanJsonObjects,
} from './parsers'

interface ContractCase {
  name: string
  note?: string
  response: string
  parsed: Record<string, unknown> | null
  columns: string[]
  cells: Record<string, string | number | boolean | null>
}

const cases = (corpus as unknown as { cases: ContractCase[] }).cases

describe('extraction half (json-unstack)', () => {
  it.each([
    ['no JSON at all', null],
    ['truncated at max_tokens', null],
    // Recorded JS/Python divergence: jsonrepair quotes NaN/Infinity to strings
    // (the Python twin rejects them as non-finite → PARSER_ERROR).
    ['NaN literal', { n: 'NaN' }],
    ['Infinity literal', { n: 'Infinity' }],
  ] as const)('extracts the JS-twin value for: %s', (name, expected) => {
    const c = cases.find(c => c.name === name)!
    expect(extractLargestJsonObject(c.response)).toEqual(expected)
  })

  it.each([
    'flat object',
    'markdown fenced',
    'prose around object',
    'two objects, larger wins',
    'two objects, tie takes later',
    'nested depth 2',
    'brace inside string value',
    'empty object',
    'trailing comma',
    'single-quoted strings',
    'unquoted keys',
    'smart quotes',
    'python literals',
    'unescaped quote in string',
    'duplicate keys, last wins',
    'integer-like keys',
    'unicode and escapes',
  ])('extracts the corpus object for: %s', name => {
    const c = cases.find(c => c.name === name)!
    expect(extractLargestJsonObject(c.response)).toEqual(c.parsed)
  })
})

describe('column half', () => {
  it.each(cases.map(c => [c.name, c] as const))('%s', (_name, testCase) => {
    const columns = discoverUnstackColumns([testCase.parsed])
    expect(columns).toEqual(testCase.columns)
    const cells: Record<string, unknown> = {}
    for (const column of columns) cells[column] = extractUnstackCell(testCase.parsed, column)
    expect(cells).toEqual(testCase.cells)
  })

  it('unions keys across responses and sorts', () => {
    expect(discoverUnstackColumns([{ score: 1 }, { label: 'x' }, null])).toEqual(['parsed_label', 'parsed_score'])
  })

  it('accumulates the union incrementally', () => {
    const seen = new Set<string>()
    collectUnstackColumns({ score: 1 }, seen)
    collectUnstackColumns({ details: { label: 'x' } }, seen)
    expect([...seen].sort()).toEqual(['parsed_details', 'parsed_details.label', 'parsed_score'])
  })

  it('renders subtree cells as compact JSON', () => {
    const obj = { a: { b: 1 } }
    expect(extractUnstackCell(obj, 'parsed_a')).toBe('{"b":1}')
  })
})

describe('whole-column typing', () => {
  it('keeps identifiers like 07030 as text', () => {
    expect(inferColumnType(['07030', '12345'])).toBe('string')
    expect(inferColumnType(['85', '92.5'])).toBe('number')
    expect(coerceCell('07030', 'number')).toBeNull()
    expect(coerceCell('85', 'number')).toBe(85)
  })

  it('coerces boolean word sets', () => {
    expect(inferColumnType(['yes', 'no', 'True'])).toBe('boolean')
    expect(coerceCell('yes', 'boolean')).toBe(true)
    expect(coerceCell('no', 'boolean')).toBe(false)
    expect(coerceCell('maybe', 'boolean')).toBeNull()
  })
})

describe('regex built-ins', () => {
  it('extracts first/last number', () => {
    expect(parseWithBuiltin('first-number', 'Score: 85, Grade: 90')).toBe('85')
    expect(parseWithBuiltin('last-number', 'Student ID: 12345, Final Score: 87')).toBe('87')
  })

  it('extracts first/last word and sentence', () => {
    expect(parseWithBuiltin('first-word', 'Great! This is amazing')).toBe('Great')
    expect(parseWithBuiltin('last-word', 'Hello brave world')).toBe('world')
    expect(parseWithBuiltin('first-sentence', 'This is great. More here.')).toBe('This is great')
    expect(parseWithBuiltin('last-sentence', 'Start here. End here.')).toBe('End here')
  })

  it('extracts first/last line', () => {
    expect(parseWithBuiltin('first-line', '\n  Hello\nWorld\n')).toBe('Hello')
    expect(parseWithBuiltin('last-line', 'Hello\nWorld\n\n')).toBe('World')
  })

  it('returns None-safe undefined for no match', () => {
    expect(parseWithBuiltin('first-number', 'no numbers here')).toBeNull()
  })

  it('scanner isolates JSON inside fences and prose', () => {
    expect(scanJsonObjects('```json\n{"a": 1}\n```')).toEqual(['{"a": 1}'])
  })
})