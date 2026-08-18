// Core shared types for MultAIBall. No imports. The wire-level contracts the
// whole app moves around; everything else derives from these.

export type ProviderFamily = 'openai-compat' | 'anthropic'

export type PresetId = 'openrouter' | 'openai' | 'anthropic' | 'custom'

// --- provider runtime shape (from the vendored Auditomatic configs) ---------

export interface ParameterDef {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
  description?: string
  default?: unknown
  min?: number
  max?: number
  enum?: unknown[]
  basic?: boolean
  required?: boolean
  fixed?: boolean
  is_output_length?: boolean
  enables_features?: Record<string, Record<string, unknown>>
  properties?: Record<string, ParameterDef>
}

export interface ModelRule {
  pattern: string
  name?: string
  params: Record<string, ParameterDef>
  forbidden?: string[]
  requiredParams?: string[]
  systemPromptConfig?: SystemPromptConfig
}

export interface SystemPromptConfig {
  mode: 'message' | 'field' | 'prepend' | 'ignore'
  role?: 'system' | 'developer' | 'assistant'
  fieldName?: string
  targetField?: string
  separator?: string
  contentWrapper?: { type: string; textField: string }
}

export interface ResponseTransformConfig {
  contentPath: string
  fallbackPaths?: string[]
  errorPath?: string
  reasoningPath?: string
  reasoningFallbackPaths?: string[]
  imagesPath?: string
  imagesFallbackPaths?: string[]
}

export interface StructuredOutputConfig {
  modeParameter: string
  requiresParameter: string
  ownedParameters: string[]
  modes: Record<string, {
    label: string
    description: string
    requiresSchema?: boolean
    parameters: Record<string, unknown>
  }>
}

/** The resolved provider contract a RunSpec carries. Structural superset of
 * the raw group/endpoint configs after the interpreter's merge. */
export interface ProviderRuntime {
  id: string
  name: string
  group: string
  type: 'api' | 'deterministic'
  family: ProviderFamily
  api: { baseUrl: string; endpoint: string }
  auth: { type: 'bearer' | 'header' | 'none'; header?: string; envVar?: string }
  headers: Record<string, string>
  execution?: {
    defaultConcurrency?: number
    maxConcurrency?: number
    timeout?: number
    maxRetries?: number
    backoffMultiplier?: number
  }
  bodyConstruction?: {
    promptField: string
    wrapAsArray: boolean
    messageRole?: string
    paramNesting?: { container: string; excludeFromNesting?: string[] }
  }
  bodyTransforms?: Array<{ type: string; config?: Record<string, unknown> }>
  systemPromptConfig?: SystemPromptConfig
  responseTransform?: ResponseTransformConfig
  structuredOutput?: StructuredOutputConfig
  usageExtraction?: {
    promptTokensPath?: string
    completionTokensPath?: string
    totalTokensPath?: string
    costPath?: string
  }
  modelRules: ModelRule[]
}

export interface ParamOverrides {
  temperature?: number
  maxTokens?: number
  topP?: number
}

export interface ModelCatalogEntry {
  id: string
  name?: string
  context?: number
  /** USD per token, from the live source that reports it. */
  pricing?: { prompt: number; completion: number }
  /** OpenRouter's per-model accepted parameter names. */
  supportedParams?: string[]
  tags?: string[]
}

// --- prompt authoring (lean prompts: template + bindings, never rendered) ---

export interface CaseInput {
  id: string
  label: string
  bindings: Record<string, unknown>
}

export type CaseSource =
  | { kind: 'single' }
  | { kind: 'sheet'; template: string; name: string }

export interface CaseSourcePlan {
  source: CaseSource
  template: string
  systemTemplate: string
  cases: CaseInput[]
}

// --- structured outputs (contract model) -------------------------------------

export interface ContractField {
  name: string
  type: 'number' | 'enum' | 'string'
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

export type ContractPlacement = 'system-before' | 'system-after' | 'user-before' | 'user-after' | 'none'

export interface OutputContract {
  fields: ContractField[]
}

export interface OutputContractContext {
  contract: OutputContract
  schema: Record<string, unknown>
  name: string
  columnCount: number
}

// --- run pipeline ------------------------------------------------------------

export interface RunSpec {
  provider: ProviderRuntime
  apiKey: string
  model: string
  supportedParams?: string[]
  params: ParamOverrides
  /** Additional flat (dotted-key) wire params, e.g. structured-output
   * response_format from the output contract. */
  extraParams?: Record<string, unknown>
  prompt: string
  system: string
  stream: boolean
  /** OpenRouter only: zero-data-retention routing (`provider.zdr`). */
  zdr: boolean
  /** Export/reproducibility metadata (derived, never re-rendered). */
  caseLabel: string
  bindings: Record<string, unknown>
  repeatIndex: number
}

export type RowStatus = 'pending' | 'ok' | 'error'

/** Neutral response content. Parts replace a bare string so images and tool
 * calls are first-class without touching callers that only want text. */
export type ContentPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; dataUrl?: string; url?: string }
  | { kind: 'toolCall'; name: string; args: unknown }

export interface CallResult {
  model: string
  status: RowStatus
  latencyMs?: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  parts: ContentPart[]
  thinking?: string
  /** The raw response text — the fidelity anchor; never re-serialized. */
  rawJson?: string
  error?: string
  estimatedCostUsd?: number
  costUsd?: number
}

export interface RowProgress {
  model: string
  text: string
  thinking: string
}

export interface RunMeta {
  ts: string
  providerId: string
  providerLabel: string
  promptTemplate: string
  systemTemplate: string
  contract: OutputContract | null
  parserId: string | null
  repeats: number
}

export interface RunSnapshot {
  meta: RunMeta
  specs: RunSpec[]
  results: CallResult[]
}

// --- built-in parsers --------------------------------------------------------

export type ParserKind = 'regex' | 'json' | 'text'

export interface BuiltinParserDef {
  id: string
  name: string
  kind: ParserKind
  outputType: 'number' | 'boolean' | 'text' | 'json'
  /** Regex parsers only. */
  pattern?: string
  flags?: string
  captureGroup?: number
}

/** A response cell produced by a parser: faithful value, or a sentinel when
 * brace-shaped content could not be parsed (distinct from null = absent). */
export type ParsedValue = string | number | boolean | Record<string, unknown> | null | typeof PARSER_ERROR

export const PARSER_ERROR = 'PARSER_ERROR'