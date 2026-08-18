import { describe, expect, it } from 'vitest'

import { presetById, PRESETS, buildChatRequestBody, buildContractParams, getValueAtPath, modelListRequest, parseModelList, parseZdrModels, resolvedParams, streamDelta } from './providers'
import { modelListEndpointFor } from './provider-config'
import type { RunSpec } from './types'

function spec(overrides: Partial<RunSpec> = {}): RunSpec {
  const openai = presetById('openai-chat')
  return {
    provider: { ...openai.provider, api: { ...openai.provider.api } },
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
    params: { temperature: 0.4, maxTokens: 256, topP: undefined },
    prompt: 'Hello',
    system: '',
    stream: false,
    zdr: false,
    caseLabel: 'Input',
    bindings: {},
    repeatIndex: 0,
    ...overrides,
  }
}

describe('presets from the maintained configs', () => {
  it('derives the hosted presets plus custom', () => {
    const ids = PRESETS.map(p => p.id)
    expect(ids).toContain('openrouter')
    expect(ids).toContain('openai-chat')
    expect(ids).toContain('anthropic')
    expect(ids).toContain('custom')
    expect(ids[ids.length - 1]).toBe('custom')
    expect(PRESETS.find(p => p.id === 'custom')!.customBase).toBe(true)
  })

  it('maps auth env vars for the python runner', () => {
    expect(presetById('openrouter').keyEnvVar).toBe('OPENROUTER_API_KEY')
    expect(presetById('anthropic').keyEnvVar).toBe('ANTHROPIC_API_KEY')
    expect(presetById('custom').keyEnvVar).toBe('CUSTOM_API_KEY')
  })
})

