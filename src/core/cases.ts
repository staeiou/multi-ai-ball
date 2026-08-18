// Case sources: where concrete inputs come from. Both modes produce the same
// thing — a list of CaseInput whose bindings fill the template — so single and
// sheet runs are the same pipeline. Sheets are parsed in memory and never
// persisted (the lean-prompt invariant: only template + bindings are carried).

import * as XLSX from 'xlsx'

import type { CaseSource, CaseSourcePlan } from './types'
import { promptPlaceholderNames } from './template'

export interface SheetRow {
  label: string
  bindings: Record<string, unknown>
}

/** Parse an uploaded CSV/XLSX/XLS file into rows. First row = column names.
 * Empty cells bind as '' (renders as nothing); numeric cells keep numbers. */
export function parseSheetBytes(data: ArrayBuffer | string): SheetRow[] {
  const workbook = XLSX.read(data, { type: typeof data === 'string' ? 'string' : 'array' })
  const first = workbook.SheetNames[0]
  if (!first) return []
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[first], {
    defval: '',
    raw: true,
  }) as Array<Record<string, unknown>>

  const rowsOut: SheetRow[] = []
  for (const [index, row] of rows.entries()) {
    const bindings: Record<string, unknown> = {}
    for (const [rawKey, value] of Object.entries(row)) {
      const key = rawKey.trim()
      if (!key) continue
      // SheetJS already guarantees unique header names (duplicates get a
      // numeric suffix), so no extra disambiguation is needed here.
      bindings[key] = value === '' ? '' : value
    }
    rowsOut.push({ label: `Row ${index + 1}`, bindings })
  }
  return rowsOut
}

/** Placeholders present in either channel but never bound by a case. */
export function unresolvedPlaceholders(template: string, systemTemplate: string, bindings: Record<string, unknown>): string[] {
  return promptPlaceholderNames(template, systemTemplate).filter(name => !(name in bindings))
}

export function buildPlan(
  source: CaseSource,
  template: string,
  systemTemplate: string,
  sheetRows?: SheetRow[],
  manualBindings: Record<string, unknown> = {},
): CaseSourcePlan {
  if (source.kind === 'single') {
    return {
      source,
      template,
      systemTemplate,
      cases: [{ id: 'case0', label: 'Input', bindings: manualBindings }],
    }
  }
  const rows = sheetRows ?? []
  return {
    source,
    template,
    systemTemplate,
    cases: rows.map((row, index) => ({
      id: `row${index}`,
      label: row.label,
      bindings: row.bindings,
    })),
  }
}

/** Suggested template name for a sheet source: "Prompt template (Sheet name)". */
export function defaultTemplateName(sheetName: string): string {
  return `Prompt template (${sheetName})`
}