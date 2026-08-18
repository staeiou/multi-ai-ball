// Cost math shared by the model stage and the review stage. Pure: takes
// explicit inputs, renders strings — no DOM, no global state.

import { estimateCostUsd, formatUsd } from '../core/pricing'
import type { ModelCatalogEntry, ParamOverrides } from '../core/types'
import { ASSUMED_OUTPUT_TOKENS, CONFIRM_THRESHOLD_USD } from './constants'

export interface CostInputs {
  models: ModelCatalogEntry[]
  selected: string[]
  tokenEstimate: number
  prompt: string
  system: string
  params: ParamOverrides
  repeats: number
  caseCount: number
}

export function selectedModels(inputs: Pick<CostInputs, 'models' | 'selected'>): ModelCatalogEntry[] {
  return inputs.selected
    .map(id => inputs.models.find(m => m.id === id))
    .filter((m): m is ModelCatalogEntry => m !== undefined)
}

export function modelCost(m: ModelCatalogEntry, inputs: CostInputs): number | null {
  if (!m.pricing) return null
  const tokens = inputs.tokenEstimate || Math.ceil((inputs.prompt + inputs.system).length / 4)
  return estimateCostUsd(m.pricing, tokens, inputs.params.maxTokens ?? ASSUMED_OUTPUT_TOKENS)
}

export function modelCostRange(m: ModelCatalogEntry, inputs: CostInputs): { low: number; high: number } | null {
  if (!m.pricing) return null
  const tokens = inputs.tokenEstimate || Math.ceil((inputs.prompt + inputs.system).length / 4)
  const highTokens = inputs.params.maxTokens ?? ASSUMED_OUTPUT_TOKENS
  const low = estimateCostUsd(m.pricing, tokens, Math.min(10, highTokens))
  const high = estimateCostUsd(m.pricing, tokens, highTokens)
  if (low === null || high === null) return null
  return { low, high }
}

/** Whole-run range for one model: 10–max output tokens × all calls. */
export function modelRunRange(m: ModelCatalogEntry, inputs: CostInputs): { low: number; high: number } | null {
  const range = modelCostRange(m, inputs)
  if (!range) return null
  const calls = Math.max(1, inputs.caseCount) * Math.max(1, inputs.repeats)
  return { low: range.low * calls, high: range.high * calls }
}

export function costSummary(m: ModelCatalogEntry, inputs: CostInputs): string {
  const parts: string[] = []
  const range = modelRunRange(m, inputs)
  if (range) parts.push(`~${formatUsd(range.low)}–${formatUsd(range.high)} all rows`)
  if (m.pricing) parts.push(`${fmtPerMillion(m.pricing.prompt * 1e6)}/${fmtPerMillion(m.pricing.completion * 1e6)}M / 1M`)
  return parts.join(' · ')
}

export function fmtPerMillion(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value >= 10 ? value.toFixed(1) : value.toFixed(2)
}

export function sortByCost(list: ModelCatalogEntry[], inputs: CostInputs): ModelCatalogEntry[] {
  return [...list].sort((a, b) => {
    const ca = modelCost(a, inputs)
    const cb = modelCost(b, inputs)
    if (ca === null && cb === null) return a.id.localeCompare(b.id)
    if (ca === null) return 1
    if (cb === null) return -1
    return ca - cb || a.id.localeCompare(b.id)
  })
}

export function estimateTotalRange(inputs: CostInputs): { low: number; high: number } {
  return selectedModels(inputs).reduce((sum, model) => {
    const range = modelRunRange(model, inputs)
    return range ? { low: sum.low + range.low, high: sum.high + range.high } : sum
  }, { low: 0, high: 0 })
}

export function estimateTotalText(inputs: CostInputs): string {
  const range = estimateTotalRange(inputs)
  if (range.high <= 0) return ''
  const models = selectedModels(inputs).length
  return `~${formatUsd(range.low)}–${formatUsd(range.high)} (${inputs.caseCount} case${inputs.caseCount === 1 ? '' : 's'} × ${models} model${models === 1 ? '' : 's'}${inputs.repeats > 1 ? ` × ${inputs.repeats}` : ''}; 10–${inputs.params.maxTokens ?? ASSUMED_OUTPUT_TOKENS} output tokens)`
}

export { ASSUMED_OUTPUT_TOKENS, CONFIRM_THRESHOLD_USD }
