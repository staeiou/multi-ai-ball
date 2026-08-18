// Interprets the vendored Auditomatic Lite provider configs (vendor/providers).
// Those configs are the maintained source of truth for base URLs, auth,
// headers, parameter rules, extraction paths, and structured-output support —
// this app interprets them and never re-declares them. The merge mirrors their
// ConfigLoader exactly (group -> api/auth/execution/headers; endpoint -> the
// rest; path-derived group id wins). Unknown fields are tolerated: additive
// upstream config changes never break this app.
//
// Refresh the vendored copy with: npm run sync:providers

import type {
  EndpointConfigRaw,
  GroupConfigRaw,
  ModelRule,
  SystemPromptConfig,
} from './config-shapes'
import type { ProviderFamily, ProviderRuntime } from './types'

export type { ModelRule, ParameterDef, SystemPromptConfig, ResponseTransformConfig } from './config-shapes'

/** Model-catalog path derived from the chat endpoint, so a provider whose API
 * lives under a prefix (OpenRouter: /api/v1/...) never 404s. */
export function modelListEndpointFor(endpoint: string): string {
  const match = /^(.*)\/(?:chat\/completions|messages|generate|responses)$/.exec(endpoint)
  return match ? `${match[1]}/models` : '/v1/models'
}

export interface ResolvedProviderConfig extends ProviderRuntime {
  family: ProviderFamily
  modelListEndpoint: string
}

/** Groups whose wire formats this app cannot speak yet. Kept as data with the
 * reason; adding a family means adding the adapter in providers.ts. */
const UNSUPPORTED_GROUPS: Record<string, string> = {
  deterministic: 'in-app deterministic models, not an HTTP endpoint',
  ollama: 'native /api/chat + /api/generate shapes (not OpenAI-compatible)',
}

/** Family by group id; everything else OpenAI-compatible. */
const FAMILY_BY_GROUP: Record<string, ProviderFamily> = {
  anthropic: 'anthropic',
}

const GROUP_GLOBS = import.meta.glob<{ default: GroupConfigRaw }>('../../vendor/providers/*/group.json', { eager: true })
const ENDPOINT_GLOBS = import.meta.glob<{ default: EndpointConfigRaw }>('../../vendor/providers/*/endpoints/*.json', { eager: true })

function pathSegment(path: string, fromEnd: number): string {
  const parts = path.split('/')
  return parts[parts.length - fromEnd]!
}

const groups = new Map<string, GroupConfigRaw>()
for (const [path, module] of Object.entries(GROUP_GLOBS)) {
  const id = pathSegment(path, 2)
  groups.set(id, { ...module.default, id })
}

const resolved = new Map<string, ResolvedProviderConfig>()
for (const [path, module] of Object.entries(ENDPOINT_GLOBS)) {
  const groupId = pathSegment(path, 3)
  const group = groups.get(groupId)
  if (!group || UNSUPPORTED_GROUPS[groupId]) continue
  const endpoint = module.default
  resolved.set(endpoint.id, {
    id: endpoint.id,
    name: endpoint.name,
    group: groupId,
    type: group.type ?? 'api',
    family: FAMILY_BY_GROUP[groupId] ?? 'openai-compat',
    api: { baseUrl: group.baseUrl, endpoint: endpoint.endpoint },
    modelListEndpoint: modelListEndpointFor(endpoint.endpoint),
    auth: group.auth,
    headers: { 'Content-Type': 'application/json', ...(group.headers ?? {}) },
    execution: group.execution,
    bodyConstruction: endpoint.bodyConstruction,
    bodyTransforms: endpoint.bodyTransforms,
    systemPromptConfig: endpoint.systemPromptConfig,
    responseTransform: endpoint.responseModes?.text?.responseTransform,
    structuredOutput: endpoint.structuredOutput,
    usageExtraction: endpoint.usageExtraction,
    modelRules: endpoint.modelRules ?? [],
  })
}

export function getAllProviders(): ResolvedProviderConfig[] {
  return [...resolved.values()]
}

export function getProvider(id: string): ResolvedProviderConfig | undefined {
  return resolved.get(id)
}

export function providerGroup(id: string): string {
  return resolved.get(id)?.group ?? id
}

export function keyOptionalForList(groupId: string): boolean {
  // OpenRouter's model list is public; everything else needs the key.
  return groupId === 'openrouter'
}

/** The parameter rules that apply to a model: first matching rule, forbidden
 * parameters removed — exactly their ParameterService semantics. */
export function matchingRule(provider: { id?: string; modelRules: ModelRule[] }, modelId: string): ModelRule | undefined {
  const modelName = provider.id && modelId.startsWith(`${provider.id}:`)
    ? modelId.slice(provider.id.length + 1)
    : modelId
  for (const rule of provider.modelRules) {
    if (new RegExp(rule.pattern).test(modelName)) {
      if (rule.forbidden?.length) {
        const params = { ...rule.params }
        for (const name of rule.forbidden) delete params[name]
        return { ...rule, params }
      }
      return rule
    }
  }
  return undefined
}

/** The model rule's system-prompt config, falling back to the endpoint's,
 * then `ignore` — their getSystemPromptConfig semantics. */
export function systemPromptConfigFor(provider: { modelRules: ModelRule[]; systemPromptConfig?: SystemPromptConfig }, modelId: string): SystemPromptConfig {
  return matchingRule(provider, modelId)?.systemPromptConfig
    ?? provider.systemPromptConfig
    ?? { mode: 'ignore' }
}

/** The parameter that controls output length for a model (max_tokens vs
 * max_completion_tokens), from the rules' is_output_length marker. */
export function outputLengthParamName(provider: { modelRules: ModelRule[] }, modelId: string): string {
  const rule = matchingRule(provider, modelId)
  if (rule) {
    for (const [name, def] of Object.entries(rule.params)) {
      if (def.is_output_length) return name
    }
  }
  return 'max_tokens'
}

/** Whether this provider's structured-output modes are usable at all
 * (the rule set defines the `requiresParameter` root param). */
export function supportsStructuredOutput(provider: ResolvedProviderConfig, modelId: string): boolean {
  if (!provider.structuredOutput) return false
  const rule = matchingRule(provider, modelId)
  if (!rule) return false
  return provider.structuredOutput.requiresParameter in rule.params
}