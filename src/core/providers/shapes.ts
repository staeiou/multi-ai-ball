// The two wire shapes: how a body skeleton is laid out and how a response is
// read. Shapes know nothing about models. The skeleton carries `{{SYSTEM}}`
// and `{{PROMPT}}` as whole string values so the browser runner and the
// Python bundle substitute the same way (a JSON-text replace of a whole
// string value, see runtime/multiaiball/runner.py build_request).

import type { ContentPart, Shape } from '../types'

export const SYSTEM_SENTINEL = '{{SYSTEM}}'
export const PROMPT_SENTINEL = '{{PROMPT}}'

type JsonRecord = Record<string, unknown>

/** Structural keys the app owns on each shape; the escape hatch may not set them. */
export const OWNED_KEYS: Record<Shape, readonly string[]> = {
  'openai-chat': ['model', 'messages', 'stream', 'stream_options'],
  'anthropic-messages': ['model', 'messages', 'system', 'stream'],
}

/** Body skeleton with the prompt channels as sentinels and no parameters. */
export function skeleton(shape: Shape, modelId: string, hasSystem: boolean): JsonRecord {
  if (shape === 'anthropic-messages') {
    const body: JsonRecord = { model: modelId }
    if (hasSystem) body.system = SYSTEM_SENTINEL
    body.messages = [{ role: 'user', content: PROMPT_SENTINEL }]
    return body
  }
  const messages: JsonRecord[] = []
  if (hasSystem) messages.push({ role: 'system', content: SYSTEM_SENTINEL })
  messages.push({ role: 'user', content: PROMPT_SENTINEL })
  return { model: modelId, messages }
}

/** Replace the sentinels (whole string values only) with rendered text. */
export function substitute(body: unknown, system: string, prompt: string): unknown {
  if (typeof body === 'string') {
    if (body === SYSTEM_SENTINEL) return system
    if (body === PROMPT_SENTINEL) return prompt
    return body
  }
  if (Array.isArray(body)) return body.map(item => substitute(item, system, prompt))
  if (body && typeof body === 'object') {
    const out: JsonRecord = {}
    for (const [key, value] of Object.entries(body as JsonRecord)) out[key] = substitute(value, system, prompt)
    return out
  }
  return body
}

/** The structured-output parameter for a JSON schema, per shape. */
export function schemaParam(shape: Shape, name: string, schema: Record<string, unknown>): JsonRecord {
  if (shape === 'anthropic-messages') {
    return { output_config: { format: { type: 'json_schema', schema } } }
  }
  return { response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } } }
}

/** The "valid JSON, shape not enforced" mode. Anthropic has no such mode. */
export function jsonObjectParam(shape: Shape): JsonRecord | null {
  if (shape === 'anthropic-messages') return null
  return { response_format: { type: 'json_object' } }
}

// --- response reading ---------------------------------------------------------

export interface ReadResponse {
  parts: ContentPart[]
  text: string | null
  thinking?: string
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  costUsd?: number
  /** OpenRouter: which sub-provider served the call. */
  upstream?: string
  /** Why generation stopped: 'stop'/'end_turn', 'length'/'max_tokens', ... */
  finishReason?: string
  error?: string
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function readResponse(shape: Shape, json: unknown): ReadResponse {
  const record = (json ?? {}) as JsonRecord
  if (shape === 'anthropic-messages') {
    const blocks = Array.isArray(record.content) ? (record.content as JsonRecord[]) : []
    const parts: ContentPart[] = []
    let thinking = ''
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') parts.push({ kind: 'text', text: block.text })
      else if (block.type === 'thinking' && typeof block.thinking === 'string') thinking += block.thinking
      else if (block.type === 'tool_use') parts.push({ kind: 'toolCall', name: String(block.name ?? ''), args: block.input })
    }
    const usage = (record.usage ?? {}) as JsonRecord
    const input = num(usage.input_tokens)
    const output = num(usage.output_tokens)
    return {
      parts,
      text: joinText(parts),
      thinking: thinking || undefined,
      promptTokens: input,
      completionTokens: output,
      totalTokens: input !== undefined && output !== undefined ? input + output : undefined,
      finishReason: typeof record.stop_reason === 'string' ? record.stop_reason : undefined,
      error: errorMessage(record),
    }
  }
  const choice = Array.isArray(record.choices) ? (record.choices[0] as JsonRecord | undefined) : undefined
  const message = (choice?.message ?? {}) as JsonRecord
  const parts: ContentPart[] = []
  if (typeof message.content === 'string') {
    if (message.content) parts.push({ kind: 'text', text: message.content })
  } else if (Array.isArray(message.content)) {
    for (const item of message.content as JsonRecord[]) {
      if (item.type === 'text' && typeof item.text === 'string') parts.push({ kind: 'text', text: item.text })
      else if (item.type === 'image_url') {
        const url = (item.image_url as JsonRecord | undefined)?.url
        if (typeof url === 'string') parts.push({ kind: 'image', url })
      }
    }
  }
  for (const call of Array.isArray(message.tool_calls) ? (message.tool_calls as JsonRecord[]) : []) {
    const fn = (call.function ?? {}) as JsonRecord
    let args: unknown = fn.arguments
    if (typeof args === 'string') {
      try { args = JSON.parse(args) } catch { /* keep the raw string */ }
    }
    parts.push({ kind: 'toolCall', name: String(fn.name ?? ''), args })
  }
  const thinking = typeof message.reasoning_content === 'string'
    ? message.reasoning_content
    : typeof message.reasoning === 'string' ? message.reasoning : undefined
  const usage = (record.usage ?? {}) as JsonRecord
  return {
    parts,
    text: joinText(parts),
    thinking: thinking || undefined,
    promptTokens: num(usage.prompt_tokens),
    completionTokens: num(usage.completion_tokens),
    totalTokens: num(usage.total_tokens),
    costUsd: num(usage.cost),
    upstream: typeof record.provider === 'string' ? record.provider : undefined,
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : typeof choice?.native_finish_reason === 'string' ? choice.native_finish_reason : undefined,
    error: errorMessage(record),
  }
}

function joinText(parts: ContentPart[]): string | null {
  const texts = parts.filter(p => p.kind === 'text').map(p => (p as { text: string }).text)
  return texts.length ? texts.join('\n') : null
}

/** The provider's own error message, whatever the HTTP status. */
export function errorMessage(json: unknown): string | undefined {
  const error = (json as JsonRecord | null | undefined)?.error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const message = (error as JsonRecord).message
    if (message) return String(message)
  }
  return undefined
}

/** True when the provider stopped because the output limit was used up. */
export function hitOutputLimit(finishReason: string | undefined): boolean {
  return finishReason === 'length' || finishReason === 'max_tokens' || finishReason === 'max_output_tokens'
}
