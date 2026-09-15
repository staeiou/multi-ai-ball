// The constant block: worked examples plus the output-format prose, rendered
// once per run and appended to the system channel of every call. The browser
// renders it; the Python bundle receives it verbatim (no twin). The layout is
// fixed and documented here because the analyst reads it in the preview and
// cites it: each example shows the item exactly as the model will see items
// (the item template rendered with that row), then the human's outputs as a
// JSON object shaped like the output contract.

import { effectiveFields, normalizeFieldName, renderContractProse } from './contract'
import { columnsWithRole, isBlank } from './partition'
import type { Row } from './partition'
import { renderPromptTemplate } from './template'
import type { ColumnRole, ContractAuthoring, ContractField } from './types'

const PLAIN_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/
const PLAIN_INTEGER = /^-?(?:0|[1-9]\d*)$/
const BOOL_TRUE = new Set(['true', 'yes', '1', 'y', 't'])
const BOOL_FALSE = new Set(['false', 'no', '0', 'n', 'f'])

/** A human's cell value, coerced to the contract field's type where one
 * exists; kept as text otherwise. Unparseable values stay text so the model
 * sees what the human wrote rather than a silent null. */
export function coerceExampleValue(value: unknown, field: ContractField | undefined): unknown {
  if (typeof value !== 'string') {
    if (field?.type === 'multi-enum' && !Array.isArray(value)) return [String(value)]
    return value
  }
  const text = value.trim()
  switch (field?.type) {
    case 'number':
      return PLAIN_DECIMAL.test(text) ? Number(text) : text
    case 'integer':
      return PLAIN_INTEGER.test(text) ? Number(text) : text
    case 'boolean': {
      const lower = text.toLowerCase()
      if (BOOL_TRUE.has(lower)) return true
      if (BOOL_FALSE.has(lower)) return false
      return text
    }
    case 'multi-enum':
      return text.split(/[;,|]/).map(part => part.trim()).filter(Boolean)
    default:
      return text
  }
}

export interface ExampleBlockInput {
  rows: readonly Row[]
  roles: Record<string, ColumnRole>
  /** Source ordinals in prompt order. */
  exampleOrdinals: readonly number[]
  itemTemplate: string
  contract: ContractAuthoring | null
}

/** The output object for one example row: every declared output column that
 * is filled, keyed by column name, coerced by the matching contract field. */
export function exampleOutput(row: Row, roles: Record<string, ColumnRole>, contract: ContractAuthoring | null): Record<string, unknown> {
  const fields = new Map<string, ContractField>()
  for (const field of effectiveFields(contract ?? {})) fields.set(normalizeFieldName(field.name), field)
  const out: Record<string, unknown> = {}
  for (const column of columnsWithRole(roles, 'output')) {
    if (isBlank(row[column])) continue
    const field = fields.get(normalizeFieldName(column))
    out[field ? field.name : column] = coerceExampleValue(row[column], field)
  }
  return out
}

export function renderExamples(input: ExampleBlockInput): string {
  const blocks: string[] = []
  for (const ordinal of input.exampleOrdinals) {
    const row = input.rows[ordinal]
    if (!row) continue
    const output = exampleOutput(row, input.roles, input.contract)
    if (Object.keys(output).length === 0) continue
    const item = renderPromptTemplate(input.itemTemplate, row)
    blocks.push(`<example>\n<input>\n${item}\n</input>\n<output>\n${JSON.stringify(output)}\n</output>\n</example>`)
  }
  if (blocks.length === 0) return ''
  return `<examples>\nThe following are worked examples of the task, with the expected output for each.\n${blocks.join('\n')}\n</examples>`
}

/** Examples first, then the output-format prose. Empty string when neither exists. */
export function compileConstantBlock(input: ExampleBlockInput): string {
  const parts: string[] = []
  const examples = renderExamples(input)
  if (examples) parts.push(examples)
  const prose = renderContractProse(input.contract)
  if (prose) parts.push(`<output-format>\n${prose}\n</output-format>`)
  return parts.join('\n\n')
}
