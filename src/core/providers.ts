// Wire-format layer: builds requests and parses responses THROUGH the
// vendored Auditomatic provider configs (see provider-config.ts). Nothing
// about a provider's URL, auth, headers, parameter rules, extraction paths,
// or structured-output support is hardcoded here — it is interpreted. The
// only code in this file is the two family adapters (openai-compat, anthropic)
// and the request/response mechanics shared by both.

import type { ContentPart, ModelCatalogEntry, OutputContractContext, ProviderRuntime, RunSpec } from './types'
import {
  getAllProviders,
  keyOptionalForList,
  matchingRule,
  outputLengthParamName,
  systemPromptConfigFor,
} from './provider-config'
import type { ResolvedProviderConfig, ResponseTransformConfig } from './provider-config'

export interface ChatRequest {
  url: string
  headers: Record<string, string>
  body: unknown
}

export interface ProviderPreset {
  id: string
  label: string
  provider: ResolvedProviderConfig
  keyLabel: string
  keyEnvVar: string | null
  keyOptionalForList: boolean
  customBase?: boolean
}

const CUSTOM_RULES = [
  {
    pattern: '.*',
    name: 'Any model',
    params: {
      temperature: { type: 'number' as const, min: 0, max: 2, default: 0.7, basic: true },
      max_tokens: { type: 'integer' as const, min: 1, default: 1024, is_output_length: true, basic: true },
      top_p: { type: 'number' as const, min: 0, max: 1, basic: true },
    },
  },
]

export const CUSTOM_PROVIDER: ResolvedProviderConfig = {
  id: 'custom',
  name: 'Custom OpenAI-compatible endpoint',
  group: 'custom',
  type: 'api',
  api: { baseUrl: '', endpoint: '/v1/chat/completions' },
  modelListEndpoint: '/v1/models',
  auth: { type: 'bearer', envVar: 'CUSTOM_API_KEY' },
  headers: { 'Content-Type': 'application/json' },
  bodyConstruction: { promptField: 'messages', wrapAsArray: true, messageRole: 'user' },
  systemPromptConfig: { mode: 'message', role: 'system' },
  modelRules: CUSTOM_RULES,
  family: 'openai-compat',
}

export const PRESETS: ProviderPreset[] = [
  ...getAllProviders().map(provider => ({
    id: provider.id,
    label: provider.name,
    provider,
    keyLabel: provider.auth.envVar ? `${provider.auth.envVar} API key` : 'API key',
    keyEnvVar: provider.auth.type === 'none' ? null : (provider.auth.envVar ?? null),
    keyOptionalForList: keyOptionalForList(provider.group),
  })),
  {
    id: 'custom',
    label: CUSTOM_PROVIDER.name,
    provider: CUSTOM_PROVIDER,
    keyLabel: 'API key (optional for local servers)',
    keyEnvVar: 'CUSTOM_API_KEY',
    keyOptionalForList: true,
    customBase: true,
  },
]

export function presetById(id: string): ProviderPreset {
  return PRESETS.find(p => p.id === id) ?? PRESETS[PRESETS.length - 1]!
}

export function modelListRequest(preset: ProviderPreset, baseUrl: string, apiKey: string): ChatRequest {
  const provider = { ...preset.provider, api: { ...preset.provider.api, baseUrl } }
  const headers = buildHeaders(provider, apiKey)
  return { url: `${baseUrl}${preset.provider.modelListEndpoint}`, headers, body: undefined }
}

function buildHeaders(provider: ProviderRuntime, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...provider.headers }
  if (provider.auth.type !== 'none' && apiKey) {
    if (provider.auth.type === 'bearer') headers.Authorization = `Bearer ${apiKey}`
    else if (provider.auth.header) headers[provider.auth.header] = apiKey
  }
  return headers
}

// --- parameter resolution ---------------------------------------------------

/** The API parameter names our three shared knobs map to for this model,
 * gated by the live supported_parameters (OpenRouter) or the maintained
 * model rules. Unsupported parameters are omitted silently — that is the
 * whole "omit unsupported params" feature; there is no user-facing concept. */
