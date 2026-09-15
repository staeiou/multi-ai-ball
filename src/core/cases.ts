// Case sources: where rows come from. Every flow produces the same thing,
// `Row[]` plus column names, and freeze.ts does the rest, so a single prompt,
// a Cartesian sweep, and a spreadsheet are one pipeline.
//
//   single  -> one empty row, every placeholder bound by hand (or none)
//   sweep   -> the Cartesian product of named value lists
//   sheet   -> the uploaded file's rows (SheetJS, in a worker: sheet.worker.ts)

import * as XLSX from 'xlsx'

import type { Row } from './partition'

export interface SheetData {
  name: string
  columns: string[]
  rows: Row[]
}

/** Parse CSV/TSV/XLSX/XLS/JSON/JSONL bytes into rows. First row = column names
 * for tabular formats; JSON must be an array of objects, JSONL one per line.
 * Empty cells bind as '' (renders as nothing); numeric cells keep numbers. */
export function parseSheetBytes(data: ArrayBuffer, filename = ''): SheetData {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.json') || lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) {
    return parseJsonRows(new TextDecoder().decode(data), filename)
  }
  const workbook = XLSX.read(data, { type: 'array' })
  const first = workbook.SheetNames[0]
  if (!first) return { name: filename, columns: [], rows: [] }
  const raw = XLSX.utils.sheet_to_json(workbook.Sheets[first]!, { defval: '', raw: true }) as Array<Record<string, unknown>>
  const rows: Row[] = []
  const columns: string[] = []
  for (const record of raw) {
    const row: Row = {}
    for (const [rawKey, value] of Object.entries(record)) {
      const key = rawKey.trim()
      if (!key) continue
      if (!columns.includes(key)) columns.push(key)
      row[key] = value
    }
    rows.push(row)
  }
  return { name: first === 'Sheet1' && filename ? filename : first, columns, rows }
}

export function parseJsonRows(text: string, filename: string): SheetData {
  const trimmed = text.trim()
  let records: unknown[]
  if (trimmed.startsWith('[')) {
    records = JSON.parse(trimmed) as unknown[]
  } else {
    records = trimmed.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line) as unknown)
  }
  const columns: string[] = []
  const rows: Row[] = records.map(record => {
    const row: Row = {}
    if (record && typeof record === 'object' && !Array.isArray(record)) {
      for (const [key, value] of Object.entries(record as Row)) {
        if (!columns.includes(key)) columns.push(key)
        row[key] = value !== null && typeof value === 'object' ? JSON.stringify(value) : value
      }
    }
    return row
  })
  return { name: filename, columns, rows }
}

// --- Cartesian sweep ---------------------------------------------------------------

export interface SweepVariable {
  name: string
  values: string[]
}

export function parseSweepValues(text: string): string[] {
  return text.split(/\r?\n/).map(v => v.trim()).filter(Boolean)
}

export function sweepCaseCount(variables: readonly SweepVariable[]): number {
  return variables.reduce((n, v) => n * Math.max(1, v.values.length), variables.length ? 1 : 0)
}

/** Every combination, first variable slowest. */
export function cartesianRows(variables: readonly SweepVariable[]): Row[] {
  const live = variables.filter(v => v.name.trim() && v.values.length)
  if (live.length === 0) return []
  let rows: Row[] = [{}]
  for (const variable of live) {
    const next: Row[] = []
    for (const row of rows) for (const value of variable.values) next.push({ ...row, [variable.name.trim()]: value })
    rows = next
  }
  return rows
}

export function sweepLabel(row: Row): string {
  return Object.values(row).map(String).join(' · ')
}
