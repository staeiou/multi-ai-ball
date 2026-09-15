// Guidance: what sources say ONE model accepts. It starts values and
// annotates the review screen. It never removes a control and never stops a
// request; the provider's response is the final word. Each provider is its
// own authority (FULL-CONTEXT-20260913.md §7):
//
//   OpenRouter  its live catalog, for its own models, and nothing else: an
//               OpenRouter model is OpenRouter's, whatever its id says
//   Anthropic   its live /v1/models capability tree; models.dev for temperature
//               (the tree has no sampling leaf) and price
//   OpenAI      models.dev (the vendor list carries ids only)
//   custom      assumed: temperature and max_tokens are sent, nothing else
//
// Above all of them: exceptions.json, hand-written, empty at launch.

import modelsDev from '../../data/models-dev.json'
import exceptions from './exceptions.json'
import type { CatalogModel, Fact, FactSource, ModelGuidance, ProviderId, Tri } from '../types'

type JsonRecord = Record<string, unknown>

interface ModelsDevModel {
  name?: string
  temperature: boolean | null
  reasoning: boolean | null
  reasoning_options: Array<{ type: string; values?: string[]; min?: number }>
  structured_output: boolean | null
  limit: { context: number | null; output: number | null }
  cost: { input: number | null; output: number | null } | null
}

const MODELS_DEV = modelsDev as { fetchedAt: string; providers: Record<string, Record<string, ModelsDevModel>> }

interface ExceptionEntry {
  provider: ProviderId
  models: string[]
  guidance: Partial<{
    temperature: Tri
    effortValues: string[] | null
    structuredOutput: Tri
    contextLimit: number | null
    outputLimit: number | null
  }>
  note: string
  expiresWhen: string
}

const EXCEPTIONS = (exceptions as { entries: ExceptionEntry[] }).entries

const fact = <T>(value: T, source: FactSource): Fact<T> => ({ value, source })

export function unknownGuidance(): ModelGuidance {
  return {
    temperature: fact<Tri>('unknown', 'unknown'),
    effortValues: fact<string[] | null>(null, 'unknown'),
    structuredOutput: fact<Tri>('unknown', 'unknown'),
    contextLimit: fact<number | null>(null, 'unknown'),
    outputLimit: fact<number | null>(null, 'unknown'),
    pricing: fact<{ prompt: number; completion: number } | null>(null, 'unknown'),
  }
}

/** A custom endpoint: every OpenAI-compatible server takes these two. */
export function assumedGuidance(): ModelGuidance {
  const g = unknownGuidance()
  g.temperature = fact<Tri>(true, 'assumed')
  return g
}

// --- models.dev ---------------------------------------------------------------

export const MODELS_DEV_FETCHED_AT = MODELS_DEV.fetchedAt

/** Exact id first; then the same id without a trailing -YYYY-MM-DD snapshot
 * suffix (OpenAI lists dated snapshots; models.dev lists the base); then, for
 * Anthropic ids arriving through OpenRouter, dots as dashes. */
export function modelsDevRecord(vendor: 'openai' | 'anthropic', id: string): ModelsDevModel | undefined {
  const table = MODELS_DEV.providers[vendor] ?? {}
  if (table[id]) return table[id]
  const stripped = id.replace(/-\d{4}-\d{2}-\d{2}$/, '')
  if (table[stripped]) return table[stripped]
  const dashed = id.replace(/\./g, '-')
  if (table[dashed]) return table[dashed]
  return undefined
}

function effortFromModelsDev(record: ModelsDevModel): string[] | null {
  const effort = record.reasoning_options.find(o => o.type === 'effort' && Array.isArray(o.values))
  return effort?.values?.length ? effort.values : null
}

function pricingFromModelsDev(record: ModelsDevModel): { prompt: number; completion: number } | null {
  if (!record.cost || record.cost.input == null || record.cost.output == null) return null
  // models.dev prices are USD per million tokens; the app uses USD per token.
  return { prompt: record.cost.input / 1e6, completion: record.cost.output / 1e6 }
}

