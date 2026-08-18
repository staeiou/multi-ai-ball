// Live pricing. No hardcoded price tables: the same live sources Auditomatic
// Lite uses.
//
//   - OpenRouter  -> its own `/v1/models` list embeds `pricing` per model.
//   - OpenAI / Anthropic -> the LiteLLM model-prices registry (mirrored at the
//     same URL Auditomatic Lite fetches), keyed by model id.
//   - Custom endpoints -> unknown pricing (null).
//
// The LiteLLM registry is fetched once per hour, tolerates failure (empty
// registry -> unknown costs, never a crash).

import type { ModelCatalogEntry } from './types'

export interface UnitPrices {
  prompt: number
  completion: number
}

export interface LiteLLMModel {
  litellm_provider?: string
  input_cost_per_token?: number
  output_cost_per_token?: number
  max_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
}

export const LITELLM_REGISTRY_URL = 'https://ollama.models.auditomatic.org/litellm_model_prices_and_context_window.json'
const REGISTRY_TTL = 60 * 60 * 1000
const REGISTRY_TIMEOUT = 10_000

let registryCache: Record<string, LiteLLMModel> | null = null
let registryAt = 0
let registryInflight: Promise<Record<string, LiteLLMModel>> | null = null

async function loadRegistry(): Promise<Record<string, LiteLLMModel>> {
  if (registryCache && Date.now() - registryAt < REGISTRY_TTL) return registryCache
  if (registryInflight) return registryInflight
  registryInflight = (async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT)
    try {
      const res = await fetch(LITELLM_REGISTRY_URL, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as Record<string, LiteLLMModel>
      registryCache = data && typeof data === 'object' ? data : {}
    } catch {
      // Graceful degradation: unknown pricing beats a broken app.
      registryCache = {}
    } finally {
      registryAt = Date.now()
      clearTimeout(timer)
      registryInflight = null
    }
    return registryCache ?? {}
  })()
  return registryInflight
}

/** Longest anchored prefix overlap, mirroring LiteLLM's fuzz behavior
 * ("gpt-4-turbo-2024-04-09" falls back to "gpt-4-turbo"). */
function bestMatch(modelId: string, provider: 'openai' | 'anthropic', registry: Record<string, LiteLLMModel>): LiteLLMModel | undefined {
  const exact = registry[modelId]
  if (exact) return exact
  let bestKey = ''
  for (const [key, entry] of Object.entries(registry)) {
    const overlaps = key.startsWith(`${modelId}-`) || modelId.startsWith(`${key}-`)
    if (!overlaps) continue
    if (entry.litellm_provider && entry.litellm_provider !== provider) continue
    if (key.length > bestKey.length) bestKey = key
  }
  return bestKey ? registry[bestKey] : undefined
}

/** Resolve unit prices from the live sources. OpenRouter pricing is already
 * on the entry (parsed from its list); natives come from the LiteLLM
 * registry. */
export async function unitPricesForModel(model: ModelCatalogEntry | undefined, providerId: string): Promise<UnitPrices | null> {
  if (model?.pricing) return model.pricing
  const provider = providerId === 'openai' ? 'openai' : providerId === 'anthropic' ? 'anthropic' : undefined
  if (!provider || !model) return null
  const registry = await loadRegistry()
  const entry = bestMatch(model.id, provider, registry)
  if (!entry || entry.input_cost_per_token == null || entry.output_cost_per_token == null) return null
  return { prompt: entry.input_cost_per_token, completion: entry.output_cost_per_token }
}

/** Enrich model list entries in place from the LiteLLM registry (native
 * providers only) so native costs appear without any hardcoded table. */
export async function enrichWithLiteLLMPricing(models: ModelCatalogEntry[], providerId: string): Promise<void> {
  const provider = providerId === 'openai' ? 'openai' : providerId === 'anthropic' ? 'anthropic' : undefined
  if (!provider) return
  const registry = await loadRegistry()
  for (const model of models) {
    if (model.pricing) continue
    const entry = bestMatch(model.id, provider, registry)
    if (!entry) continue
    if (entry.input_cost_per_token != null && entry.output_cost_per_token != null) {
      model.pricing = { prompt: entry.input_cost_per_token, completion: entry.output_cost_per_token }
    }
    if (model.context == null) {
      const maxInput = entry.max_input_tokens ?? entry.max_tokens
      if (typeof maxInput === 'number' && Number.isFinite(maxInput)) model.context = maxInput
    }
  }
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