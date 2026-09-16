import { describe, expect, it } from 'vitest'

import { ANTHROPIC_MODELS, OPENAI_MODELS, OPENROUTER_MODELS } from '../../tests/e2e/fixtures/catalogs'
import { parseCatalog } from './catalog'
import { manualCatalogModel } from './providers/guidance'
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
    expect(models.map(m => m.id)).toEqual(['anthropic/claude-sonnet-4.5', 'deepseek/deepseek-r1', 'meta-llama/llama-3.3-70b-instruct:free', 'openai/gpt-5'])
    const gpt5 = models.find(m => m.id === 'openai/gpt-5')!
    expect(gpt5.guidance.temperature).toEqual({ value: false, source: 'openrouter-live' })
    expect(gpt5.guidance.effortValues.value).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(gpt5.guidance.pricing.value).toEqual({ prompt: 0.00000125, completion: 0.00001 })
    expect(gpt5.guidance.outputLimit.value).toBe(128000)
    const sonnet = models.find(m => m.id === 'anthropic/claude-sonnet-4.5')!
    expect(sonnet.guidance.temperature.value).toBe(true) // the union lists it; no cross-router inference
    expect(models.find(m => m.id.endsWith(':free'))!.free).toBe(true)
  })

  it('OpenRouter: structured_outputs means schema, response_format alone means JSON mode', () => {
    const models = parseCatalog(presetById('openrouter'), OPENROUTER_MODELS)
    const r1 = models.find(m => m.id === 'deepseek/deepseek-r1')!
    expect(r1.guidance.structuredOutput).toEqual({ value: false, source: 'openrouter-live' })
    expect(r1.guidance.jsonObject).toEqual({ value: true, source: 'openrouter-live' })
    const gpt5 = models.find(m => m.id === 'openai/gpt-5')!
    expect(gpt5.guidance.structuredOutput.value).toBe(true)
    expect(gpt5.guidance.jsonObject.value).toBe(true)
    const llama = models.find(m => m.id.endsWith(':free'))!
    expect(llama.guidance.structuredOutput.value).toBe(false)
    expect(llama.guidance.jsonObject.value).toBe(false)
  })

  it('exceptions.json overrides the catalog for the models it names, with the override source', () => {
    const seed = manualCatalogModel('openrouter', 'bytedance-seed/seed-2.0-code')
    expect(seed.guidance.structuredOutput).toEqual({ value: false, source: 'override' })
    expect(seed.guidance.jsonObject.source).toBe('unknown')
    const nano = manualCatalogModel('openrouter', 'google/gemini-2.5-flash-image')
    expect(nano.guidance.structuredOutput).toEqual({ value: false, source: 'override' })
    expect(nano.guidance.jsonObject).toEqual({ value: false, source: 'override' })
    expect(manualCatalogModel('openrouter', 'openai/gpt-5').guidance.structuredOutput.source).toBe('unknown')
  })
})
