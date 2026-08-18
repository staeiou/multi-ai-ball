// Raw shapes of the vendored Auditomatic provider configs (vendor/providers)
// plus the shared config-domain types. Subset of their schema — unknown fields
// are tolerated by the interpreter, so additive upstream changes never break
// this app. These types live apart from core/types.ts (wire contracts) so the
// config interpreter stays swappable if the upstream format ever changes.

export interface GroupConfigRaw {
  id: string
  name: string
  type?: 'api' | 'deterministic'
  baseUrl: string
  auth: {
    type: 'bearer' | 'header' | 'none'
    header?: string
    envVar?: string
  }
  headers?: Record<string, string>
  execution?: {
    defaultConcurrency?: number
    maxConcurrency?: number
    timeout?: number
    maxRetries?: number
    backoffMultiplier?: number
  }
}

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

export interface EndpointConfigRaw {
  id: string
  name: string
  endpoint: string
  bodyConstruction?: {
    promptField: string
    wrapAsArray: boolean
    messageRole?: string
    paramNesting?: { container: string; excludeFromNesting?: string[] }
  }
  bodyTransforms?: Array<{ type: string; config?: Record<string, unknown> }>
  systemPromptConfig?: SystemPromptConfig
  responseModes?: Record<string, { responseTransform: ResponseTransformConfig }>
  structuredOutput?: StructuredOutputConfig
  usageExtraction?: {
    promptTokensPath?: string
    completionTokensPath?: string
    totalTokensPath?: string
    costPath?: string
  }
  modelRules: ModelRule[]
}