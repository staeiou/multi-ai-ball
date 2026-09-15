// Cost math for the models and review screens. Pure.

import { estimateCostUsd, formatUsd } from '../core/pricing'
import { naiveTokenCount } from '../core/tokenizer'
import type { CatalogModel } from '../core/types'

export interface CostInputs {
  /** Tokens of the constant block plus a typical item (system + prompt). */
  inputTokens: number
  outputTokens: number
  calls: number
}

export function costInputs(constantBlock: string, prompt: string, system: string, outputLength: number | null, calls: number): CostInputs {
  return {
    inputTokens: naiveTokenCount(constantBlock) + naiveTokenCount(prompt) + naiveTokenCount(system),
    outputTokens: outputLength ?? 512,
    calls: Math.max(1, calls),
  }
}

export function modelRunRange(model: CatalogModel, inputs: CostInputs): { low: number; high: number } | null {
  const pricing = model.guidance.pricing.value
  if (!pricing) return null
  const low = estimateCostUsd(pricing, inputs.inputTokens, Math.min(10, inputs.outputTokens))!
  const high = estimateCostUsd(pricing, inputs.inputTokens, inputs.outputTokens)!
  return { low: low * inputs.calls, high: high * inputs.calls }
}

export function modelCost(model: CatalogModel, inputs: CostInputs): number | null {
  return modelRunRange(model, inputs)?.high ?? null
}

export function costSummary(model: CatalogModel, inputs: CostInputs): string {
  const range = modelRunRange(model, inputs)
  const pricing = model.guidance.pricing.value
  const parts: string[] = []
  if (range) parts.push(`~${formatUsd(range.low)}–${formatUsd(range.high)} run`)
  if (pricing) parts.push(`$${(pricing.prompt * 1e6).toFixed(2)}/$${(pricing.completion * 1e6).toFixed(2)} per 1M`)
  return parts.join(' · ') || 'price unknown'
}

export function sortByCost(list: CatalogModel[], inputs: CostInputs): CatalogModel[] {
  return [...list].sort((a, b) => {
    const ca = modelCost(a, inputs)
    const cb = modelCost(b, inputs)
    if (ca === null && cb === null) return a.id.localeCompare(b.id)
    if (ca === null) return 1
    if (cb === null) return -1
    return ca - cb || a.id.localeCompare(b.id)
  })
}

export function totalRange(models: CatalogModel[], inputs: CostInputs): { low: number; high: number; unknown: number } {
  let low = 0, high = 0, unknown = 0
  for (const model of models) {
    const range = modelRunRange(model, inputs)
    if (!range) { unknown++; continue }
    low += range.low
    high += range.high
  }
  return { low, high, unknown }
}
