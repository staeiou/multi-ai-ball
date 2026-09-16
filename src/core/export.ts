// Frozen run + rows -> the two user-facing tables and their files.
//
//   Long table: one row per call in coordinate order; the analytically regular
//   artifact. The rendered prompt is not a column: the frozen run plus the
//   coordinate regenerates it, and the export ships the frozen run alongside.
//   Completed datasets: one table per model and repeat, shaped like the source
//   sheet, example rows keeping their human codes, target rows filled with the
//   model's parsed fields. The "finish my spreadsheet" artifact.
//
// Writers produce ordinary CSV/TSV/JSONL/XLSX. Cell values, column order and
// null representation are the contract; bytes are not (the Python runner
// writes its own files with its own libraries).

import * as XLSX from 'xlsx'

import { normalizeFieldName } from './contract'
import { coerceCell, discoverUnstackColumns, extractUnstackCell, inferColumnType } from './parsers'
import { columnsWithRole } from './partition'
import type { Row } from './partition'
import { presetById } from './providers/presets'
import { coordinateAt } from './render'
import { responseText } from './run'
import { totalCalls } from './freeze'
import type { CallRow, FrozenRun } from './types'

export type ExportValue = string | number | boolean | null

export interface ExportColumn {
  key: string
  label: string
}

export interface ExportRow {
  [key: string]: ExportValue
}

export const BASE_COLUMNS: readonly ExportColumn[] = [
  { key: 'case', label: 'Case' },
  { key: 'ordinal', label: 'Source row' },
  { key: 'provider', label: 'Provider' },
  { key: 'model', label: 'Model' },
  { key: 'repeat', label: 'Repeat' },
  { key: 'status', label: 'Status' },
  { key: 'httpStatus', label: 'HTTP status' },
  { key: 'error', label: 'Error' },
  { key: 'latencyMs', label: 'Latency (ms)' },
  { key: 'promptTokens', label: 'Prompt tokens' },
  { key: 'completionTokens', label: 'Completion tokens' },
  { key: 'totalTokens', label: 'Total tokens' },
  { key: 'costUsd', label: 'Cost (USD)' },
  { key: 'estimatedCostUsd', label: 'Estimated cost (USD)' },
  { key: 'parseStatus', label: 'Parse status' },
]

export const TAIL_COLUMNS: readonly ExportColumn[] = [
  { key: 'response', label: 'Response' },
  { key: 'thinking', label: 'Reasoning' },
  { key: 'upstream', label: 'Sub-provider' },
  { key: 'bodyHash', label: 'Request body SHA-256' },
  { key: 'bindings', label: 'Bindings (JSON)' },
  { key: 'raw', label: 'Raw response' },
]

function parsedObject(row: CallRow): Record<string, unknown> | null {
  return typeof row.parsed === 'object' && row.parsed !== null && !Array.isArray(row.parsed) ? row.parsed as Record<string, unknown> : null
}

function scalarCell(value: unknown): ExportValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return JSON.stringify(value)
  return value as ExportValue
}

/** Columns the parser contributes: unstacked `parsed_*` for JSON, one
 * `parsed` column otherwise, none without a parser. */
export function parsedColumns(run: FrozenRun, rows: readonly CallRow[]): ExportColumn[] {
  if (!run.parserId) return []
  if (run.parserId === 'json-unstack') {
    return discoverUnstackColumns(rows.map(parsedObject)).map(key => ({ key, label: key }))
  }
  return [{ key: 'parsed', label: 'Parsed' }]
}

