import { describe, expect, it } from 'vitest'

import { cartesianRows, parseJsonRows, parseSheetBytes, parseSweepValues, sweepCaseCount } from './cases'

describe('parseSheetBytes', () => {
  it('reads CSV with the first row as columns and keeps numbers', () => {
    const csv = 'text,score\nhello,3\nworld,\n'
    const sheet = parseSheetBytes(new TextEncoder().encode(csv).buffer as ArrayBuffer, 'cases.csv')
    expect(sheet.columns).toEqual(['text', 'score'])
    expect(sheet.rows).toEqual([{ text: 'hello', score: 3 }, { text: 'world', score: '' }])
  })
  it('reads JSONL and JSON arrays, flattening nested values to JSON text', () => {
    const jsonl = parseJsonRows('{"a":1,"b":{"c":2}}\n{"a":2}', 'x.jsonl')
    expect(jsonl.columns).toEqual(['a', 'b'])
    expect(jsonl.rows[0]!.b).toBe('{"c":2}')
    expect(parseJsonRows('[{"a":1}]', 'x.json').rows).toEqual([{ a: 1 }])
  })
})

describe('sweep', () => {
  it('builds the Cartesian product, first variable slowest', () => {
    const rows = cartesianRows([{ name: 'name', values: ['Ann', 'Bob'] }, { name: 'city', values: parseSweepValues('Oslo\n\nRome\n') }])
    expect(rows).toEqual([{ name: 'Ann', city: 'Oslo' }, { name: 'Ann', city: 'Rome' }, { name: 'Bob', city: 'Oslo' }, { name: 'Bob', city: 'Rome' }])
    expect(sweepCaseCount([{ name: 'a', values: ['1', '2'] }, { name: 'b', values: ['x', 'y', 'z'] }])).toBe(6)
    expect(cartesianRows([])).toEqual([])
  })
})
