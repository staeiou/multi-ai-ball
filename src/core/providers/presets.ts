// The four providers, hand-written from the vendor docs and verified live on
// 2026-09-13 (FULL-CONTEXT-20260913.md §4). A preset is a *contract*: how to
// talk to one endpoint. What one model accepts is guidance (guidance.ts) and
// is never encoded here. Adding a per-model rule to this file is the mistake
// this layer exists to prevent.

import type { ProviderId, ProviderPreset } from '../types'

export const PRESETS: readonly ProviderPreset[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    shape: 'openai-chat',
    baseUrl: 'https://openrouter.ai',
    chatPath: '/api/v1/chat/completions',
    modelsPath: '/api/v1/models',
    auth: { kind: 'bearer', envVar: 'OPENROUTER_API_KEY' },
    headers: { 'HTTP-Referer': 'https://stuartgeiger.com/multiaiball', 'X-Title': 'MultAIBall' },
    outputLengthName: 'max_tokens',
    effortPath: ['reasoning', 'effort'],
    structuredOutput: 'response_format',
    routing: true,
    keyOptionalForList: true,
    keyRequired: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    shape: 'openai-chat',
    baseUrl: 'https://api.openai.com',
    chatPath: '/v1/chat/completions',
    modelsPath: '/v1/models',
    auth: { kind: 'bearer', envVar: 'OPENAI_API_KEY' },
    headers: {},
    // Accepted by every current chat model including reasoning models, where
    // `max_tokens` is refused (verified live 2026-09-13 on gpt-4o, gpt-4.1-mini, gpt-5).
    outputLengthName: 'max_completion_tokens',
    effortPath: ['reasoning_effort'],
    structuredOutput: 'response_format',
    routing: false,
    keyOptionalForList: false,
    keyRequired: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    shape: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    chatPath: '/v1/messages',
    modelsPath: '/v1/models',
    auth: { kind: 'header', header: 'x-api-key', envVar: 'ANTHROPIC_API_KEY' },
    headers: { 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    outputLengthName: 'max_tokens',
    effortPath: ['output_config', 'effort'],
    structuredOutput: 'output_config',
    routing: false,
    keyOptionalForList: false,
    keyRequired: true,
  },
  {
    id: 'custom',
    label: 'Custom OpenAI-compatible endpoint',
    shape: 'openai-chat',
    baseUrl: '',
    chatPath: '/v1/chat/completions',
    modelsPath: '/v1/models',
    auth: { kind: 'bearer', envVar: 'CUSTOM_API_KEY' },
    headers: {},
    outputLengthName: 'max_tokens',
    effortPath: null,
    // Offered only when the user asks for it per model; nothing is known
    // about a custom server, so the prose in the prompt does the work.
    structuredOutput: 'response_format',
    routing: false,
    keyOptionalForList: true,
    keyRequired: false,
  },
]

export function presetById(id: string): ProviderPreset {
  return PRESETS.find(p => p.id === id) ?? PRESETS[PRESETS.length - 1]!
}

export function isProviderId(id: string): id is ProviderId {
  return PRESETS.some(p => p.id === id)
}

/** Anthropic requires `max_tokens`; everywhere else it is optional. */
export function outputLengthRequired(preset: ProviderPreset): boolean {
  return preset.shape === 'anthropic-messages'
}

/** Default output length when the user leaves it unset but the endpoint
 * requires one (Anthropic). Clamped to the model's reported ceiling. */
export const DEFAULT_OUTPUT_LENGTH = 2048
