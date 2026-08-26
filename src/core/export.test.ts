import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'

import { BASE_COLUMNS, buildRows, pyFloatStr, toCSV, toJSONL, toXLSX } from './export'
import { presetById } from './providers'
import type { CallResult, RunMeta, RunSpec } from './types'

const META: RunMeta = {
  ts: '2026-08-17T10:35:00.000Z',
  providerId: 'openai-chat',
  providerLabel: 'OpenAI Chat Completions',
  promptTemplate: 'Classify: {{text}}',
  systemTemplate: 'Be terse.',
  contract: null,
  parserId: null,
  repeats: 1,
}

function specs(): RunSpec[] {
  const openai = presetById('openai-chat')
  return [{
    provider: openai.provider,
    apiKey: '',
    model: 'a-model',
    params: { temperature: 0.4, maxTokens: 128 },
    prompt: 'Classify: refund',
    system: 'Be terse.',
    stream: false,
    zdr: false,
    caseLabel: 'Row 1',
    bindings: { text: 'refund' },
    repeatIndex: 0,
  }]
}

const RESULTS: CallResult[] = [{
  model: 'a-model',
  status: 'ok',
  parts: [{ kind: 'text', text: 'done' }],
  latencyMs: 42,
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
  costUsd: 0.000012,
  estimatedCostUsd: 0.00001,
  rawJson: '{"x":1}',
}]

describe('pyFloatStr', () => {
  it('matches Python repr for floats', () => {
    expect(pyFloatStr(85)).toBe('85.0')
    expect(pyFloatStr(8.5)).toBe('8.5')
    expect(pyFloatStr(0.0001)).toBe('0.0001')
    expect(pyFloatStr(0.00001)).toBe('1e-05')
    expect(pyFloatStr(1e16)).toBe('1e+16')
    expect(pyFloatStr(1.5e16)).toBe('1.5e+16')
    expect(pyFloatStr(-0)).toBe('-0.0')
    expect(pyFloatStr(0)).toBe('0.0')
    expect(pyFloatStr(3.14159)).toBe('3.14159')
  })
})

describe('buildRows', () => {
  it('emits lean rows with derived prompt, bindings, cost, and raw anchor', () => {
    const { columns, rows } = buildRows(META, specs(), RESULTS, null)
    const row = rows[0]!
    expect(row.model).toBe('a-model')
    expect(row.case).toBe('Row 1')
    expect(row.prompt).toBe('Classify: refund')
    expect(row.bindings).toBe('{"text":"refund"}')
    expect(row.costUsd).toBe(0.000012)
    expect(row.raw).toBe('{"x":1}')
    expect(columns).toEqual(BASE_COLUMNS.map(c => c) as typeof columns)
  })

  it('adds unstacked parsed columns when the parser is json-unstack', () => {
    const results: CallResult[] = [{
      model: 'a', status: 'ok', parts: [{ kind: 'text', text: '{"score": 85, "label": "good"}' }], rawJson: '',
    }]
    const { columns, rows } = buildRows(META, specs(), results, 'json-unstack')
    const keys = columns.map(c => c.key)
    expect(keys).toContain('parsed_label')
    expect(keys).toContain('parsed_score')
    expect(rows[0]!.parsed_score).toBe(85)
  })

  it('types parsed columns whole-column', () => {
    const results: CallResult[] = [
      { model: 'a', status: 'ok', parts: [{ kind: 'text', text: '{"n": "85"}' }], rawJson: '' },
    ]
    const { rows } = buildRows(META, specs(), results, 'json-unstack')
    expect(rows[0]!.parsed_n).toBe(85)
  })

  it('preserves scalar parser results in the Parsed column', () => {
    const results: CallResult[] = [
      { model: 'a', status: 'ok', parts: [{ kind: 'text', text: 'Score: 85' }] },
    ]
    const { rows } = buildRows(META, specs(), results, 'first-number')
    expect(rows[0]!.parsed).toBe(85)
  })
})

describe('writers', () => {
  it('CSV quotes only when needed and renders floats Python-style', () => {
    const { rows, columns } = buildRows(META, specs(), RESULTS, null)
    const csv = toCSV(rows, columns)
    expect(csv).toContain(',a-model,Row 1,1,ok,,42,10,5,15,1.2e-05,1e-05,')
    expect(csv).toContain(',1.2e-05,')
    expect(csv.startsWith(columns.map(c => c.label).join(','))).toBe(true)
  })

  it('JSONL emits one object per row with parity number spelling', () => {
    const { rows, columns } = buildRows(META, specs(), RESULTS, null)
    const lines = toJSONL(rows, columns).split('\n')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(parsed.Model).toBe('a-model')
    expect(parsed['Cost (USD)']).toBe(1.2e-05)
    expect(parsed['Latency (ms)']).toBe(42)
  })

  it('XLSX round-trips cells through SheetJS', () => {
    const { rows, columns } = buildRows(META, specs(), RESULTS, null)
    const bytes = toXLSX(rows, columns)
    const wb = XLSX.read(bytes)
    const json = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]!]) as Array<Record<string, unknown>>
    expect(json[0]!.Model).toBe('a-model')
    expect(json[0]!.Response).toBe('done')
  })
})
