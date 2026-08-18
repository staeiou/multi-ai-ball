// Shared model types for MultAIBall. No imports; stays the single source of
// truth for the wire-level shapes the app moves around.

export type ProviderFamily = 'openai-compat' | 'anthropic'

export type PresetId = 'openrouter' | 'openai' | 'anthropic' | 'custom'

export interface ProviderSpec {
  id: PresetId
  label: string
  family: ProviderFamily
  /** Normalized: no trailing slash, no `/v1` suffix. */
  baseUrl: string
  keyLabel: string
  /** True when the model-list endpoint works without a key (OpenRouter, local endpoints). */
  keyOptionalForList: boolean
}

/** Shared sampling parameters, applied to every selected model. Unsupported
 * parameters are omitted per model at request build time — never shown to the
 * user (e.g. reasoning models simply don't get temperature). */
export interface ParamOverrides {
  temperature?: number
  maxTokens?: number
  topP?: number
}

export interface SelectedModel {
  id: string
  name?: string
}

export interface ModelInfo {
  id: string
  name?: string
  /** Context window in tokens, when the source reports it. */
  context?: number
  /** USD per token, from the source that reports it (OpenRouter list, LiteLLM). */
  pricing?: { prompt: number; completion: number }
  /** OpenRouter reports the exact parameter set each model accepts. */
  supportedParams?: string[]
}

export interface RunSpec {
  provider: ProviderSpec
  apiKey: string
  model: string
  /** Per-model accepted parameter names (OpenRouter list). Absent = assume all. */
  supportedParams?: string[]
  params: ParamOverrides
  prompt: string
  system: string
  stream: boolean
  /** OpenRouter only: zero-data-retention routing (`provider.zdr`). */
  zdr: boolean
}

export type RowStatus = 'pending' | 'ok' | 'error'

export interface RowResult {
  model: string
  status: RowStatus
  latencyMs?: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  text?: string
  thinking?: string
  rawJson?: string
  error?: string
  estimatedCostUsd?: number
  costUsd?: number
}

/** Streamed progress snapshot pushed to the grid while a call is running. */
export interface RowProgress {
  model: string
  text: string
  thinking: string
}