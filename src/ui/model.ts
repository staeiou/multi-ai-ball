// Derived state, in one pure place: what rows the current flow produces,
// which are examples and targets, what the constant block would be, and
// whether each stage lets the user advance. The wizard and the Run button both
// read `stageGate`, so they cannot disagree.

import { cartesianRows, parseSweepValues, sweepCaseCount, sweepLabel } from '../core/cases'
import type { SweepVariable } from '../core/cases'
import { resolveContract } from '../core/contract'
import { compileConstantBlock } from '../core/examples'
import { templateProblems } from '../core/freeze'
import { columnsOf, columnsWithRole, defaultRoles, inferPartition } from '../core/partition'
import { generatedItemTemplate, guessField } from '../core/guess'
import type { Row } from '../core/partition'
import { presetById } from '../core/providers/presets'
import { promptPlaceholderNames } from '../core/template'
import type { CatalogModel, ColumnRole, Partition } from '../core/types'
import type { PersistedState } from '../state'
import type { AppData, Session } from './store'

export const SWEEP_WARN = 1000
export const SWEEP_MAX = 20000

/** The blanks the prompt (and instructions) actually use, in order of first
 * appearance. state.sweep holds values by name; a name with no placeholder
 * does not multiply the cases. */
export function sweepPlaceholders(state: PersistedState): string[] {
  return promptPlaceholderNames(state.prompt, state.system)
}

export function sweepVariables(state: PersistedState): SweepVariable[] {
  const byName = new Map(state.sweep.map(v => [v.name.trim(), parseSweepValues(v.values)]))
  return sweepPlaceholders(state).map(name => ({ name, values: byName.get(name) ?? [] })).filter(v => v.values.length)
}

/** The rows the current flow produces, with the roles that apply to them. */
export function currentRows(data: AppData): { rows: Row[]; roles: Record<string, ColumnRole>; columns: string[]; label: (ordinal: number) => string } {
  const { state, session } = data
  if (state.flow === 'sheet' && session.sheet) {
    const roles: Record<string, ColumnRole> = {}
    for (const column of session.sheet.columns) roles[column] = state.roles[column] ?? 'metadata'
    // Output columns the user added that the sheet does not have.
    for (const [column, role] of Object.entries(state.roles)) if (role === 'output' && !(column in roles)) roles[column] = 'output'
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

/** Template-level problems: placeholders that cannot be bound. */
export function promptProblems(data: AppData): string[] {
  const { state } = data
  const problems: string[] = []
  if (state.flow === 'sheet') {
    if (!data.session.sheet) return problems
    const { roles } = currentRows(data)
    for (const p of templateProblems(state.prompt, state.system, roles, true)) problems.push(p.message)
  } else if (state.flow === 'sweep') {
    // Every placeholder is a variable by definition; problems are about values (dataProblems).
  } else {
    const names = promptPlaceholderNames(state.prompt, state.system)
    if (names.length) problems.push(`{{${names[0]}}} has no value in single-prompt mode; use a sweep or a spreadsheet, or remove it`)
  }
  return problems
}

/** Problems with the data step alone (before instructions are written). */
export function dataProblems(data: AppData): string[] {
  const { state, session } = data
  if (state.flow === 'sheet') {
    if (!session.sheet) return ['Upload a spreadsheet']
    const { roles } = currentRows(data)
    const problems: string[] = []
    if (columnsWithRole(roles, 'input').length === 0) problems.push('Choose at least one column for the model to read')
    if (caseCount(data) === 0) problems.push('No rows to fill in: every row already has its answers, or has them half filled')
    return problems
  }
  if (state.flow === 'sweep') {
    if (!state.prompt.trim()) return ['Write the prompt, with {{blanks}} where a value should vary']
    const names = sweepPlaceholders(state)
    if (names.length === 0) return ['Put at least one blank like {{name}} in the prompt']
    const filled = new Set(sweepVariables(state).map(v => v.name))
    const empty = names.filter(n => !filled.has(n))
    if (empty.length) return [`Give ${empty.map(n => `{{${n}}}`).join(' and ')} at least one value`]
    const count = sweepCaseCount(sweepVariables(state))
    if (count > SWEEP_MAX) return [`${count.toLocaleString()} combinations is above the ${SWEEP_MAX.toLocaleString()} limit`]
  }
  return []
}

export function instructionProblems(data: AppData): string[] {
  const { state } = data
  const problems: string[] = []
  if (state.flow === 'sheet') {
    if (!state.system.trim() && !state.prompt.replace(/\{\{[^}]+\}\}/g, '').trim()) problems.push('Tell the model what to do with each row')
  } else if (state.flow === 'single' && !state.prompt.trim()) problems.push('Write your prompt first')
  for (const p of promptProblems(data)) if (!problems.includes(p) && !dataProblems(data).includes(p)) problems.push(p)
  return problems
}

export const STEP = { data: 0, instructions: 1, format: 2, models: 3, settings: 4, review: 5, results: 6 } as const

export function stageGate(step: number, data: AppData): Gate {
  const { state, session } = data
  const preset = presetById(state.providerId)
  const contractOk = resolveContract(state.contract).errors.length === 0
  const selected = selectedCatalogModels(data)
  const modelBlockers: string[] = []
  if (preset.id === 'custom' && !state.customBase.trim()) modelBlockers.push('Enter the endpoint base URL')
  else if (!catalogCurrent(state, session)) modelBlockers.push('Load the model list')
  else if (selected.length === 0) modelBlockers.push('Pick at least one model')
  if (preset.keyRequired && !session.apiKey) modelBlockers.push('Add your API key (the list may load without it; a run will not)')

  let own: string[] = []
  if (step === STEP.data) own = dataProblems(data)
  else if (step === STEP.instructions) own = instructionProblems(data)
  else if (step === STEP.format) own = contractOk ? [] : ['Fix the answer-format problems']
  else if (step === STEP.models) own = modelBlockers
  else if (step === STEP.review) own = [...dataProblems(data), ...instructionProblems(data), ...(contractOk ? [] : ['Fix the answer-format problems']), ...modelBlockers]
  return { ok: own.length === 0, why: own.join(' · ') }
}

export function canRun(data: AppData): Gate {
  return stageGate(STEP.review, data)
}

/** Re-derive the generated item template and answer fields from the roles
 * when the user has not taken them over. Called after any roles change. */
export function applyGuesses(data: AppData): void {
  const { state } = data
  if (state.flow !== 'sheet') return
  const { rows, roles } = currentRows(data)
  const inputs = columnsWithRole(roles, 'input')
  const outputs = columnsWithRole(roles, 'output')
  if (state.promptAuto) state.prompt = generatedItemTemplate(inputs)
  if (state.contractAuto) {
    state.contract.fields = outputs.map(column => guessField(rows, column))
    state.parserId = outputs.length ? 'json-unstack' : null
  }
}
