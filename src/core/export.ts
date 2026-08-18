// RunSnapshot -> CSV / JSONL / XLSX. Byte-identical output with the generated
// Python runner is the contract for CSV/JSONL: same rows, same ordering, same
// escaping, and numbers spelled the way Python spells them (pyFloatStr) so
// pandas' writers produce identical bytes. XLSX carries identical cells.

import * as XLSX from 'xlsx'

import { coerceCell, discoverUnstackColumns, extractUnstackCell, inferColumnType } from './parsers'
import { parseWithBuiltin } from './parsers'
import { resolvedParams } from './providers'
import type { CallResult, RunMeta, RunSpec } from './types'

// --- column contract (one definition; the Python twin renders the same) -----

export type ExportValue = string | number | boolean | null

export interface ExportColumn {
  key: string
  label: string
}

export const BASE_COLUMNS: readonly ExportColumn[] = [
  { key: 'timestamp', label: 'Timestamp' },
  { key: 'provider', label: 'Provider' },
  { key: 'model', label: 'Model' },
  { key: 'case', label: 'Case' },
  { key: 'repeat', label: 'Repeat' },
  { key: 'status', label: 'Status' },
  { key: 'error', label: 'Error' },
  { key: 'latencyMs', label: 'Latency (ms)' },
  { key: 'promptTokens', label: 'Prompt tokens' },
  { key: 'completionTokens', label: 'Completion tokens' },
  { key: 'totalTokens', label: 'Total tokens' },
  { key: 'costUsd', label: 'Cost (USD)' },
  { key: 'estimatedCostUsd', label: 'Estimated cost (USD)' },
  { key: 'template', label: 'Template' },
  { key: 'bindings', label: 'Bindings (JSON)' },
  { key: 'prompt', label: 'Prompt' },
  { key: 'system', label: 'System prompt' },
  { key: 'params', label: 'Parameters (JSON)' },
  { key: 'thinking', label: 'Thinking' },
  { key: 'response', label: 'Response' },
  { key: 'responseParts', label: 'Response parts (JSON)' },
  { key: 'raw', label: 'Raw response' },
]

/** Columns that must stay text however they look (ids, JSON blobs). */
const NEVER_TYPED = new Set([
  'timestamp', 'provider', 'model', 'case', 'repeat', 'status', 'error',
  'template', 'bindings', 'prompt', 'system', 'params', 'thinking', 'response', 'responseParts', 'raw',
])

export interface ExportRow {
  [key: string]: ExportValue
}

/** Rendered prompt is derived here from template + bindings — the lean-prompt
 * invariant: export/display are the only places a rendered prompt exists. */
export function buildRows(
  meta: RunMeta,
  specs: RunSpec[],
  results: CallResult[],
  parserId: string | null,
): { columns: ExportColumn[]; rows: ExportRow[] } {
  const parsedObjects: Array<Record<string, unknown> | null> = []
  const parsedValues: Array<string | number | boolean | Record<string, unknown> | null> = []

  for (const result of results) {
    const text = responseText(result)
    const parsed = parserId ? parseWithBuiltin(parserId, text) : null
    parsedValues.push(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null)
    parsedObjects.push(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null)
  }

  const isUnstack = parserId === 'json-unstack'
  // JSON-schema enums are labels, even when their labels happen to be `0` or
  // `1`. Never run them through the generic yes/no/1/0 column coercion.
  const enumColumns = new Set((meta.contract?.fields ?? [])
    .filter(field => field.type === 'enum')
    .map(field => `parsed_${field.name}`))
  const parsedColumns = isUnstack
    ? discoverUnstackColumns(parsedObjects).map(key => ({ key, label: key }))
    : parserId
      ? [{ key: 'parsed', label: 'Parsed' }]
      : []
  const columns: ExportColumn[] = [...BASE_COLUMNS, ...parsedColumns]
  const rows: ExportRow[] = specs.map((spec, index) => {
    const result = results[index]!
    const text = responseText(result)
    const row: ExportRow = {
      timestamp: meta.ts,
      provider: `${spec.provider.group} (${meta.providerLabel})`,
      model: spec.model,
      case: spec.caseLabel,
      repeat: spec.repeatIndex + 1,
      status: result.status,
      error: result.error ?? null,
      latencyMs: result.latencyMs ?? null,
      promptTokens: result.promptTokens ?? null,
      completionTokens: result.completionTokens ?? null,
      totalTokens: result.totalTokens ?? null,
      costUsd: result.costUsd ?? null,
      estimatedCostUsd: result.estimatedCostUsd ?? null,
      template: meta.promptTemplate,
      bindings: JSON.stringify(spec.bindings),
      prompt: spec.prompt,
      system: spec.system,
      params: JSON.stringify(resolvedParams(spec)),
      thinking: result.thinking ?? null,
      response: text,
      responseParts: JSON.stringify(result.parts),
      raw: result.rawJson ?? null,
    }
    if (isUnstack) {
      const obj = parsedObjects[index]
      for (const column of parsedColumns) {
        row[column.key] = extractUnstackCell(obj, column.key)
      }
    } else if (parserId) {
      const parsed = parsedValues[index]
      row.parsed = typeof parsed === 'object' && parsed !== null
        ? JSON.stringify(parsed)
        : parsed as string | number | boolean | null
    }
    return row
  })

  // Whole-column typing for parsed columns (faithful values -> typed columns),
  // mirroring the Python runner's apply_column_typing.
  for (const column of parsedColumns) {
    if (NEVER_TYPED.has(column.key) || enumColumns.has(column.key)) continue
    const values = rows.map(r => r[column.key])
    const type = inferColumnType(values)
    if (type === 'number' || type === 'boolean') {
      for (const row of rows) row[column.key] = coerceCell(row[column.key], type) as ExportValue
    }
  }

  return { columns, rows }
}