export function guidanceFromModelsDev(vendor: 'openai' | 'anthropic', id: string): ModelGuidance {
  const record = modelsDevRecord(vendor, id)
  if (!record) return unknownGuidance()
  return {
    temperature: fact<Tri>(record.temperature ?? 'unknown', record.temperature == null ? 'unknown' : 'models-dev'),
    effortValues: fact(effortFromModelsDev(record), 'models-dev'),
    structuredOutput: fact<Tri>(record.structured_output ?? 'unknown', record.structured_output == null ? 'unknown' : 'models-dev'),
    contextLimit: fact(record.limit.context, record.limit.context == null ? 'unknown' : 'models-dev'),
    outputLimit: fact(record.limit.output, record.limit.output == null ? 'unknown' : 'models-dev'),
    pricing: fact(pricingFromModelsDev(record), record.cost ? 'models-dev' : 'unknown'),
  }
}

// --- OpenRouter's live catalog ------------------------------------------------

const OPENROUTER_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** One OpenRouter catalog entry -> a model row with guidance from that entry. */
export function catalogModelFromOpenRouter(entry: JsonRecord): CatalogModel | null {
  const id = String(entry.id ?? '').trim()
  if (!id) return null
  const supported = Array.isArray(entry.supported_parameters) ? (entry.supported_parameters as unknown[]).map(String) : []
  const reasoning = (entry.reasoning ?? null) as JsonRecord | null
  const top = (entry.top_provider ?? {}) as JsonRecord
  const pricing = (entry.pricing ?? {}) as JsonRecord
  const prompt = Number(pricing.prompt)
  const completion = Number(pricing.completion)

  let effortValues: string[] | null = null
  if (Array.isArray(reasoning?.supported_efforts) && reasoning!.supported_efforts.length) {
    effortValues = (reasoning!.supported_efforts as unknown[]).map(String)
      .sort((a, b) => OPENROUTER_EFFORTS.indexOf(a) - OPENROUTER_EFFORTS.indexOf(b))
  } else if (supported.includes('reasoning') || supported.includes('reasoning_effort')) {
    effortValues = ['low', 'medium', 'high']
  }

  // OpenRouter's catalog is the only authority for OpenRouter's models. If the
  // union lists temperature and a sub-provider refuses it, the 400 is the data
  // (the owner's rule; alfresh reads the vendor's record here and this app does not).
  const temperature = fact<Tri>(supported.includes('temperature'), 'openrouter-live')

  const outputLengthName = supported.includes('max_tokens')
    ? 'max_tokens'
    : supported.includes('max_completion_tokens') ? 'max_completion_tokens' : 'max_tokens'

  return {
    id,
    name: typeof entry.name === 'string' && entry.name !== id ? entry.name : undefined,
    free: /:free(?:$|[-:])/i.test(id),
    guidance: {
      temperature,
      effortValues: fact(effortValues, 'openrouter-live'),
      structuredOutput: fact<Tri>(supported.includes('structured_outputs') || supported.includes('response_format'), 'openrouter-live'),
      contextLimit: fact(typeof top.context_length === 'number' ? top.context_length : typeof entry.context_length === 'number' ? entry.context_length : null, 'openrouter-live'),
      outputLimit: fact(typeof top.max_completion_tokens === 'number' ? top.max_completion_tokens : null, 'openrouter-live'),
      pricing: fact(Number.isFinite(prompt) && Number.isFinite(completion) && prompt >= 0 && completion >= 0 ? { prompt, completion } : null, 'openrouter-live'),
      outputLengthName,
    },
  }
}

/** Rows OpenRouter serves that a chat run cannot use. */
export function openRouterHidden(id: string): boolean {
  return /:batch(?:$|[-:])/i.test(id) || id.startsWith('openrouter/')
}

// --- Anthropic's live catalog -------------------------------------------------

const ANTHROPIC_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

