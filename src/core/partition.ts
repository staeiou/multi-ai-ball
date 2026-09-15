// Column roles and the sparsity partition. The spreadsheet's own shape decides
// which rows teach and which rows are the work: a row with every declared
// output column filled is a worked-example candidate, a row with every output
// blank is a target, a row with some filled is ambiguous and excluded until the
// user resolves it. No output columns declared: every row is a target.

import type { ColumnRole, Partition } from './types'

export type Row = Record<string, unknown>

export function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (typeof value === 'number') return Number.isNaN(value)
  return false
}

export function columnsWithRole(roles: Record<string, ColumnRole>, role: ColumnRole): string[] {
  return Object.entries(roles).filter(([, r]) => r === role).map(([name]) => name)
}

export function inferPartition(rows: readonly Row[], roles: Record<string, ColumnRole>): Partition {
  const outputs = columnsWithRole(roles, 'output')
  const partition: Partition = { examples: [], targets: [], ambiguous: [] }
  rows.forEach((row, ordinal) => {
    if (outputs.length === 0) {
      partition.targets.push(ordinal)
      return
    }
    const filled = outputs.filter(column => !isBlank(row[column])).length
    if (filled === outputs.length) partition.examples.push(ordinal)
    else if (filled === 0) partition.targets.push(ordinal)
    else partition.ambiguous.push(ordinal)
  })
  return partition
}

/** Default roles for a freshly loaded sheet: every column is an input. The
 * user then marks outputs (and references) and the partition follows. */
export function defaultRoles(columns: readonly string[]): Record<string, ColumnRole> {
  return Object.fromEntries(columns.map(column => [column, 'input' as ColumnRole]))
}

/** Column names in first-seen order across rows. */
export function columnsOf(rows: readonly Row[]): string[] {
  const seen: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!seen.includes(key)) seen.push(key)
  }
  return seen
}
