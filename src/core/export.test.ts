import { describe, expect, it } from 'vitest'

import * as XLSX from 'xlsx'
import { buildCompletedDatasets, buildModelReport, buildRows, EXCEL_CELL_CHUNK, toCSV, toJSONL, toXLSX } from './export'
import { freezeRun } from './freeze'
import { columnsOf, inferPartition } from './partition'
import { presetById } from './providers/presets'
import { renderCall } from './render'
import { GPT41_LIKE, ROLES, ROWS } from './testing/fixtures'
import type { CallRow, FrozenRun } from './types'

async function frozen(): Promise<FrozenRun> {
  return freezeRun({
    preset: presetById('openai'), baseUrl: 'x',
    source: { name: 's.csv', bytes: 1, sha256: 'x', rowCount: ROWS.length },
    rows: ROWS, roles: ROLES, partition: inferPartition(ROWS, ROLES),
    systemTemplate: '', itemTemplate: '{{text}}',
    contract: { fields: [{ name: 'frame', type: 'enum', values: ['economic', 'civic'] }, { name: 'score', type: 'integer' }] },
    parserId: 'json-unstack',
    models: [{ model: GPT41_LIKE, settings: { extras: {} } }],
    shared: { outputLength: 64, temperature: null, effort: null, responseFormat: 'none' },
    repeats: 1, concurrency: 1, retries: 0, timeoutMs: 1,
  })
}

const okRow = (caseIndex: number, parsed: Record<string, unknown>): CallRow => ({
  coord: { caseIndex, modelIndex: 0, repeat: 0 }, status: 'ok', httpStatus: 200, latencyMs: 10, promptTokens: 5, completionTokens: 2, totalTokens: 7, costUsd: 0.000001,
  parts: [{ kind: 'text', text: JSON.stringify(parsed) }], parsed, parseStatus: 'strict', raw: '{}', bodyHash: 'h',
})

describe('long table', () => {
  it('one row per call with unstacked parsed columns typed whole-column, enums left as labels', async () => {
    const run = await frozen()
    const { columns, rows } = buildRows(run, [okRow(0, { frame: 'civic', score: '3' }), okRow(1, { frame: 'economic', score: 5 })])
    expect(columns.map(c => c.key)).toContain('parsed_frame')
    expect(rows[0]!.parsed_score).toBe(3)
    expect(rows[1]!.parsed_score).toBe(5)
    expect(rows[0]!.parsed_frame).toBe('civic')
    expect(rows[0]!.ordinal).toBe(3)
    expect(rows[0]!.bindings).toBe(JSON.stringify({ text: 'Hospital wait times doubled.' }))
    const csv = toCSV(rows, columns)
    expect(csv.split('\r\n')).toHaveLength(3)
    expect(toJSONL(rows, columns).split('\n')).toHaveLength(2)
  })

  it('carries the literal request per row: the URL and the exact body string the call hashed', async () => {
    const run = await frozen()
    const { columns, rows } = buildRows(run, [okRow(0, { frame: 'civic', score: 3 })])
    expect(columns.map(c => c.label)).toEqual(expect.arrayContaining(['Request URL', 'Request body (JSON)']))
    const expected = renderCall(run, { caseIndex: 0, modelIndex: 0, repeat: 0 })
    expect(rows[0]!.requestUrl).toBe('x/v1/chat/completions')
    expect(rows[0]!.requestBody).toBe(expected.bodyString)
    expect(String(rows[0]!.requestBody)).toContain('Hospital wait times doubled.')
    expect(String(rows[0]!.requestBody)).not.toContain('{{API_KEY}}')
  })
})

describe('model report', () => {
  it('one row per parameter per model, with the reason, the source and the body skeleton', async () => {
    const run = await frozen()
    const { columns, rows } = buildModelReport(run)
    expect(columns.map(c => c.label)).toEqual(['Model', 'Provider', 'Request URL', 'Parameter', 'Sent', 'Value', 'Why', 'Source', 'Body skeleton (JSON)'])
    expect(rows.length).toBe(run.models[0]!.report.length)
    const length = rows.find(r => r.param === 'max_completion_tokens')!
    expect(length.sent).toBe(true)
    expect(length.value).toBe(64)
    expect(length.model).toBe('gpt-4.1-mini')
    expect(String(length.skeleton)).toContain('{{PROMPT}}')
    const format = rows.find(r => String(r.param).startsWith('response_format'))!
    expect(format.sent).toBe(false)
    expect(format.reason).toBe('not requested')
  })
})

describe('completed datasets', () => {
  it('fills the declared output columns of target rows, keeps human codes on examples, flags failures', async () => {
    const run = await frozen()
    const failed: CallRow = { coord: { caseIndex: 1, modelIndex: 0, repeat: 0 }, status: 'error', error: 'HTTP 500 — boom', parts: [], parsed: null, parseStatus: 'none' }
    const [sheet] = buildCompletedDatasets(run, [okRow(0, { frame: 'civic', score: 3 }), failed], ROWS, columnsOf(ROWS))
    expect(sheet!.columns).toEqual(['id', 'text', 'source', 'frame', 'score', '_row_role', '_status', '_model'])
    expect(sheet!.rows[0]!.frame).toBe('economic') // example row keeps the human code
    expect(sheet!.rows[0]!._row_role).toBe('example')
    expect(sheet!.rows[2]!.frame).toBe('civic')
    expect(sheet!.rows[2]!.score).toBe(3)
    expect(sheet!.rows[2]!._status).toBe('ok')
    expect(sheet!.rows[3]!._status).toBe('HTTP 500 — boom')
    expect(sheet!.rows[4]!._row_role).toBe('ambiguous')
  })

  it('appends model_ columns when no output columns were declared', async () => {
    const roles = { id: 'reference' as const, text: 'input' as const, source: 'metadata' as const, frame: 'metadata' as const, score: 'metadata' as const }
    const run = await freezeRun({
      preset: presetById('openai'), baseUrl: 'x', source: { name: 's', bytes: 1, sha256: 'x', rowCount: 2 },
      rows: ROWS.slice(0, 2), roles, partition: inferPartition(ROWS.slice(0, 2), roles),
      systemTemplate: '', itemTemplate: '{{text}}', contract: null, parserId: 'json-unstack',
      models: [{ model: GPT41_LIKE, settings: { extras: {} } }], shared: { outputLength: 64, temperature: null, effort: null, responseFormat: 'none' },
      repeats: 1, concurrency: 1, retries: 0, timeoutMs: 1,
    })
    const [sheet] = buildCompletedDatasets(run, [okRow(0, { label: 'a' }), okRow(1, { label: 'b' })], ROWS.slice(0, 2), columnsOf(ROWS))
    expect(sheet!.columns).toContain('model_label')
    expect(sheet!.rows[1]!.model_label).toBe('b')
  })
})

describe('Excel writing', () => {
  it('splits over-limit cells into continued columns without losing text', () => {
    const value = 'x'.repeat(EXCEL_CELL_CHUNK + 12)
    const file = toXLSX([{ name: 'Results', columns: [{ key: 'response', label: 'Response' }], rows: [{ response: value }] }])
    const book = XLSX.read(file, { type: 'array' })
    const rows = XLSX.utils.sheet_to_json(book.Sheets.Results!, { header: 1 }) as string[][]
    expect(rows[0]).toEqual(['Response', 'Response.continued.1'])
    expect(rows[1]![0]! + rows[1]![1]!).toBe(value)
  })
})
