import { describe, expect, it } from 'vitest'

import { buildContractContext } from '../contract'
import { CLAUDE_LIKE, GPT41_LIKE, GPT_LIKE, UNKNOWN_MODEL } from '../testing/fixtures'
import type { SharedParams } from '../types'
import { buildFrozenModel } from './build'
import { presetById } from './presets'

const SHARED: SharedParams = { outputLength: 2048, temperature: 0.7, effort: 'low', responseFormat: 'auto' }
const CONTRACT = buildContractContext({ fields: [{ name: 'frame', type: 'enum', values: ['economic', 'civic'] }, { name: 'score', type: 'integer', min: 1, max: 5 }] })

function sent(report: { param: string; sent: boolean }[], param: string): boolean {
  return report.some(r => r.param === param && r.sent)
}

describe('buildFrozenModel', () => {
  it('OpenAI native: max_completion_tokens, no temperature for a refusing model, effort placed flat, schema when claimed', () => {
    const m = buildFrozenModel({ preset: presetById('openai'), baseUrl: 'https://api.openai.com', model: GPT_LIKE, shared: SHARED, settings: { extras: {} }, contract: CONTRACT, hasSystem: true })
    expect(m.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(m.headers.Authorization).toBe('Bearer {{API_KEY}}')
    expect(m.body.max_completion_tokens).toBe(2048)
    expect(m.body).not.toHaveProperty('temperature')
    expect(m.body.reasoning_effort).toBe('low')
    expect((m.body.response_format as { type: string }).type).toBe('json_schema')
    expect((m.body.messages as unknown[]).length).toBe(2)
    expect(sent(m.report, 'temperature')).toBe(false)
    expect(m.report.find(r => r.param === 'temperature')?.reason).toMatch(/only its default/)
  })

  it('sends temperature where the model accepts it and omits effort where it has none', () => {
    const m = buildFrozenModel({ preset: presetById('openai'), baseUrl: 'https://api.openai.com', model: GPT41_LIKE, shared: SHARED, settings: { extras: {} }, contract: null, hasSystem: false })
    expect(m.body.temperature).toBe(0.7)
    expect(m.body).not.toHaveProperty('reasoning_effort')
    expect(m.body).not.toHaveProperty('response_format')
    expect((m.body.messages as unknown[]).length).toBe(1)
    expect(m.report.find(r => r.param === 'reasoning_effort')?.reason).toMatch(/not reported/)
  })

  it('Anthropic: system as a top-level field, max_tokens required, effort under output_config, schema under output_config.format', () => {
    const m = buildFrozenModel({ preset: presetById('anthropic'), baseUrl: 'https://api.anthropic.com', model: CLAUDE_LIKE, shared: { ...SHARED, outputLength: null }, settings: { extras: {} }, contract: CONTRACT, hasSystem: true })
    expect(m.headers['x-api-key']).toBe('{{API_KEY}}')
    expect(m.body.system).toBe('{{SYSTEM}}')
    expect(m.body.max_tokens).toBe(2048)
    expect((m.body.output_config as { effort: string; format: { type: string } }).effort).toBe('low')
    expect((m.body.output_config as { format: { type: string } }).format.type).toBe('json_schema')
    expect(m.body).not.toHaveProperty('temperature')
  })

  it('clamps the output length to a reported ceiling and says so', () => {
    const m = buildFrozenModel({ preset: presetById('openai'), baseUrl: 'x', model: GPT41_LIKE, shared: { ...SHARED, outputLength: 100000 }, settings: { extras: {} }, contract: null, hasSystem: false })
    expect(m.body.max_completion_tokens).toBe(32768)
    expect(m.report.find(r => r.param === 'max_completion_tokens')?.reason).toMatch(/clamped/)
  })

  it('unknown model: nothing but the output length; schema only when forced per model', () => {
    const auto = buildFrozenModel({ preset: presetById('custom'), baseUrl: 'http://localhost:8787', model: UNKNOWN_MODEL, shared: SHARED, settings: { extras: {} }, contract: CONTRACT, hasSystem: true })
    expect(auto.body.max_tokens).toBe(2048)
    expect(auto.body).not.toHaveProperty('response_format')
    expect(auto.body).not.toHaveProperty('temperature')
    const forced = buildFrozenModel({ preset: presetById('custom'), baseUrl: 'http://localhost:8787', model: UNKNOWN_MODEL, shared: SHARED, settings: { extras: {}, responseFormat: 'schema' }, contract: CONTRACT, hasSystem: true })
    expect((forced.body.response_format as { type: string }).type).toBe('json_schema')
  })

  it('OpenRouter: routing block on by default, per-model output-length spelling, sub-provider order carried', () => {
    const model = { ...GPT_LIKE, id: 'openai/gpt-5', guidance: { ...GPT_LIKE.guidance, outputLengthName: 'max_completion_tokens' } }
    const m = buildFrozenModel({ preset: presetById('openrouter'), baseUrl: 'https://openrouter.ai', model, shared: SHARED, settings: { extras: {}, routing: { requireParameters: true, zdr: true, order: ['Azure'], allowFallbacks: false } }, contract: null, hasSystem: false })
    expect(m.body.provider).toEqual({ require_parameters: true, zdr: true, order: ['Azure'], allow_fallbacks: false })
    expect(m.body.max_completion_tokens).toBe(2048)
    expect((m.body.reasoning as { effort: string }).effort).toBe('low')
  })

  it('auto format: JSON-object mode where the model lists JSON mode but not a schema; nothing where it lists neither', () => {
    const jsonOnly = { id: 'deepseek/deepseek-r1', guidance: { ...GPT41_LIKE.guidance, structuredOutput: { value: false as const, source: 'openrouter-live' as const }, jsonObject: { value: true as const, source: 'openrouter-live' as const } } }
    const m = buildFrozenModel({ preset: presetById('openrouter'), baseUrl: 'https://openrouter.ai', model: jsonOnly, shared: SHARED, settings: { extras: {} }, contract: CONTRACT, hasSystem: true })
    expect(m.body.response_format).toEqual({ type: 'json_object' })
    expect(m.report.find(r => r.param === 'response_format (JSON object)')?.reason).toMatch(/JSON mode but not a schema/)
    const neither = { ...jsonOnly, guidance: { ...jsonOnly.guidance, jsonObject: { value: false as const, source: 'openrouter-live' as const } } }
    const n = buildFrozenModel({ preset: presetById('openrouter'), baseUrl: 'https://openrouter.ai', model: neither, shared: SHARED, settings: { extras: {} }, contract: CONTRACT, hasSystem: true })
    expect(n.body).not.toHaveProperty('response_format')
    expect(n.report.find(r => r.param.startsWith('response_format'))?.reason).toMatch(/not to support JSON schema/)
    // An explicit per-model 'schema' choice still wins over guidance.
    const forced = buildFrozenModel({ preset: presetById('openrouter'), baseUrl: 'https://openrouter.ai', model: jsonOnly, shared: SHARED, settings: { extras: {}, responseFormat: 'schema' }, contract: CONTRACT, hasSystem: true })
    expect((forced.body.response_format as { type: string }).type).toBe('json_schema')
  })

  it('extras merge last, override shared controls, and never touch structural keys', () => {
    const m = buildFrozenModel({ preset: presetById('openai'), baseUrl: 'x', model: GPT41_LIKE, shared: SHARED, settings: { extras: { temperature: 0.1, top_p: 0.9, messages: [], model: 'nope' } }, contract: null, hasSystem: false })
    expect(m.body.temperature).toBe(0.1)
    expect(m.body.top_p).toBe(0.9)
    expect(m.body.model).toBe('gpt-4.1-mini')
    expect(Array.isArray(m.body.messages) && (m.body.messages as unknown[]).length).toBe(1)
    expect(m.report.filter(r => r.reason.includes('structural')).map(r => r.param).sort()).toEqual(['messages', 'model'])
  })
})