/** A provider may return several text blocks around images/tool calls. Parsing
 * and export must see the complete textual response, not only its first part. */
function responseText(result: CallResult): string {
  return result.parts.filter(part => part.kind === 'text').map(part => part.text).join('\n')
}

// --- writers (byte-parity with the Python runner) ----------------------------

/** Python's repr() for floats, which pandas writes: decimal for
 * 1e-4 <= abs < 1e16, exponent form outside, `.0` on integral floats. */
export function pyFloatStr(value: number): string {
  if (Number.isNaN(value)) return 'nan'
  if (value === Infinity) return 'inf'
  if (value === -Infinity) return '-inf'
  if (Object.is(value, -0)) return '-0.0'
  const abs = Math.abs(value)
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e16)) {
    const [mantissa, expRaw] = value.toExponential().split('e')
    const exp = Number(expRaw)
    const sign = value < 0 ? '-' : ''
    const exponent = exp >= 0 ? `+${String(exp).padStart(2, '0')}` : `-${String(-exp).padStart(2, '0')}`
    return `${sign}${mantissa}e${exponent}`
  }
  if (Number.isInteger(value)) return `${value}.0`
  return String(value)
}

function pythonCellNumber(value: number): string {
  // Python typing produces int for integer values, float otherwise; pandas
  // and json.dumps spell them differently, so match both paths.
  return Number.isInteger(value) && Math.abs(value) < 1e16 ? String(value) : pyFloatStr(value)
}

function cellString(value: ExportValue): string {
  if (value === null) return ''
  if (typeof value === 'number') return pythonCellNumber(value)
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  return value
}

/** pandas to_csv minimal quoting: quote iff the field contains the delimiter,
 * a quote, or a line terminator. */
function quoteIfNeeded(field: string, delimiter: string): string {
  return /[",\r\n]/.test(field) || field.includes(delimiter) || field.includes('"')
    ? `"${field.replace(/"/g, '""')}"`
    : field
}

export function toDelimited(rows: readonly ExportRow[], columns: readonly ExportColumn[], delimiter: string): string {
  const header = columns.map(c => c.label).join(delimiter)
  const body = rows.map(row => columns.map(c => quoteIfNeeded(cellString(row[c.key] ?? null), delimiter)).join(delimiter))
  return [header, ...body].join('\r\n')
}

export function toCSV(rows: readonly ExportRow[], columns: readonly ExportColumn[]): string {
  return toDelimited(rows, columns, ',')
}

export function toTSV(rows: readonly ExportRow[], columns: readonly ExportColumn[]): string {
  return toDelimited(rows, columns, '\t')
}

/** JSONL matching json.dumps(record, ensure_ascii=False, default=str). */
export function toJSONL(rows: readonly ExportRow[], columns: readonly ExportColumn[]): string {
  const render = (value: ExportValue): string => {
    if (value === null) return 'null'
    if (typeof value === 'number') return pythonCellNumber(value)
    if (typeof value === 'boolean') return value ? 'true' : 'false'
    return JSON.stringify(value)
  }
  return rows
    .map(row => `{${columns.map(c => `${JSON.stringify(c.label)}:${render(row[c.key] ?? null)}`).join(',')}}`)
    .join('\n')
}

export function toXLSX(rows: readonly ExportRow[], columns: readonly ExportColumn[]): ArrayBuffer {
  const aoa = [
    columns.map(c => c.label),
    ...rows.map(row => columns.map(c => row[c.key] ?? null)),
  ]
  const sheet = XLSX.utils.aoa_to_sheet(aoa)
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'Results')
  return XLSX.write(book, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
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
