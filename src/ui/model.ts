// Derived state, in one pure place: what rows the current flow produces,
// which are examples and targets, what the constant block would be, and
// whether each stage lets the user advance. The wizard and the Run button both
// read `stageGate`, so they cannot disagree.

import { cartesianRows, parseSweepValues, sweepCaseCount, sweepLabel } from '../core/cases'
import type { SweepVariable } from '../core/cases'
import { resolveContract } from '../core/contract'
import { compileConstantBlock } from '../core/examples'
import { templateProblems } from '../core/freeze'
import { columnsOf, defaultRoles, inferPartition } from '../core/partition'
import type { Row } from '../core/partition'
import { presetById } from '../core/providers/presets'
import { promptPlaceholderNames } from '../core/template'
import type { CatalogModel, ColumnRole, Partition } from '../core/types'
import type { PersistedState } from '../state'
import type { AppData, Session } from './store'

export const SWEEP_WARN = 1000
export const SWEEP_MAX = 20000

export function sweepVariables(state: PersistedState): SweepVariable[] {
  return state.sweep.map(v => ({ name: v.name.trim(), values: parseSweepValues(v.values) })).filter(v => v.name && v.values.length)
}

/** The rows the current flow produces, with the roles that apply to them. */
export function currentRows(data: AppData): { rows: Row[]; roles: Record<string, ColumnRole>; columns: string[]; label: (ordinal: number) => string } {
  const { state, session } = data
  if (state.flow === 'sheet' && session.sheet) {
    const roles: Record<string, ColumnRole> = {}
    for (const column of session.sheet.columns) roles[column] = state.roles[column] ?? 'input'
    return { rows: session.sheet.rows, roles, columns: session.sheet.columns, label: o => `Row ${o + 1}` }
  }
  if (state.flow === 'sweep') {
    const rows = cartesianRows(sweepVariables(state))
    const columns = columnsOf(rows)
    return { rows, roles: defaultRoles(columns), columns, label: o => sweepLabel(rows[o] ?? {}) }
  }
  return { rows: [{}], roles: {}, columns: [], label: () => 'Input' }
}

export function currentPartition(data: AppData): Partition {
  if (data.session.partitionOverride) return data.session.partitionOverride
  const { rows, roles } = currentRows(data)
  return inferPartition(rows, roles)
}

export function caseCount(data: AppData): number {
  return currentPartition(data).targets.length
}

/** The constant block the run would carry, for preview and token estimates. */
export function previewConstantBlock(data: AppData): string {
  const { rows, roles } = currentRows(data)
  return compileConstantBlock({
    rows,
    roles,
    exampleOrdinals: currentPartition(data).examples,
    itemTemplate: data.state.prompt,
    contract: data.state.contract,
  })
}

export function catalogKey(providerId: string, baseUrl: string): string {
  return `${providerId}|${baseUrl}`
}

export function currentBaseUrl(state: PersistedState): string {
  const preset = presetById(state.providerId)
  return preset.id === 'custom' ? state.customBase.trim().replace(/\/+$/, '') : preset.baseUrl
}

export function catalogCurrent(state: PersistedState, session: Session): boolean {
  return session.catalogKey === catalogKey(state.providerId, currentBaseUrl(state))
}

export function selectedCatalogModels(data: AppData): CatalogModel[] {
  const byId = new Map(data.session.catalog.map(m => [m.id, m]))
  return data.state.selected.map(s => byId.get(s.id)).filter((m): m is CatalogModel => m !== undefined)
}

export function visibleCatalog(data: AppData): CatalogModel[] {
  const { state, session } = data
  return session.catalog.filter(model => {
    if (state.hideFreeModels && model.free) return false
    if (state.zdrOnly && state.providerId === 'openrouter' && !session.zdrIds.has(model.id)) return false
    return true
  })
}

export interface Gate {
  ok: boolean
  why: string
}

/** Problems with the prompt-and-data stage, in the order a user should fix them. */
export function promptProblems(data: AppData): string[] {
  const { state, session } = data
  const problems: string[] = []
  if (!state.prompt.trim()) problems.push('Write the prompt first')
  if (state.flow === 'sheet') {
    if (!session.sheet) problems.push('Upload a spreadsheet')
    else {
      const { roles } = currentRows(data)
      for (const p of templateProblems(state.prompt, state.system, roles, true)) problems.push(p.message)
      if (caseCount(data) === 0) problems.push('No rows to run: every row is either an example or has partly filled outputs')
    }
  } else if (state.flow === 'sweep') {
    const variables = sweepVariables(state)
    if (variables.length === 0) problems.push('Add at least one variable with values')
    const count = sweepCaseCount(variables)
    if (count > SWEEP_MAX) problems.push(`${count.toLocaleString()} combinations is above the ${SWEEP_MAX.toLocaleString()} limit`)
    const names = new Set(variables.map(v => v.name))
    for (const name of promptPlaceholderNames(state.prompt, state.system)) if (!names.has(name)) problems.push(`{{${name}}} is not one of the variables`)
    for (const name of names) if (!promptPlaceholderNames(state.prompt, state.system).includes(name)) problems.push(`Variable ${name} is never used in the prompt`)
  } else {
    const names = promptPlaceholderNames(state.prompt, state.system)
    if (names.length) problems.push(`{{${names[0]}}} has no value in single-prompt mode; switch to a sweep or a spreadsheet, or remove it`)
  }
  return problems
}

export function stageGate(step: number, data: AppData): Gate {
  const { state, session } = data
  const preset = presetById(state.providerId)
  const contractOk = resolveContract(state.contract).errors.length === 0
  const selected = selectedCatalogModels(data)
  const blockers: string[] = []
  if (step >= 0) blockers.push(...promptProblems(data))
  if (step >= 1 && !contractOk) blockers.push('Fix the output-format errors')
  if (step >= 2) {
    if (preset.id === 'custom' && !state.customBase.trim()) blockers.push('Enter the endpoint base URL')
    else if (!catalogCurrent(state, session)) blockers.push('Load the model list')
    else if (selected.length === 0) blockers.push('Select at least one model')
    if (preset.keyRequired && !session.apiKey) blockers.push('Add your API key (the list may load without it; a run will not)')
  }
  if (step === 0 || step === 1 || step === 2 || step === 4) {
    const own = step === 0 ? promptProblems(data) : step === 1 ? (contractOk ? [] : ['Fix the output-format errors']) : step === 2 ? blockers.filter(b => !promptProblems(data).includes(b) && b !== 'Fix the output-format errors') : blockers
    return { ok: own.length === 0, why: own.join(' · ') }
  }
  return { ok: true, why: '' }
}

export function canRun(data: AppData): Gate {
  return stageGate(4, data)
}