describe('buildChatRequestBody', () => {
  it('builds an OpenAI-compatible body via bodyConstruction', () => {
    const openai = presetById('openai-chat')
    const body = buildChatRequestBody(openai.provider, 'gpt-4o-mini', { temperature: 0.4, max_tokens: 256 }, 'Hello', '', { stream: false, zdr: false })
    expect(body.model).toBe('gpt-4o-mini')
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }])
    expect(body.temperature).toBe(0.4)
    expect(body.max_tokens).toBe(256)
  })

  it('prepends the system message and injects stream options', () => {
    const openai = presetById('openai-chat')
    const body = buildChatRequestBody(openai.provider, 'gpt-4o-mini', {}, 'Hi', 'Be terse.', { stream: true, zdr: false })
    expect(body.messages).toEqual([
      { role: 'system', content: [{ type: 'text', text: 'Be terse.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    ])
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('builds an Anthropic body via field system + x-api-key data', () => {
    const anthropic = presetById('anthropic')
    const provider = anthropic.provider
    const body = buildChatRequestBody(provider, 'claude-sonnet-4-20250514', { temperature: 0.2, max_tokens: 512 }, 'Hi', 'Be terse.', { stream: false, zdr: false })
    expect(body.model).toBe('claude-sonnet-4-20250514')
    expect(body.system).toBe('Be terse.')
    expect(body.messages).toEqual([{ role: 'user', content: 'Hi' }])
    expect(body.max_tokens).toBe(512)
    expect(body.temperature).toBe(0.2)
  })

  it('adds zdr routing for OpenRouter only', () => {
    const openrouter = presetById('openrouter')
    expect(buildChatRequestBody(openrouter.provider, 'openai/gpt-4o', {}, 'x', '', { stream: false, zdr: true }).provider).toEqual({ zdr: true })
    const openai = presetById('openai-chat')
    expect(buildChatRequestBody(openai.provider, 'gpt-4o', {}, 'x', '', { stream: false, zdr: true }).provider).toBeUndefined()
  })

  it('wraps response_format strings via the maintained transform', () => {
    const openai = presetById('openai-chat')
    const body = buildChatRequestBody(openai.provider, 'gpt-4o', { response_format: 'json_object' }, 'x', '', { stream: false, zdr: false })
    expect(body.response_format).toEqual({ type: 'json_object' })
  })
})

describe('resolvedParams', () => {
  it('omits unsupported parameters per the live supported list', () => {
    const gpt5 = spec({ model: 'openai/gpt-5', provider: { ...presetById('openrouter').provider }, supportedParams: ['max_completion_tokens', 'reasoning'] })
    const params = resolvedParams(gpt5)
    expect(params.temperature).toBeUndefined()
    expect(params.max_completion_tokens).toBe(256)
    expect(params.max_tokens).toBeUndefined()
  })

  it('keeps parameters the rules declare for a normal model', () => {
    const params = resolvedParams(spec())
    expect(params.temperature).toBe(0.4)
    expect(params.max_completion_tokens).toBe(256)
  })
})

describe('getValueAtPath', () => {
  it('resolves dotted and indexed paths', () => {
    const data = { choices: [{ message: { content: 'hi' } }] }
    expect(getValueAtPath(data, 'choices[0].message.content')).toBe('hi')
  })

  it('resolves the anthropic content filter path', () => {
    const data = { content: [
      { type: 'tool_use', text: 'nope', input: {} },
      { type: 'text', text: 'answered' },
    ] }
    expect(getValueAtPath(data, "content[?(@.type=='text')].text")).toBe('answered')
  })
})

describe('streamDelta', () => {
  it('extracts openai-compat deltas incl. reasoning', () => {
    const delta = streamDelta('openai-compat', { choices: [{ delta: { content: 'x', reasoning_content: 'think' } }] })
    expect(delta.text).toBe('x')
    expect(delta.thinking).toBe('think')
  })

  it('extracts anthropic thinking/text deltas and usage', () => {
    const thinking = streamDelta('anthropic', { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'r' } })
    expect(thinking.thinking).toBe('r')
    const text = streamDelta('anthropic', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a' } })
    expect(text.text).toBe('a')
    const usage = streamDelta('anthropic', { type: 'message_delta', usage: { output_tokens: 5 } })
    expect(usage.usage).toEqual({ output_tokens: 5 })
  })
})

describe('live catalogs', () => {
  it('parses model pricing and supported params, hides embeddings', () => {
    const list = parseModelList({ data: [
      { id: 'gpt-4o-mini', context_length: 128000, pricing: { prompt: '0.00000015', completion: '0.0000006' }, supported_parameters: ['temperature', 'max_tokens'] },
      { id: 'text-embedding-3-small' },
    ] })
    expect(list).toHaveLength(1)
    expect(list[0]!.pricing).toEqual({ prompt: 0.00000015, completion: 0.0000006 })
    expect(list[0]!.context).toBe(128000)
    expect(list[0]!.supportedParams).toEqual(['temperature', 'max_tokens'])
  })

  it('parses the ZDR endpoint list', () => {
    const ids = parseZdrModels({ data: [
      { model_id: 'anthropic/claude-opus-4.6' },
      { model_id: 'openai/gpt-5' },
    ] })
    expect([...ids].sort()).toEqual(['anthropic/claude-opus-4.6', 'openai/gpt-5'])
  })
})

describe('model-list endpoint regression', () => {
  it('derives the OpenRouter catalog path so it never 404s', () => {
    expect(modelListEndpointFor('/api/v1/chat/completions')).toBe('/api/v1/models')
    expect(modelListEndpointFor('/v1/messages')).toBe('/v1/models')
    const req = modelListRequest(presetById('openrouter'), 'https://openrouter.ai', '')
    expect(req.url).toBe('https://openrouter.ai/api/v1/models')
  })
})

describe('structured-output wiring', () => {
  it('injects response_format json_schema only when the model rules allow it', () => {
    const openai = presetById('openai-chat')
    const contract = { contract: { fields: [{ name: 'score', type: 'number' as const }] }, schema: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'], additionalProperties: false }, name: 'multiaiball_output', columnCount: 1 }
    const params = buildContractParams(openai.provider, 'gpt-4o-mini', contract, true)
    expect(params['response_format.type']).toBe('json_schema')
    expect((params['response_format.json_schema'] as Record<string, unknown>).schema).toBe(contract.schema)
    const unsupported = buildContractParams(presetById('anthropic').provider, 'claude-sonnet-4-20250514', contract, true)
    expect(unsupported).toEqual({})
  })

  it('writes the wired params onto the wire body via the response_format transform', () => {
    const openai = presetById('openai-chat')
    const body = buildChatRequestBody(openai.provider, 'gpt-4o-mini', {
      response_format: { type: 'json_object' },
    }, 'x', '', { stream: false, zdr: false })
    expect(body.response_format).toEqual({ type: 'json_object' })
  })
})

describe('enables_features', () => {
  it('maps the generic logprobs flag through the maintained boolean carrier', () => {
    const openai = presetById('openai-chat')
    // chat.json: logprobs param carries {logprobs: {boolean_value: true}} —
    // carrier and generic flag share the name here, so the transform writes
    // then deletes the same key (identical to upstream behavior: the generic
    // flag field must not reach the wire under the carrier's name twice).
    const body = buildChatRequestBody(openai.provider, 'gpt-4o-mini', { logprobs: true }, 'x', '', { stream: false, zdr: false })
    expect(body.logprobs).toBeUndefined()
  })

  it('maps array carriers and drops the generic flag for the responses endpoint', () => {
    const openai = presetById('openai-responses')
    const body = buildChatRequestBody(openai.provider, 'gpt-4o-mini', { logprobs: true }, 'Response?', '', { stream: false, zdr: false }) as Record<string, unknown>
    expect(body.logprobs).toBeUndefined()
    expect(body.include).toEqual(['message.output_text.logprobs'])
  })
})
