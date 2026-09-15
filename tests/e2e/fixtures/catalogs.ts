// Catalog shapes as the three real providers return them (trimmed to the
// fields the app reads), captured 2026-09-13/15. Used by the provider e2e
// (through Playwright route interception) and by catalog.test.ts.

export const ANTHROPIC_MODELS = {
  data: [
    {
      type: 'model', id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', created_at: '2026-06-29T00:00:00Z',
      max_input_tokens: 1000000, max_tokens: 128000,
      capabilities: {
        effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } },
        structured_outputs: { supported: true },
        thinking: { supported: true, types: { enabled: { supported: false }, adaptive: { supported: true } } },
      },
    },
    {
      type: 'model', id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', created_at: '2025-10-15T00:00:00Z',
      max_input_tokens: 200000, max_tokens: 64000,
      capabilities: {
        effort: { supported: false, low: { supported: false }, medium: { supported: false }, high: { supported: false }, xhigh: { supported: false }, max: { supported: false } },
        structured_outputs: { supported: true },
        thinking: { supported: true, types: { enabled: { supported: true }, adaptive: { supported: false } } },
      },
    },
  ],
  has_more: false,
}

export const OPENAI_MODELS = {
  object: 'list',
  data: [
    { id: 'gpt-5', object: 'model', created: 1754000000, owned_by: 'system', shutdown_date: null },
    { id: 'gpt-5-2025-08-07', object: 'model', created: 1754000000, owned_by: 'system', shutdown_date: null },
    { id: 'gpt-4.1-mini', object: 'model', created: 1744000000, owned_by: 'system', shutdown_date: null },
    { id: 'gpt-5-pro', object: 'model', created: 1759000000, owned_by: 'system', shutdown_date: null },
    { id: 'whisper-1', object: 'model', created: 1677000000, owned_by: 'openai-internal', shutdown_date: null },
    { id: 'text-embedding-3-small', object: 'model', created: 1705000000, owned_by: 'system', shutdown_date: null },
  ],
}

export const OPENROUTER_MODELS = {
  data: [
    {
      id: 'openai/gpt-5', name: 'OpenAI: GPT-5', context_length: 400000,
      pricing: { prompt: '0.00000125', completion: '0.00001' },
      top_provider: { context_length: 400000, max_completion_tokens: 128000, is_moderated: true },
      supported_parameters: ['include_reasoning', 'max_completion_tokens', 'max_tokens', 'reasoning', 'reasoning_effort', 'response_format', 'seed', 'structured_outputs', 'tool_choice', 'tools'],
      reasoning: { mandatory: true, supported_efforts: ['high', 'medium', 'low', 'minimal'], default_effort: 'medium' },
    },
    {
      id: 'anthropic/claude-sonnet-4.5', name: 'Anthropic: Claude Sonnet 4.5', context_length: 1000000,
      pricing: { prompt: '0.000003', completion: '0.000015' },
      top_provider: { context_length: 1000000, max_completion_tokens: 64000, is_moderated: false },
      supported_parameters: ['include_reasoning', 'max_completion_tokens', 'max_tokens', 'reasoning', 'response_format', 'stop', 'structured_outputs', 'temperature', 'tool_choice', 'tools', 'top_k', 'top_p'],
      reasoning: { mandatory: false },
    },
    {
      id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Meta: Llama 3.3 70B (free)', context_length: 131072,
      pricing: { prompt: '0', completion: '0' },
      top_provider: { context_length: 131072, max_completion_tokens: null, is_moderated: false },
      supported_parameters: ['max_tokens', 'temperature', 'top_p', 'stop'],
    },
    {
      id: 'openai/gpt-5:batch', name: 'OpenAI: GPT-5 (batch)', context_length: 400000,
      pricing: { prompt: '0.0000006', completion: '0.000005' },
      top_provider: { context_length: 400000, max_completion_tokens: 128000, is_moderated: true },
      supported_parameters: ['max_tokens'],
    },
  ],
}

/** A response in the OpenAI Chat Completions shape, echoing the prompt. */
export function openaiChatResponse(model: string, content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chatcmpl-mock', object: 'chat.completion', created: 1789330000, model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
    ...extra,
  }
}

/** A response in the Anthropic Messages shape. */
export function anthropicResponse(model: string, text: string): Record<string, unknown> {
  return {
    id: 'msg_mock', type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 12, output_tokens: 7 },
  }
}

/** The user text inside an OpenAI-shaped or Anthropic-shaped request body. */
export function promptOf(body: Record<string, unknown>): string {
  const messages = (body.messages ?? []) as Array<{ role: string; content: unknown }>
  const user = messages.find(m => m.role === 'user')
  const content = user?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(p => (p as { text?: string }).text ?? '').join('')
  return ''
}
