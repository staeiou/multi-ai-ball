import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'

import { buildPlan, parseSheetBytes, unresolvedPlaceholders } from './cases'

describe('parseSheetBytes', () => {
  it('parses CSV with a header row, keeping numeric cells numeric', () => {
    const csv = 'request,customer_type\nrefund,VIP\ncomplaint,standard\n'
    const rows = parseSheetBytes(csv)
    expect(rows).toEqual([
      { label: 'Row 1', bindings: { request: 'refund', customer_type: 'VIP' } },
      { label: 'Row 2', bindings: { request: 'complaint', customer_type: 'standard' } },
    ])
  })

  it('maps empty cells to empty strings (renders as nothing)', () => {
    const rows = parseSheetBytes('a,b\n1,\n')
    expect(rows[0]!.bindings).toEqual({ a: 1, b: '' })
  })

  it('disambiguates duplicate headers', () => {
    const rows = parseSheetBytes('x,x\n1,2\n')
    expect(rows[0]!.bindings).toEqual({ x: 1, x_1: 2 })
  })

  it('parses .xlsx bytes', () => {
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([['name', 'age'], ['Ada', 36]])
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
    const bytes = XLSX.write(wb, { type: 'array' }) as ArrayBuffer
    const rows = parseSheetBytes(bytes)
    expect(rows).toEqual([{ label: 'Row 1', bindings: { name: 'Ada', age: 36 } }])
  })
})

describe('buildPlan', () => {
  it('produces one case for single mode', () => {
    const plan = buildPlan({ kind: 'single' }, 'Hi {{name}}', '', undefined, { name: 'Ada' })
    expect(plan.cases).toHaveLength(1)
    expect(plan.cases[0]!.bindings).toEqual({ name: 'Ada' })
  })

  it('produces one case per sheet row', () => {
    const plan = buildPlan({ kind: 'sheet', template: 'R {{a}}', name: 's' }, 'R {{a}}', '', [
      { label: 'Row 1', bindings: { a: '1' } },
      { label: 'Row 2', bindings: { a: '2' } },
    ])
    expect(plan.cases.map(c => c.bindings)).toEqual([{ a: '1' }, { a: '2' }])
  })
})

describe('unresolvedPlaceholders', () => {
  it('reports names never bound by any case', () => {
    expect(unresolvedPlaceholders('{{a}} {{b}}', '', { a: 1 })).toEqual(['b'])
  })
})