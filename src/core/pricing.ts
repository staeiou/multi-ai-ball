// Cost math and formatting. Prices come with the model from its provider's
// authority (OpenRouter's catalog; models.dev for OpenAI and Anthropic) as
// USD per token on the model's guidance; nothing is fetched here.

export interface UnitPrices {
  prompt: number
  completion: number
}

/** Estimate a single call's USD cost. */
export function estimateCostUsd(pricing: UnitPrices | null | undefined, inputTokens: number, outputTokens: number): number | null {
  if (!pricing) return null
  return inputTokens * pricing.prompt + outputTokens * pricing.completion
}

/** Compact USD formatting across the per-token scale. */
export function formatUsd(value: number | null | undefined): string {
  if (value == null) return '—'
  if (value === 0) return '$0.000000'
  if (Math.abs(value) < 0.001) return `$${value.toFixed(6)}`
  if (Math.abs(value) < 1) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

/** "$0.15 / $0.60 per 1M" style summary of unit prices. */
export function formatPerMillion(pricing: UnitPrices | null | undefined): string {
  if (!pricing) return 'price unknown'
  const per = (value: number): string => {
    const m = value * 1e6
    return m >= 100 ? String(Math.round(m)) : m >= 10 ? m.toFixed(1) : m.toFixed(2)
  }
  return `$${per(pricing.prompt)} in / $${per(pricing.completion)} out per 1M tokens`
}
