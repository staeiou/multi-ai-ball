// The app's derived state, in one pure place. No DOM, no listeners — every
// decision a stage or the wizard makes about readiness, staleness, or
// invalidation flows through these functions, so non-linear navigation (go
// back, change provider, come forward) cannot leave the UI believing
// something that the run pipeline will not honor.

import type {
  CaseSource,
  ContractAuthoring,
  ContractPlacement,
  ModelCatalogEntry,
  ParamOverrides,
} from '../core/types'

export interface AppSession {
  apiKey: string
  models: ModelCatalogEntry[]
  zdrIds: Set<string>
  sheetRowCount: number
  tokenEstimate: number
  /** The provider/base URL pair the loaded model list is valid for. */
  modelsCarriedBy: string
}

export interface AppPersisted {
  presetId: string
  customBase: string
  prompt: string
  system: string
  source: CaseSource
  selected: string[]
  params: ParamOverrides
  contract: ContractAuthoring
  placement: ContractPlacement
  parserId: string | null
  repeats: number
  zdr: boolean
  hideFreeModels: boolean
  budget: number
  retries: number
  concurrency: number
  stream: boolean
  streamThreshold: number
}

export interface PresetLike {
  id: string
  customBase?: boolean
}

/** A key is required unless the endpoint is the user's own custom one (its
 * label says "optional for local servers"). OpenRouter's model list is
 * public — the list loading is NOT proof the run will authenticate. */
export function providerKeyRequired(preset: PresetLike): boolean {
  return !preset.customBase
}

export function modelsCacheKey(presetId: string, baseUrl: string): string {
  return `${presetId}|${baseUrl}`
}

export function modelsAreCurrent(
  session: Pick<AppSession, 'modelsCarriedBy'>,
  presetId: string,
  baseUrl: string,
): boolean {
  return session.modelsCarriedBy === modelsCacheKey(presetId, baseUrl)
}

/** Everything that decides what a run WILL DO, encoded so any piece changing
 * invalidates the fingerprint. Used to flag displayed results as stale the
 * moment the user edits something and navigates back to Results. */
export function planFingerprint(input: {
  state: AppPersisted
  session: Pick<AppSession, 'sheetRowCount'>
  sheetTemplate: string
}): string {
  const { state, session } = input
  const seed = {
    p: state.prompt,
    s: state.system,
    k: state.source.kind,
    r: state.source.kind === 'sheet' ? session.sheetRowCount : 0,
    st: input.sheetTemplate,
    c: state.contract,
    pl: state.placement,
    pr: state.parserId,
    m: [...state.selected].sort(),
    t: state.repeats,
    para: state.params,
    z: state.zdr,
  }
  return JSON.stringify(seed)
}

/** The question each stage must answer before the user may advance. Pure:
 * the wizard and the Run button share it, so no path through the UI can
 * disagree with another. */
export function stageGate(
  step: number,
  deps: {
    state: AppPersisted
    session: AppSession
    preset: PresetLike
    baseUrl: string
    contractOk: boolean
  },
): { ok: boolean; why: string; canRun: boolean } {
  const { state, session, preset, baseUrl } = deps
  const promptOk = state.prompt.trim().length > 0
  const sourceOk = state.source.kind === 'single'
    ? promptOk
    : promptOk && session.sheetRowCount > 0
  const modelsCurrent = modelsAreCurrent(session, preset.id, baseUrl)
  const keyOk = !providerKeyRequired(preset) || session.apiKey.length > 0
  const selectedOk = state.selected.length > 0 && state.selected.some(id => session.models.some(m => m.id === id))
  const contractOk = deps.contractOk || (state.contract.fields?.length ?? 0) === 0
  const contractBlocker = contractOk ? null : 'Fix the output-format errors before running'

  if (step === 0) {
    return promptOk
      ? { ok: true, why: '', canRun: false }
      : { ok: false, why: 'Write a prompt first', canRun: false }
  }
  if (step === 2 || step === 4) {
    const blockers: string[] = []
    if (!sourceOk) blockers.push('Write a prompt first')
    if (!modelsCurrent) blockers.push('Load the model list first (the provider changed)')
    if (modelsCurrent && !selectedOk) blockers.push('Select at least one loaded model')
    if (modelsCurrent && !keyOk) blockers.push('Add the API key above — the list loads without it, the run does not')
    if (contractBlocker) blockers.push(contractBlocker)
    const canRun = blockers.length === 0
    return { ok: canRun, why: blockers.join(' · '), canRun }
  }
  return { ok: true, why: '', canRun: false }
}
