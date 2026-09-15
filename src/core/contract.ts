// Structured outputs: authoring -> contract -> JSON schema -> prompt prose.
// Full builder parity with Auditomatic's model: fields (name/type/min/max/
// enum/description/valueNotes), rationale-first, strict JSON, placement.
// The contract is frozen into the run; the schema goes on the wire where
// guidance says the model takes it (providers/build.ts), and the prose goes
// into the constant block for every model regardless (examples.ts).

import type { ContractAuthoring, ContractField, OutputContract, OutputContractContext } from './types'

export const CONTRACT_SCHEMA_NAME = 'multiaiball_output'

/** How a type is named to the model and to the user. */
export const TYPE_LABEL: Record<ContractField['type'], string> = {
  string: 'text',
  number: 'number',
  integer: 'whole number',
  boolean: 'true/false',
  enum: 'one choice',
  'multi-enum': 'one or more choices',
}
export const RATIONALE_FIELD_NAME = 'rationale'
export const DEFAULT_RATIONALE_SPEC =
  'A brief explanation of the answer, grounded only in the information provided.'

export type ContractErrorCode =
  | 'duplicate-name'
  | 'reserved-name-character'
  | 'enum-no-choices'
  | 'enum-duplicate-choice'
  | 'number-bound-not-finite'
  | 'number-bounds-inverted'

export interface ContractError {
  code: ContractErrorCode
  message: string
  field?: string
}

export function normalizeFieldName(name: string): string {
  return name.trim().toLowerCase()
}

/** Fields actually requested, including the mechanical rationale-first field. */
export function effectiveFields(authoring: ContractAuthoring): ContractField[] {
  const fields = (authoring.fields ?? []).map(f => ({ ...f }))
  if (authoring.rationaleFirst && !fields.some(f => normalizeFieldName(f.name) === RATIONALE_FIELD_NAME)) {
    fields.unshift({ name: RATIONALE_FIELD_NAME, type: 'string', description: authoring.rationaleSpec || DEFAULT_RATIONALE_SPEC })
  }
  return fields
}

export function resolveContract(authoring: ContractAuthoring | null | undefined): {
  contract: OutputContract
  errors: ContractError[]
} {
  const errors: ContractError[] = []
  const seen = new Map<string, string>()

  const fields: ContractField[] = []
  for (const field of effectiveFields(authoring ?? {})) {
    const name = normalizeFieldName(field.name)
    if (!name) {
      errors.push({ code: 'duplicate-name', message: 'Field names cannot be empty.' })
      continue
    }
    const prior = seen.get(name)
    if (prior) {
      errors.push({ code: 'duplicate-name', message: `Duplicate field name "${name}".`, field: name })
      continue
    }
    if (name.includes('.')) {
      errors.push({ code: 'reserved-name-character', message: `Field name "${name}" must not contain a dot.`, field: name })
      continue
    }
    seen.set(name, name)

    if (field.type === 'enum' || field.type === 'multi-enum') {
      const values = (field.values ?? []).map(v => String(v).trim()).filter(Boolean)
      if (values.length === 0) {
        errors.push({ code: 'enum-no-choices', message: `Enum field "${name}" needs at least one choice.`, field: name })
      } else if (new Set(values).size !== values.length) {
        errors.push({ code: 'enum-duplicate-choice', message: `Enum field "${name}" has duplicate choices.`, field: name })
      }
    }
    if (field.type === 'number' || field.type === 'integer') {
      const minOk = field.min === undefined || Number.isFinite(field.min)
      const maxOk = field.max === undefined || Number.isFinite(field.max)
      if (!minOk || !maxOk) {
        errors.push({ code: 'number-bound-not-finite', message: `Number field "${name}" bounds must be finite.`, field: name })
      } else if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
        errors.push({ code: 'number-bounds-inverted', message: `Number field "${name}" min exceeds max.`, field: name })
      }
    }

    fields.push({ name, type: field.type, ...(field.min !== undefined ? { min: field.min } : {}), ...(field.max !== undefined ? { max: field.max } : {}), ...(field.values?.length ? { values: field.values.map(String) } : {}), ...(field.description ? { description: field.description } : {}), ...(field.valueNotes && Object.keys(field.valueNotes).length ? { valueNotes: field.valueNotes } : {}) })
  }

  return { contract: { fields }, errors }
}

export function buildContractSchema(contract: OutputContract): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const field of contract.fields) {
    if (field.type === 'number' || field.type === 'integer') {
      properties[field.name] = {
        type: field.type,
        ...(field.min !== undefined ? { minimum: field.min } : {}),
        ...(field.max !== undefined ? { maximum: field.max } : {}),
      }
    } else if (field.type === 'enum') {
      properties[field.name] = { type: 'string', enum: field.values }
    } else if (field.type === 'multi-enum') {
      properties[field.name] = { type: 'array', items: { type: 'string', enum: field.values } }
    } else if (field.type === 'boolean') {
      properties[field.name] = { type: 'boolean' }
    } else {
      properties[field.name] = { type: 'string' }
    }
    const prop = properties[field.name] as Record<string, unknown>
    if (field.description) prop.description = field.description
    if (field.valueNotes) prop['x-value-notes'] = field.valueNotes
  }
  const required = contract.fields.map(f => f.name)
  // This is the JSON Schema itself. Provider configs own the outer
  // `response_format.json_schema = {name, strict, schema}` envelope; returning
  // that envelope here caused it to be nested a second time on the wire.
  return { type: 'object', properties, required, additionalProperties: false }
}

/** Prose instructions compiled into the prompt for models without json_schema. */
export function renderContractProse(authoring: ContractAuthoring | null | undefined): string {
  const { contract, errors } = resolveContract(authoring)
  if (errors.length > 0 || contract.fields.length === 0) return ''
  const lines: string[] = [
    authoring?.strictJson === false
      ? 'Return a JSON object containing the requested fields.'
      : 'Respond with a single JSON object, no markdown fences, no commentary.',
    `Fields (all required):`,
  ]
  for (const field of contract.fields) {
    let line = `- ${field.name} (${TYPE_LABEL[field.type]})`
    if (field.type === 'number' || field.type === 'integer') {
      const bounds = [field.min !== undefined ? `min ${field.min}` : null, field.max !== undefined ? `max ${field.max}` : null].filter(Boolean).join(', ')
      if (bounds) line += `: ${bounds}`
    } else if (field.type === 'enum') {
      line += `: exactly one of ${(field.values ?? []).map(v => `"${v}"`).join(', ')}`
    } else if (field.type === 'multi-enum') {
      line += `: a JSON array containing any of ${(field.values ?? []).map(v => `"${v}"`).join(', ')}`
    } else if (field.type === 'boolean') {
      line += ': true or false'
    }
    if (field.description) line += ` — ${field.description}`
    lines.push(line)
  }
  if (authoring?.rationaleFirst && authoring.rationaleSpec) {
    lines.push(`Include "${RATIONALE_FIELD_NAME}" first: ${authoring.rationaleSpec}`)
  }
  return lines.join('\n')
}

export function buildContractContext(authoring: ContractAuthoring | null | undefined): OutputContractContext | null {
  const { contract, errors } = resolveContract(authoring)
  if (errors.length > 0 || contract.fields.length === 0) return null
  return {
    contract,
    schema: buildContractSchema(contract),
    name: CONTRACT_SCHEMA_NAME,
    columnCount: contract.fields.length,
  }
}