export function resolvedParams(spec: RunSpec): Record<string, unknown> {
  const { temperature, topP, maxTokens } = spec.params
  const supported = spec.supportedParams
  const rule = supported ? undefined : matchingRule(spec.provider, spec.model)
  const allows = (name: string): boolean =>
    supported ? supported.includes(name) : rule ? name in rule.params : true

  const out: Record<string, unknown> = {}
  if (temperature !== undefined && allows('temperature')) out.temperature = temperature
  if (topP !== undefined && allows('top_p')) out.top_p = topP
  if (maxTokens !== undefined) {
    let name: string | null = null
    if (supported) {
      if (supported.includes('max_tokens')) name = 'max_tokens'
      else if (supported.includes('max_completion_tokens')) name = 'max_completion_tokens'
    } else {
      name = outputLengthParamName(spec.provider, spec.model)
    }
    if (name) out[name] = maxTokens
  }
  return { ...out, ...(spec.extraParams ?? {}) }
}

/** Wire parameters for a resolved output contract, built from the maintained
 * structuredOutput config with the schema/name placeholders substituted.
 * No-op when the model (or the maintained rules) cannot express it. */
export function buildContractParams(
  provider: ProviderRuntime,
  modelId: string,
  contract: OutputContractContext | null,
  strictJson: boolean,
): Record<string, unknown> {
  if (!contract || !provider.structuredOutput) return {}
  const rule = matchingRule(provider, modelId)
  if (!rule || !(provider.structuredOutput.requiresParameter in rule.params)) return {}

  const modeKey = strictJson && provider.structuredOutput.modes.json_schema ? 'json_schema' : 'json_object'
  const mode = provider.structuredOutput.modes[modeKey]
  if (!mode || (mode.requiresSchema && !contract)) return {}

  const substitute = (value: unknown): unknown => {
    if (value === '{{SCHEMA}}') return contract.schema
    if (value === '{{SCHEMA_NAME}}') return contract.name
    if (Array.isArray(value)) return value.map(substitute)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) out[key] = substitute(child)
      return out
    }
    return value
  }

  const flat: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(mode.parameters ?? {})) flat[key] = substitute(value)
  return flat
}

// --- body construction (mirrors their buildBodyFromContract) ----------------

type JsonRecord = Record<string, unknown>

function setNested(target: JsonRecord, path: string, value: unknown): void {
  const parts = path.split('.')
  let current = target
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!
    const existing = current[part]
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      current[part] = {}
    }
    current = current[part] as JsonRecord
  }
  current[parts[parts.length - 1]!] = value
}

function unflatten(flat: Record<string, unknown>): JsonRecord {
  const result: JsonRecord = {}
  for (const [key, value] of Object.entries(flat)) {
    if (key.includes('.')) setNested(result, key, value)
    else result[key] = value
  }
  return result
}

function cleanParams(params: JsonRecord): JsonRecord {
  const cleaned: JsonRecord = {}
  for (const [key, value] of Object.entries(params)) {
    if (key.startsWith('_')) continue
    if (value === null || value === undefined || value === '') continue
    if (typeof value === 'object' && !Array.isArray(value)) {
      const nested = cleanParams(value as JsonRecord)
      if (Object.keys(nested).length > 0) cleaned[key] = nested
    } else {
      cleaned[key] = value
    }
  }
  return cleaned
}

/** Mirrors their applyEnablesFeaturesTransforms: a generic feature flag like
 * `logprobs: true` is rewritten into the model rule's carrier parameter
 * (boolean_value) or carrier array (array_value), and the generic flag is
 * never sent on the wire. */
function applyEnablesFeaturesTransforms(
  params: JsonRecord,
  provider: ProviderRuntime,
  modelId: string,
): JsonRecord {
  const rule = matchingRule(provider, modelId)
  if (!rule) return params
  const result: JsonRecord = { ...params }

  for (const [paramName, paramDef] of Object.entries(rule.params)) {
    const features = paramDef.enables_features
    if (!features) continue
    for (const [featureName, featureConfig] of Object.entries(features)) {
      const arrayValue = featureConfig.array_value
      const booleanValue = featureConfig.boolean_value
      if (!Object.prototype.hasOwnProperty.call(result, featureName)) continue
      if (result[featureName] !== true) {
        delete result[featureName]
        continue
      }
      if (arrayValue !== undefined) {
        const carrier = (result[paramName] as unknown[]) ?? []
        if (!carrier.includes(arrayValue as string)) carrier.push(arrayValue as string)
        result[paramName] = carrier
      } else if (booleanValue !== undefined) {
        result[paramName] = booleanValue
      }
      delete result[featureName]
    }
  }
  return result
}

