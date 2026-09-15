// Core shared types. No imports. Everything the app moves around derives from
// these; the FrozenRun is the object that carries the product's one promise
// (every call's body is exactly what the frozen run says, in the browser and
// in the Python bundle). See FULL-CONTEXT-20260913.md §5.

// --- providers ---------------------------------------------------------------

export type ProviderId = 'openai' | 'anthropic' | 'openrouter' | 'custom'

/** Wire protocol: how a body is built and a response read. Two exist. */
export type Shape = 'openai-chat' | 'anthropic-messages'

export interface ProviderPreset {
  id: ProviderId
  label: string
  shape: Shape
  /** Empty for custom (the user supplies it). No trailing slash. */
  baseUrl: string
  chatPath: string
  modelsPath: string
  auth: { kind: 'bearer' | 'header'; header?: string; envVar: string }
  headers: Record<string, string>
  /** The output-length role's spelling on this endpoint (OpenRouter may
   * override per model from its catalog). */
  outputLengthName: string
  /** Where the reasoning-effort role lives, as a key path; null = no such
   * control on this endpoint. */
  effortPath: string[] | null
  /** How a JSON-schema output request is spelled; null = not offered. */
  structuredOutput: 'response_format' | 'output_config' | null
  /** OpenRouter's routing block (`provider: {...}`) is understood. */
  routing: boolean
  /** The model list can be fetched without a key (OpenRouter, local). */
  keyOptionalForList: boolean
  /** A key is required to run at all. */
  keyRequired: boolean
}

// --- guidance (advice about one model; never a gate) --------------------------

export type FactSource =
  | 'openrouter-live'
  | 'anthropic-live'
  | 'models-dev'
  | 'override'
  | 'assumed'
  | 'user'
  | 'unknown'

export type Tri = true | false | 'unknown'

export interface Fact<T> {
  value: T
  source: FactSource
}

export interface ModelGuidance {
  temperature: Fact<Tri>
  /** Effort values the model is reported to accept; null = no effort control. */
  effortValues: Fact<string[] | null>
  structuredOutput: Fact<Tri>
  contextLimit: Fact<number | null>
  outputLimit: Fact<number | null>
  /** USD per token. */
  pricing: Fact<{ prompt: number; completion: number } | null>
  /** OpenRouter only: which output-length spelling this model lists. */
  outputLengthName?: string
}

export interface CatalogModel {
  id: string
  name?: string
  guidance: ModelGuidance
  /** OpenRouter: `:free` routes trade money for data use. */
  free?: boolean
}

// --- the user's shared parameter values ---------------------------------------

export type ResponseFormatChoice = 'auto' | 'schema' | 'json_object' | 'none'

export interface SharedParams {
  /** null = leave the endpoint's own default (never sent). */
  outputLength: number | null
  /** null = not set. Sent only where guidance says the model accepts it. */
  temperature: number | null
  /** null = not set. 'less' / 'more' map to each model's lowest / highest
   * listed level; an exact level is sent where the model lists it. */
  effort: string | null
  responseFormat: ResponseFormatChoice
}

export interface OpenRouterRouting {
  requireParameters: boolean
  zdr: boolean
  order?: string[]
  only?: string[]
  ignore?: string[]
  allowFallbacks?: boolean
}

export interface ModelSettings {
  /** Free-form keys merged last into the body. Never validated except that
   * structural keys are refused. */
  extras: Record<string, unknown>
  routing?: OpenRouterRouting
  /** Per-model override of the shared response-format choice. */
  responseFormat?: ResponseFormatChoice
}

/** One line of the review screen: what happened to one parameter for one model. */
export interface ParamReport {
  param: string
  sent: boolean
  value?: unknown
  reason: string
  source: FactSource
}

// --- output contract ----------------------------------------------------------

export type ContractFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'multi-enum'

export interface ContractField {
  name: string
  type: ContractFieldType
  min?: number
  max?: number
  values?: string[]
  description?: string
  valueNotes?: Record<string, string>
}

export interface ContractAuthoring {
  fields?: ContractField[]
  rationaleFirst?: boolean
  rationaleSpec?: string
  /** Demand bare JSON (no fences/commentary). Absent means on. */
  strictJson?: boolean
}

export interface OutputContract {
  fields: ContractField[]
}

export interface OutputContractContext {
  contract: OutputContract
  schema: Record<string, unknown>
  name: string
  columnCount: number
}

// --- dataset roles and partition ----------------------------------------------

export type ColumnRole = 'input' | 'reference' | 'output' | 'metadata'

export interface Partition {
  /** Source ordinals (0-based row index) in prompt order. */
  examples: number[]
  targets: number[]
  ambiguous: number[]
}

// --- the frozen run -----------------------------------------------------------

export interface FrozenModel {
  provider: ProviderId
  id: string
  url: string
  /** Key travels as {{API_KEY}}; the runner and the bundle substitute. */
  headers: Record<string, string>
  /** Body skeleton: every effective parameter already placed; `{{SYSTEM}}`
   * and `{{PROMPT}}` sentinels where the rendered channels go. */
  body: Record<string, unknown>
  report: ParamReport[]
  guidance: ModelGuidance
}

export interface FrozenRun {
  version: 1
  frozenAt: string
  source: { name: string; bytes: number; sha256: string; rowCount: number; sheet?: string } | null
  roles: Record<string, ColumnRole>
  partition: Partition
  /** Target rows only, referenced input columns only, values as prompt text. */
  cases: Array<{ ordinal: number; label: string; bindings: Record<string, string> }>
  systemTemplate: string
  itemTemplate: string
  /** Rendered once: worked examples + output-format prose. Appended to the
   * system channel of every call. */
  constantBlock: string
  constantBlockTokens: number
  contract: OutputContract | null
  parserId: string | null
  models: FrozenModel[]
  repeats: number
  concurrency: number
  retries: number
  timeoutMs: number
}

export interface Coordinate {
  caseIndex: number
  modelIndex: number
  repeat: number
}

// --- results -----------------------------------------------------------------

/** pending = waiting to be sent; running = in flight; ok / error = finished. */
export type RowStatus = 'pending' | 'running' | 'ok' | 'error'

export type ContentPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; dataUrl?: string; url?: string }
  | { kind: 'toolCall'; name: string; args: unknown }

export type ParseStatus = 'none' | 'strict' | 'repaired' | 'failed'

export interface CallRow {
  coord: Coordinate
  status: RowStatus
  httpStatus?: number
  latencyMs?: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  costUsd?: number
  estimatedCostUsd?: number
  parts: ContentPart[]
  thinking?: string
  parsed: ParsedValue
  parseStatus: ParseStatus
  /** The raw response text: the fidelity anchor; never re-serialized. */
  raw?: string
  /** SHA-256 of the exact body string handed to fetch. */
  bodyHash?: string
  /** OpenRouter reports which sub-provider served the call. Evidence only. */
  upstream?: string
  error?: string
}

// --- built-in parsers --------------------------------------------------------

export type ParserKind = 'regex' | 'json' | 'text'

export interface BuiltinParserDef {
  id: string
  name: string
  kind: ParserKind
  outputType: 'number' | 'boolean' | 'text' | 'json'
  pattern?: string
  flags?: string
  captureGroup?: number
}

export type ParsedValue = string | number | boolean | Record<string, unknown> | null | typeof PARSER_ERROR

export const PARSER_ERROR = 'PARSER_ERROR'