export function buildRows(run: FrozenRun, rows: readonly CallRow[]): { columns: ExportColumn[]; rows: ExportRow[] } {
  const parsed = parsedColumns(run, rows)
  const forward = (run.forwardColumns ?? []).map(column => ({ key: `source:${column}`, label: column }))
  const columns = [...BASE_COLUMNS, ...forward, ...parsed, ...TAIL_COLUMNS]
  const isUnstack = run.parserId === 'json-unstack'
  const enumColumns = new Set((run.contract?.fields ?? []).filter(f => f.type === 'enum' || f.type === 'multi-enum').map(f => `parsed_${f.name}`))

  const out: ExportRow[] = rows.map((row, index) => {
    const coord = row.coord ?? coordinateAt(run, index)
    const c = run.cases[coord.caseIndex]!
    const model = run.models[coord.modelIndex]!
    const record: ExportRow = {
      case: c.label,
      ordinal: c.ordinal + 1,
      provider: presetById(model.provider).label,
      model: model.id,
      repeat: coord.repeat + 1,
      status: row.status,
      httpStatus: row.httpStatus ?? null,
      error: row.error ?? null,
      latencyMs: row.latencyMs ?? null,
      promptTokens: row.promptTokens ?? null,
      completionTokens: row.completionTokens ?? null,
      totalTokens: row.totalTokens ?? null,
      costUsd: row.costUsd ?? null,
      estimatedCostUsd: row.estimatedCostUsd ?? null,
      parseStatus: row.parseStatus,
      response: responseText(row) || null,
      thinking: row.thinking ?? null,
      upstream: row.upstream ?? null,
      bodyHash: row.bodyHash ?? null,
      bindings: JSON.stringify(c.bindings),
      raw: row.raw ?? null,
    }
    for (const column of run.forwardColumns ?? []) record[`source:${column}`] = scalarCell(c.forward?.[column])
    if (isUnstack) {
      const obj = parsedObject(row)
      for (const column of parsed) record[column.key] = extractUnstackCell(obj, column.key)
    } else if (run.parserId) {
      record.parsed = row.parsed === 'PARSER_ERROR' ? 'PARSER_ERROR' : scalarCell(row.parsed)
    }
    return record
  })

  // Whole-column typing for parsed columns (faithful values -> typed columns).
  for (const column of parsed) {
    if (enumColumns.has(column.key)) continue
    const type = inferColumnType(out.map(r => r[column.key]))
    if (type === 'number' || type === 'boolean') {
      for (const r of out) r[column.key] = coerceCell(r[column.key], type) as ExportValue
    }
  }
  return { columns, rows: out }
}

// --- completed datasets ---------------------------------------------------------

export interface CompletedDataset {
  /** e.g. "anthropic claude-sonnet-5 (repeat 2)" */
  name: string
  fileStem: string
  columns: string[]
  rows: ExportRow[]
}

/** One completed sheet per model and repeat. Requires the source rows, which
 * the frozen run does not carry (only the projected cases do). */
export function buildCompletedDatasets(
  run: FrozenRun,
  rows: readonly CallRow[],
  sourceRows: readonly Row[],
  sourceColumns: readonly string[],
): CompletedDataset[] {
  const outputColumns = columnsWithRole(run.roles, 'output')
  const byField = new Map<string, string>() // normalized contract/field name -> output column
  for (const column of outputColumns) byField.set(normalizeFieldName(column), column)
  const roleOf = new Map<number, 'example' | 'target' | 'ambiguous'>()
  run.partition.examples.forEach(o => roleOf.set(o, 'example'))
  run.partition.targets.forEach(o => roleOf.set(o, 'target'))
  run.partition.ambiguous.forEach(o => roleOf.set(o, 'ambiguous'))
  const caseIndexByOrdinal = new Map(run.cases.map((c, i) => [c.ordinal, i]))

  const parsedKeys = run.parserId === 'json-unstack'
    ? discoverUnstackColumns(rows.map(parsedObject)).map(key => key.slice('parsed_'.length))
    : run.parserId ? ['parsed'] : []
  const extraColumns = outputColumns.length ? [] : parsedKeys.map(key => `model_${key}`)

  const datasets: CompletedDataset[] = []
  run.models.forEach((model, modelIndex) => {
    for (let repeat = 0; repeat < run.repeats; repeat++) {
      const newOutputs = outputColumns.filter(c => !sourceColumns.includes(c))
      const columns = [...sourceColumns, ...newOutputs, ...extraColumns, '_row_role', '_status', '_model']
      const out: ExportRow[] = sourceRows.map((source, ordinal) => {
        const record: ExportRow = {}
        for (const column of sourceColumns) record[column] = scalarCell(source[column])
        const role = roleOf.get(ordinal) ?? 'ambiguous'
        record._row_role = role
        record._model = model.id
        record._status = role === 'target' ? 'not run' : ''
        const caseIndex = caseIndexByOrdinal.get(ordinal)
        if (role !== 'target' || caseIndex === undefined) return record
        const index = caseIndex * run.models.length * run.repeats + modelIndex * run.repeats + repeat
        const call = rows[index]
        if (!call) return record
        record._status = call.status === 'ok' ? (call.parseStatus === 'failed' ? 'parse failed' : 'ok') : (call.error ?? 'error')
        const obj = parsedObject(call)
        if (outputColumns.length) {
          if (obj) {
            for (const [key, value] of Object.entries(obj)) {
              const column = byField.get(normalizeFieldName(key))
              if (column) record[column] = scalarCell(value)
            }
          } else if (outputColumns.length === 1 && call.parsed !== null && call.parsed !== 'PARSER_ERROR') {
            record[outputColumns[0]!] = scalarCell(call.parsed)
          }
        } else if (obj) {
          for (const key of parsedKeys) record[`model_${key}`] = extractUnstackCell(obj, `parsed_${key}`)
        } else if (run.parserId) {
          record.model_parsed = call.parsed === 'PARSER_ERROR' ? 'PARSER_ERROR' : scalarCell(call.parsed)
        }
        return record
      })
      const suffix = run.repeats > 1 ? ` (repeat ${repeat + 1})` : ''
      datasets.push({
        name: `${model.id}${suffix}`,
        fileStem: `${model.id.replace(/[^a-z0-9._-]+/gi, '_')}${run.repeats > 1 ? `-r${repeat + 1}` : ''}`,
        columns,
        rows: out,
      })
    }
  })
  return datasets
}

