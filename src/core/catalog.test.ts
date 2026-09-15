import { describe, expect, it } from 'vitest'

import { ANTHROPIC_MODELS, OPENAI_MODELS, OPENROUTER_MODELS } from '../../tests/e2e/fixtures/catalogs'
import { parseCatalog } from './catalog'
import { presetById } from './providers/presets'

describe('parseCatalog', () => {
  it('OpenAI: keeps chat ids, drops non-chat and Responses-only ids, resolves dated snapshots to models.dev', () => {
    const models = parseCatalog(presetById('openai'), OPENAI_MODELS)
    expect(models.map(m => m.id)).toEqual(['gpt-4.1-mini', 'gpt-5', 'gpt-5-2025-08-07'])
    const gpt5 = models.find(m => m.id === 'gpt-5')!
    expect(gpt5.guidance.temperature).toEqual({ value: false, source: 'models-dev' })
    expect(gpt5.guidance.effortValues.value).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(models.find(m => m.id === 'gpt-5-2025-08-07')!.guidance.temperature.value).toBe(false)
    expect(models.find(m => m.id === 'gpt-4.1-mini')!.guidance.temperature.value).toBe(true)
  })

  it('Anthropic: effort levels and structured output from the live tree, temperature from models.dev, limits from the entry', () => {
    const models = parseCatalog(presetById('anthropic'), ANTHROPIC_MODELS)
    const sonnet = models.find(m => m.id === 'claude-sonnet-5')!
    expect(sonnet.guidance.effortValues).toEqual({ value: ['low', 'medium', 'high', 'xhigh', 'max'], source: 'anthropic-live' })
    expect(sonnet.guidance.structuredOutput.value).toBe(true)
    expect(sonnet.guidance.temperature).toEqual({ value: false, source: 'models-dev' })
    expect(sonnet.guidance.contextLimit.value).toBe(1000000)
    const haiku = models.find(m => m.id === 'claude-haiku-4-5-20251001')!
    expect(haiku.guidance.effortValues.value).toBeNull()
    expect(haiku.guidance.temperature.value).toBe(true)
  })

  it('OpenRouter: its own catalog is the only authority; batch routes hidden; free flagged; per-model cap spelling', () => {
    const models = parseCatalog(presetById('openrouter'), OPENROUTER_MODELS)
    expect(models.map(m => m.id)).toEqual(['anthropic/claude-sonnet-4.5', 'meta-llama/llama-3.3-70b-instruct:free', 'openai/gpt-5'])
    const gpt5 = models.find(m => m.id === 'openai/gpt-5')!
    expect(gpt5.guidance.temperature).toEqual({ value: false, source: 'openrouter-live' })
    expect(gpt5.guidance.effortValues.value).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(gpt5.guidance.pricing.value).toEqual({ prompt: 0.00000125, completion: 0.00001 })
    expect(gpt5.guidance.outputLimit.value).toBe(128000)
    const sonnet = models.find(m => m.id === 'anthropic/claude-sonnet-4.5')!
    expect(sonnet.guidance.temperature.value).toBe(true) // the union lists it; no cross-router inference
    expect(models.find(m => m.id.endsWith(':free'))!.free).toBe(true)
  })
})