function applyTransforms(body: JsonRecord, transforms: ResolvedProviderConfig['bodyTransforms']): JsonRecord {
  let result = body
  for (const transform of transforms ?? []) {
    const config = (transform.config ?? {}) as JsonRecord
    if (transform.type === 'field_transform') {
      const field = String(config.field ?? '')
      const value = result[field]
      if (config.transform === 'string_to_object' && typeof value === 'string') {
        const wrapper = String((config.transformConfig as JsonRecord | undefined)?.objectWrapper ?? '')
        result = { ...result, [field]: { [wrapper]: value } }
      }
    } else if (transform.type === 'field_rename') {
      const from = String(config.from ?? '')
      const to = String(config.to ?? '')
      if (from in result) {
        const { [from]: value, ...rest } = result
        result = { ...rest, [to]: value }
      }
    }
    // validation_rule / conditional_transform are pre-flight checks and
    // rewrites the maintained configs do not use for the supported presets;
    // ignored here deliberately (comment kept so the omission is visible).
  }
  return result
}

function modelNameFor(provider: ProviderRuntime, modelId: string): string {
  return modelId.startsWith(`${provider.id}:`) ? modelId.slice(provider.id.length + 1) : modelId
}

/** The wire body for one call. prompt/system are inserted as-is — callers
 * pass the rendered prompt, or the {{PROMPT}}/{{SYSTEM_PROMPT}} sentinels
 * when generating a Python reproduction. */
export function buildChatRequestBody(
  provider: ProviderRuntime,
  modelId: string,
  params: Record<string, unknown>,
  prompt: string,
  system: string,
  opts: { stream: boolean; zdr: boolean } = { stream: false, zdr: false },
): JsonRecord {
  const construction = provider.bodyConstruction
  const systemConfig = systemPromptConfigFor(provider, modelId)
  const modelName = modelNameFor(provider, modelId)
  const body: JsonRecord = { model: modelName }

  const clean = applyEnablesFeaturesTransforms(cleanParams(unflatten(params)), provider, modelName)

  if (construction?.promptField) {
    if (construction.wrapAsArray) {
      const messages: JsonRecord[] = []
      if (system && systemConfig.mode === 'message') {
        const systemMessage: JsonRecord = { role: systemConfig.role ?? 'system' }
        if (systemConfig.contentWrapper) {
          systemMessage.content = [{ type: systemConfig.contentWrapper.type, [systemConfig.contentWrapper.textField]: system }]
        } else {
          systemMessage.content = system
        }
        messages.push(systemMessage)
      }
      const userMessage: JsonRecord = { role: construction.messageRole ?? 'user' }
      let userContent = prompt
      if (system && systemConfig.mode === 'prepend') {
        userContent = `${system}${systemConfig.separator ?? '\n\n'}${prompt}`
      }
      if (systemConfig.contentWrapper && systemConfig.mode === 'message') {
        userMessage.content = [{ type: systemConfig.contentWrapper.type, [systemConfig.contentWrapper.textField]: userContent }]
      } else {
        userMessage.content = userContent
      }
      messages.push(userMessage)
      body[systemConfig.targetField ?? construction.promptField] = messages
    } else {
      let finalPrompt = prompt
      if (system && systemConfig.mode === 'prepend') {
        finalPrompt = `${system}${systemConfig.separator ?? '\n\n'}${prompt}`
      }
      body[construction.promptField] = finalPrompt
    }
  }

  if (system && systemConfig.mode === 'field' && systemConfig.fieldName) {
    body[systemConfig.fieldName] = system
  }

  if (construction?.paramNesting) {
    const rootLevel = new Set(construction.paramNesting.excludeFromNesting ?? [])
    const root: JsonRecord = {}
    const nested: JsonRecord = {}
    for (const [key, value] of Object.entries(clean)) {
      if (rootLevel.has(key)) root[key] = value
      else nested[key] = value
    }
    if (Object.keys(nested).length > 0) body[construction.paramNesting.container] = nested
    Object.assign(body, root)
  } else {
    Object.assign(body, clean)
  }

  if (opts.stream) {
    body.stream = true
    if (provider.family === 'openai-compat') body.stream_options = { include_usage: true }
  }
  if (opts.zdr && provider.group === 'openrouter') {
    body.provider = { zdr: true }
  }

  return Object.fromEntries(
    Object.entries(applyTransforms(body, provider.bodyTransforms)).filter(([key]) => !key.startsWith('_')),
  )
}