// --- writers -----------------------------------------------------------------------

function cellString(value: ExportValue): string {
  if (value === null) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

function quoteIfNeeded(field: string, delimiter: string): string {
  return /["\r\n]/.test(field) || field.includes(delimiter) ? `"${field.replace(/"/g, '""')}"` : field
}

export function toDelimited(rows: readonly ExportRow[], columns: readonly { key: string; label: string }[], delimiter: string): string {
  const header = columns.map(c => quoteIfNeeded(c.label, delimiter)).join(delimiter)
  const body = rows.map(row => columns.map(c => quoteIfNeeded(cellString(row[c.key] ?? null), delimiter)).join(delimiter))
  return [header, ...body].join('\r\n')
}

export function toCSV(rows: readonly ExportRow[], columns: readonly ExportColumn[]): string {
  return toDelimited(rows, columns, ',')
}

export function toTSV(rows: readonly ExportRow[], columns: readonly ExportColumn[]): string {
  return toDelimited(rows, columns, '\t')
}

export function toJSONL(rows: readonly ExportRow[], columns: readonly ExportColumn[]): string {
  return rows.map(row => JSON.stringify(Object.fromEntries(columns.map(c => [c.label, row[c.key] ?? null])))).join('\n')
}

/** Excel rejects cells longer than 32,767 characters. Leave headroom and put
 * the remainder in adjacent, clearly named columns rather than losing it. */
export const EXCEL_CELL_CHUNK = 32700

function excelChunks(value: ExportValue): ExportValue[] {
  if (typeof value !== 'string' || value.length <= EXCEL_CELL_CHUNK) return [value]
  const chunks: string[] = []
  for (let start = 0; start < value.length; start += EXCEL_CELL_CHUNK) {
    let end = Math.min(value.length, start + EXCEL_CELL_CHUNK)
    // Do not split a surrogate pair across two Excel cells.
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--
    chunks.push(value.slice(start, end))
    if (end === start) end++
    start = end - EXCEL_CELL_CHUNK
  }
  return chunks
}

export function toXLSX(sheets: Array<{ name: string; rows: readonly ExportRow[]; columns: readonly ExportColumn[] }>): ArrayBuffer {
  const book = XLSX.utils.book_new()
  const used = new Set<string>()
  for (const sheet of sheets) {
    const expanded = sheet.columns.flatMap(column => {
      const count = Math.max(1, ...sheet.rows.map(row => excelChunks(row[column.key] ?? null).length))
      return Array.from({ length: count }, (_, index) => ({ column, index }))
    })
    const aoa = [
      expanded.map(({ column, index }) => index === 0 ? column.label : `${column.label}.continued.${index}`),
      ...sheet.rows.map(row => expanded.map(({ column, index }) => excelChunks(row[column.key] ?? null)[index] ?? null)),
    ]
    let name = sheet.name.replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'Sheet'
    let n = 2
    while (used.has(name)) name = `${name.slice(0, 28)}_${n++}`
    used.add(name)
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(aoa), name)
  }
  return XLSX.write(book, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
}

export function plainColumns(names: readonly string[]): ExportColumn[] {
  return names.map(name => ({ key: name, label: name }))
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export function fileStamp(iso: string): string {
  return iso.replace(/[:T]/g, '-').replace(/\.\d+Z$/, '')
}

export function download(name: string, data: BlobPart | BlobPart[], mime: string): void {
  const blob = new Blob(Array.isArray(data) ? data : [data], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function callCount(run: FrozenRun): number {
  return totalCalls(run)
}