export function catalogModelFromAnthropic(entry: JsonRecord): CatalogModel | null {
  const id = String(entry.id ?? '').trim()
  if (!id) return null
  const caps = (entry.capabilities ?? {}) as JsonRecord
  const effort = (caps.effort ?? {}) as JsonRecord
  const supportedLevel = (level: string): boolean => Boolean(((effort[level] ?? {}) as JsonRecord).supported)
  const effortValues = ((effort.supported as boolean | undefined) ?? false)
    ? ANTHROPIC_EFFORTS.filter(supportedLevel)
    : null
  const structured = (caps.structured_outputs ?? {}) as JsonRecord
  const fromModelsDev = guidanceFromModelsDev('anthropic', id)
  return {
    id,
    name: typeof entry.display_name === 'string' ? entry.display_name : undefined,
    guidance: {
      temperature: fromModelsDev.temperature,
      effortValues: fact(effortValues && effortValues.length ? effortValues : null, 'anthropic-live'),
      structuredOutput: fact<Tri>(typeof structured.supported === 'boolean' ? structured.supported : 'unknown', 'anthropic-live'),
      contextLimit: fact(typeof entry.max_input_tokens === 'number' ? entry.max_input_tokens : fromModelsDev.contextLimit.value, typeof entry.max_input_tokens === 'number' ? 'anthropic-live' : fromModelsDev.contextLimit.source),
      outputLimit: fact(typeof entry.max_tokens === 'number' ? entry.max_tokens : fromModelsDev.outputLimit.value, typeof entry.max_tokens === 'number' ? 'anthropic-live' : fromModelsDev.outputLimit.source),
      pricing: fromModelsDev.pricing,
    },
  }
}

// --- OpenAI's live list (ids only) --------------------------------------------

const OPENAI_NON_CHAT = /(embed|whisper|tts|moderati|dall|image|realtime|transcri|rerank|davinci|babbage|audio|search|codex|computer|sora|omni-moderation|instruct|deep-research|gpt-live|-pro(?:$|-)|chatgpt)/i

export function catalogModelFromOpenAI(entry: JsonRecord): CatalogModel | null {
  const id = String(entry.id ?? '').trim()
  if (!id || OPENAI_NON_CHAT.test(id)) return null
  return { id, guidance: guidanceFromModelsDev('openai', id) }
}

// --- custom -----------------------------------------------------------------

export function catalogModelFromCustom(entry: JsonRecord): CatalogModel | null {
  const id = String(entry.id ?? '').trim()
  if (!id) return null
  return { id, guidance: assumedGuidance() }
}

// --- exceptions overlay -----------------------------------------------------

export function applyExceptions(provider: ProviderId, model: CatalogModel): CatalogModel {
  const entry = EXCEPTIONS.find(e => e.provider === provider && e.models.includes(model.id))
  if (!entry) return model
  const g = { ...model.guidance }
  const o = entry.guidance
  if (o.temperature !== undefined) g.temperature = fact(o.temperature, 'override')
  if (o.effortValues !== undefined) g.effortValues = fact(o.effortValues, 'override')
  if (o.structuredOutput !== undefined) g.structuredOutput = fact(o.structuredOutput, 'override')
  if (o.contextLimit !== undefined) g.contextLimit = fact(o.contextLimit, 'override')
  if (o.outputLimit !== undefined) g.outputLimit = fact(o.outputLimit, 'override')
  return { ...model, guidance: g }
}

/** A model the user typed by id, absent from the loaded catalog. */
export function manualCatalogModel(provider: ProviderId, id: string): CatalogModel {
  let model: CatalogModel
  if (provider === 'openai') model = { id, guidance: guidanceFromModelsDev('openai', id) }
  else if (provider === 'anthropic') model = { id, guidance: guidanceFromModelsDev('anthropic', id) }
  else if (provider === 'custom') model = { id, guidance: assumedGuidance() }
  else model = { id, guidance: unknownGuidance() }
  return applyExceptions(provider, model)
}
