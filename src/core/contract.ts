// Structured outputs: authoring -> contract -> JSON schema -> prompt prose.
// Full builder parity with Auditomatic's model: fields (name/type/min/max/
// enum/description/valueNotes), rationale-first, strict JSON, placement.
// The contract is frozen on each run's snapshot; the schema goes into
// response_format when the model's supported_parameters allow it, and the
// prose instructs every model regardless.

import type { ContractAuthoring, ContractField, ContractPlacement, OutputContract, OutputContractContext } from './types'

export const CONTRACT_SCHEMA_NAME = 'multiaiball_output'
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

    if (field.type === 'enum') {
      const values = (field.values ?? []).map(v => String(v).trim()).filter(Boolean)
      if (values.length === 0) {
        errors.push({ code: 'enum-no-choices', message: `Enum field "${name}" needs at least one choice.`, field: name })
      } else if (new Set(values).size !== values.length) {
        errors.push({ code: 'enum-duplicate-choice', message: `Enum field "${name}" has duplicate choices.`, field: name })
      }
    }
    if (field.type === 'number') {
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
    if (field.type === 'number') {
      properties[field.name] = {
        type: 'number',
        ...(field.min !== undefined ? { minimum: field.min } : {}),
        ...(field.max !== undefined ? { maximum: field.max } : {}),
      }
    } else if (field.type === 'enum') {
      properties[field.name] = { type: 'string', enum: field.values }
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
    let line = `- ${field.name} (${field.type})`
    if (field.type === 'number') {
      const bounds = [field.min !== undefined ? `min ${field.min}` : null, field.max !== undefined ? `max ${field.max}` : null].filter(Boolean).join(', ')
      if (bounds) line += `: ${bounds}`
    } else if (field.type === 'enum') {
      line += `: one of ${(field.values ?? []).map(v => `"${v}"`).join(', ')}`
    }
    if (field.description) line += ` — ${field.description}`
    lines.push(line)
  }
  if (authoring?.rationaleFirst && authoring.rationaleSpec) {
    lines.push(`Include "${RATIONALE_FIELD_NAME}" first: ${authoring.rationaleSpec}`)
  }
  return lines.join('\n')
}

/** Compile the contract prose into the prompt channels per placement. */
export function compileContractChannels(
  authoring: ContractAuthoring | null | undefined,
  placement: ContractPlacement,
  userPrompt: string,
  systemPrompt: string,
): { userPrompt: string; systemPrompt: string } {
  const prose = renderContractProse(authoring)
  if (!prose || placement === 'none') return { userPrompt, systemPrompt }

  const block = `<output-format>\n${prose}\n</output-format>`
  if (placement.startsWith('system')) {
    const merged = systemPrompt ? `${systemPrompt}\n\n${block}` : block
    return {
      userPrompt,
      systemPrompt: placement === 'system-before' && systemPrompt ? `${block}\n\n${systemPrompt}` : merged,
    }
  }
  const mergedUser = userPrompt ? `${userPrompt}\n\n${block}` : block
  return {
    userPrompt: placement === 'user-before' ? `${block}\n\n${userPrompt}` : mergedUser,
    systemPrompt,
  }
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