export function buildChatRequest(spec: RunSpec, opts: { stream?: boolean } = {}): ChatRequest {
  const provider = spec.provider
  const headers = buildHeaders(provider, spec.apiKey)
  const body = buildChatRequestBody(provider, spec.model, resolvedParams(spec), spec.prompt, spec.system, {
    stream: opts.stream ?? spec.stream,
    zdr: spec.zdr,
  })
  return { url: `${provider.api.baseUrl}${provider.api.endpoint}`, headers, body }
}

// --- response parsing -------------------------------------------------------

const FILTER_PATH = /^(.+?)\[\?\(@\.(.+?)==(?:'|")(.+?)(?:'|")\)\]\.(.+)$/

export function getValueAtPath(obj: unknown, path: string): unknown {
  if ((typeof obj !== 'object' || obj === null) || !path) return undefined
  try {
    const filtered = FILTER_PATH.exec(path)
    if (filtered) {
      const [, arrayPath, field, value, rest] = filtered
      const array = getValueAtPath(obj, arrayPath!)
      if (!Array.isArray(array)) return undefined
      const match = array.find(i => typeof i === 'object' && i !== null && (i as JsonRecord)[field!] === value)
      return match !== undefined ? getValueAtPath(match, rest!) : undefined
    }
    let current: unknown = obj
    for (const part of path.split(/[.[\]]/).filter(Boolean)) {
      if (current === null || current === undefined) return undefined
      if (/^\d+$/.test(part)) {
        const index = Number(part)
        if (!Array.isArray(current) || index >= current.length) return undefined
        current = current[index]
      } else {
        if (typeof current !== 'object') return undefined
        current = (current as JsonRecord)[part]
      }
    }
    return current
  } catch {
    return undefined
  }
}

function firstMatch(data: unknown, paths: string[] | undefined): string | null {
  for (const path of paths ?? []) {
    const value = getValueAtPath(data, path)
    if (value === null || value === undefined) continue
    if (Array.isArray(value)) {
      const joined = value.filter(v => v).map(String).join(' ')
      if (joined) return joined
      continue
    }
    if (value !== '') return String(value)
  }
  return null
}

export function extractAnswer(
  transform: ResponseTransformConfig | undefined,
  json: unknown,
): { text: string | null; reasoning?: string; images?: Array<{ url?: string; dataUrl?: string }> } {
  const text = firstMatch(json, [transform?.contentPath ?? '', ...(transform?.fallbackPaths ?? [])])
  const reasoning = firstMatch(json, [transform?.reasoningPath ?? '', ...(transform?.reasoningFallbackPaths ?? [])]) ?? undefined
  let images: Array<{ url?: string; dataUrl?: string }> | undefined
  const imagesRaw = firstMatch(json, [transform?.imagesPath ?? '', ...(transform?.imagesFallbackPaths ?? [])])
  if (imagesRaw) {
    try {
      const parsed = JSON.parse(imagesRaw)
      if (Array.isArray(parsed)) {
        images = parsed
          .map((image: JsonRecord) => ({ url: typeof image.url === 'string' ? image.url : undefined, dataUrl: typeof image.data_url === 'string' ? image.data_url : typeof image.b64_json === 'string' ? `data:image/png;base64,${image.b64_json}` : undefined }))
          .filter(i => i.url || i.dataUrl)
      }
    } catch {
      // non-JSON images path: leave undefined
    }
  }
  return { text, reasoning, images }
}

/** Neutral content parts from a response body (text/images/tool calls). */
export function contentParts(family: 'openai-compat' | 'anthropic', json: unknown): ContentPart[] {
  const record = (json ?? {}) as JsonRecord
  if (family === 'anthropic') {
    const blocks = Array.isArray(record.content) ? record.content as JsonRecord[] : []
    const parts: ContentPart[] = []
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') parts.push({ kind: 'text', text: block.text })
      else if (block.type === 'image') {
        const source = (block.source ?? {}) as JsonRecord
        if (typeof source.data === 'string' && typeof source.media_type === 'string') {
          parts.push({ kind: 'image', dataUrl: `data:${source.media_type};base64,${source.data}` })
        } else if (typeof source.url === 'string') {
          parts.push({ kind: 'image', url: source.url })
        }
      } else if (block.type === 'tool_use') {
        parts.push({ kind: 'toolCall', name: String(block.name ?? ''), args: block.input })
      }
    }
    return parts
  }
  const choice = Array.isArray(record.choices) ? record.choices[0] as JsonRecord | undefined : undefined
  const message = choice?.message as JsonRecord | undefined
  const content = message?.content
  const parts: ContentPart[] = []
  if (typeof content === 'string') {
    if (content) parts.push({ kind: 'text', text: content })
  } else if (Array.isArray(content)) {
    for (const item of content as JsonRecord[]) {
      if (item.type === 'text' && typeof item.text === 'string') parts.push({ kind: 'text', text: item.text })
      else if (item.type === 'image_url') {
        const url = (item.image_url as JsonRecord | undefined)?.url
        if (typeof url === 'string') parts.push({ kind: 'image', url })
      }
    }
  }
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls as JsonRecord[] : []
  for (const call of toolCalls) {
    const fn = (call.function ?? {}) as JsonRecord
    let args: unknown = fn.arguments
    if (typeof args === 'string') {
      try { args = JSON.parse(args) } catch { /* keep raw string */ }
    }
    parts.push({ kind: 'toolCall', name: String(fn.name ?? ''), args })
  }
  return parts
}

export function parseUsage(provider: ProviderRuntime, json: unknown): {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  costUsd?: number
} {
  const usage = provider.usageExtraction
  if (!usage) return {}
  const prompt = getValueAtPath(json, usage.promptTokensPath ?? '')
  const completion = getValueAtPath(json, usage.completionTokensPath ?? '')
  const total = getValueAtPath(json, usage.totalTokensPath ?? '')
  const cost = usage.costPath ? getValueAtPath(json, usage.costPath) : undefined
  return {
    ...(typeof prompt === 'number' ? { promptTokens: prompt } : {}),
    ...(typeof completion === 'number' ? { completionTokens: completion } : {}),
    ...(typeof total === 'number' ? { totalTokens: total } : {}),
    ...(typeof cost === 'number' && Number.isFinite(cost) ? { costUsd: cost } : {}),
  }
}

export function parseChatError(status: number, json: unknown, transform?: ResponseTransformConfig): string {
  if (transform?.errorPath) {
    const detail = getValueAtPath(json, transform.errorPath)
    if (detail) return status ? `HTTP ${status} — ${String(detail)}` : String(detail)
  }
  const error = (json as JsonRecord | null | undefined)?.error
  if (typeof error === 'string') return status ? `HTTP ${status} — ${error}` : error
  if (error && typeof error === 'object') {
    const message = (error as JsonRecord).message
    if (message) return status ? `HTTP ${status} — ${String(message)}` : String(message)
  }
  return status ? `HTTP ${status}` : 'Request failed'
}

// --- streaming ---------------------------------------------------------------

/** One SSE payload's worth of progress, per family. */
export function streamDelta(
  family: 'openai-compat' | 'anthropic',
  json: unknown,
): { text?: string; thinking?: string; usage?: Record<string, number> } {
  const record = (json ?? {}) as JsonRecord
  if (family === 'anthropic') {
    if (record.type === 'content_block_delta') {
      const delta = (record.delta ?? {}) as JsonRecord
      if (delta.type === 'text_delta' && typeof delta.text === 'string') return { text: delta.text }
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') return { thinking: delta.thinking }
      return {}
    }
    if (record.type === 'message_delta' || record.type === 'message_start') {
      const usage = record.usage as Record<string, number> | undefined
      return usage ? { usage } : {}
    }
    if (record.type === 'error') {
      const error = (record.error ?? {}) as JsonRecord
      return { thinking: undefined, text: `ERROR: ${String(error.message ?? 'unknown stream error')}` }
    }
    return {}
  }
  const choice = Array.isArray(record.choices) ? record.choices[0] as JsonRecord | undefined : undefined
  const delta = (choice?.delta ?? {}) as JsonRecord
  const out: { text?: string; thinking?: string; usage?: Record<string, number> } = {}
  if (typeof delta.content === 'string') out.text = delta.content
  if (typeof delta.reasoning_content === 'string') out.thinking = delta.reasoning_content
  else if (typeof delta.reasoning === 'string') out.thinking = delta.reasoning
  const usage = record.usage as Record<string, number> | undefined
  if (usage && Object.keys(usage).length > 0) out.usage = usage
  return out
}

// --- live model catalogs -----------------------------------------------------

const NON_CHAT = /(embed|whisper|tts|moderati|dall|image|realtime|transcri|rerank|davinci|babbage)/i

export function parseModelList(json: unknown): ModelCatalogEntry[] {
  const rows = Array.isArray((json as JsonRecord | null | undefined)?.data) ? (json as JsonRecord).data as unknown[] : []
  const seen = new Set<string>()
  const out: ModelCatalogEntry[] = []
  for (const item of rows) {
    const rec = item as JsonRecord
    const id = String(rec?.id ?? '').trim()
    if (!id || seen.has(id) || NON_CHAT.test(id)) continue
    seen.add(id)
    const promptPrice = Number((rec.pricing as JsonRecord | undefined)?.prompt)
    const completionPrice = Number((rec.pricing as JsonRecord | undefined)?.completion)
    const supportedParams = Array.isArray(rec.supported_parameters)
      ? (rec.supported_parameters as unknown[]).map(String)
      : undefined
    const context = typeof rec.context_length === 'number' ? rec.context_length : undefined
    out.push({
      id,
      name: typeof rec.name === 'string' && rec.name !== id ? rec.name : undefined,
      context,
      ...(Number.isFinite(promptPrice) && Number.isFinite(completionPrice) && promptPrice >= 0 && completionPrice >= 0
        ? { pricing: { prompt: promptPrice, completion: completionPrice } }
        : {}),
      ...(supportedParams?.length ? { supportedParams } : {}),
    })
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

/** ZDR-capable model ids from OpenRouter's /api/v1/endpoints/zdr. */
export function parseZdrModels(json: unknown): Set<string> {
  const rows = Array.isArray((json as JsonRecord | null | undefined)?.data) ? (json as JsonRecord).data as unknown[] : []
  const ids = new Set<string>()
  for (const item of rows) {
    const id = String((item as JsonRecord)?.model_id ?? '').trim()
    if (id) ids.add(id)
  }
  return ids
}

// --- curated quick-add seeds -------------------------------------------------

// Convenience seeds for first use. The authoritative list always comes back
// live from GET /v1/models; manual add-by-ID covers anything missing here.
export const QUICK_MODELS: Record<string, Array<{ id: string }>> = {
  openrouter: [
    { id: 'openai/gpt-4o-mini' },
    { id: 'anthropic/claude-3.5-sonnet' },
    { id: 'google/gemini-2.0-flash' },
    { id: 'meta-llama/llama-3.3-70b-instruct' },
    { id: 'deepseek/deepseek-r1' },
    { id: 'mistralai/mistral-7b-instruct:free' },
    { id: 'meta-llama/llama-3.2-3b-instruct:free' },
  ],
  openai: [
    { id: 'gpt-4o-mini' },
    { id: 'gpt-4o' },
    { id: 'gpt-4.1-mini' },
    { id: 'gpt-4.1-nano' },
    { id: 'o3-mini' },
  ],
  anthropic: [
    { id: 'claude-sonnet-4-20250514' },
    { id: 'claude-haiku-4-5-20251001' },
    { id: 'claude-opus-4-20250514' },
  ],
}