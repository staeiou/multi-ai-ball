import { describe, expect, it } from 'vitest'

import { modelsAreCurrent, modelsCacheKey, planFingerprint, providerKeyRequired, stageGate } from './model'
import type { AppPersisted, AppSession } from './model'

const PRESET_FIXTURES = [
  { id: 'openai-chat' },
  { id: 'openrouter' },
  { id: 'custom', customBase: true },
]

function session(overrides: Partial<AppSession> = {}): AppSession {
  return {
    apiKey: '',
    models: [],
    zdrIds: new Set(),
    sheetRowCount: 0,
    tokenEstimate: 0,
    modelsCarriedBy: '',
    ...overrides,
  }
}

function state(overrides: Partial<AppPersisted> = {}): AppPersisted {
  return {
    presetId: 'custom',
    customBase: 'http://localhost:8787',
    prompt: '',
    system: '',
    source: { kind: 'single' },
    selected: [],
    params: {},
    contract: { fields: [] },
    placement: 'system-after',
    parserId: null,
    repeats: 1,
    zdr: false,
    hideFreeModels: true,
    budget: 0.005,
    retries: 2,
    concurrency: 6,
    stream: true,
    streamThreshold: 100,
    ...overrides,
  }
}

describe('providerKeyRequired', () => {
  it('requires a key for every preset except the user custom endpoint', () => {
    for (const preset of PRESET_FIXTURES.filter(p => !p.customBase)) {
      expect(providerKeyRequired(preset)).toBe(true)
    }
    expect(providerKeyRequired(PRESET_FIXTURES[2]!)).toBe(false)
  })
})

describe('models cache', () => {
  it('keys the loaded list to the provider + base URL pair', () => {
    expect(modelsCacheKey('custom', 'http://x')).toBe('custom|http://x')
  })

  it('treats a list as current only when the pair matches', () => {
    const s = session({ modelsCarriedBy: modelsCacheKey('custom', 'http://a') })
    expect(modelsAreCurrent(s, 'custom', 'http://a')).toBe(true)
    expect(modelsAreCurrent(s, 'custom', 'http://b')).toBe(false)
    // Same URL, different provider: stale too.
    expect(modelsAreCurrent(s, 'openai-chat', 'http://a')).toBe(false)
    // Nothing loaded yet: never current.
    expect(modelsAreCurrent(session(), 'custom', 'http://a')).toBe(false)
  })
})

describe('planFingerprint', () => {
  const fp = (st: AppPersisted, s: AppSession) => planFingerprint({ state: st, session: s, sheetTemplate: '' })

  it('changes when the prompt, selection, params, or source changes', () => {
    const s = session({ sheetRowCount: 0 })
    const base = state({ prompt: 'Classify: {{t}}', selected: ['a'] })
    const one = fp(base, s)
    expect(fp({ ...base, prompt: 'Classify: {{t}}!' }, s)).not.toBe(one)
    expect(fp({ ...base, selected: ['a', 'b'] }, s)).not.toBe(one)
    expect(fp({ ...base, params: { temperature: 0.9 } }, s)).not.toBe(one)
    expect(fp({ ...base, source: { kind: 'sheet', template: 'x', name: 's' } }, s)).not.toBe(one)
  })

  it('includes sheet row count and template', () => {
    const s = session({ sheetRowCount: 10 })
    const st = state({ source: { kind: 'sheet', template: 'Hi {{a}}', name: 's' } })
    const one = fp(st, s)
    expect(fp(st, session({ sheetRowCount: 11 }))).not.toBe(one)
    expect(planFingerprint({ state: st, session: s, sheetTemplate: 'Hi {{a}}!' })).not.toBe(one)
  })

  it('stays stable for identical input', () => {
    const s = session({ sheetRowCount: 0 })
    expect(fp(state({ prompt: 'x', selected: ['a', 'b'] }), s)).toBe(fp(state({ prompt: 'x', selected: ['a', 'b'] }), s))
  })

  it('detects changes anywhere in a long run configuration', () => {
    const s = session()
    const base = state({ prompt: `prefix-${'x'.repeat(2200)}`, selected: ['a'] })
    const one = fp(base, s)
    expect(fp({ ...base, prompt: `${base.prompt.slice(0, -1)}y` }, s)).not.toBe(one)
    expect(fp({ ...base, system: 'changed' }, s)).not.toBe(one)
    expect(fp({ ...base, params: { temperature: 0.2 } }, s)).not.toBe(one)
  })
})

describe('stageGate', () => {
  const gate = (st: AppPersisted, s: AppSession, preset = PRESET_FIXTURES[2]!, baseUrl = 'http://localhost:8787') =>
    stageGate(2, { state: st, session: s, preset, baseUrl, contractOk: true })

  it('step 0 requires a prompt', () => {
    expect(stageGate(0, { state: state(), session: session(), preset: PRESET_FIXTURES[2]!, baseUrl: 'x', contractOk: true })).toEqual({ ok: false, why: 'Write a prompt first', canRun: false })
  })

  it('blocks the run on a missing key even with models loaded (the OpenRouter case)', () => {
    const s = session({ apiKey: '', models: [{ id: 'openai/gpt-4o-mini' }], modelsCarriedBy: modelsCacheKey('openrouter', 'https://openrouter.ai') })
    const result = gate(state({ presetId: 'openrouter', prompt: 'hi', selected: ['openai/gpt-4o-mini'] }), s, PRESET_FIXTURES[1]!, 'https://openrouter.ai')
    expect(result.canRun).toBe(false)
    expect(result.why).toContain('API key')
  })

  it('allows a custom endpoint run without any key', () => {
    const s = session({ apiKey: '', models: [{ id: 'm' }], modelsCarriedBy: modelsCacheKey('custom', 'http://localhost:8787') })
    const result = gate(state({ prompt: 'hi', selected: ['m'] }), s)
    expect(result.canRun).toBe(true)
  })

  it('forces a reload when the provider or URL changed after loading', () => {
    const s = session({ apiKey: 'k', models: [{ id: 'm' }], modelsCarriedBy: modelsCacheKey('custom', 'http://old') })
    const result = gate(state({ prompt: 'hi', selected: ['m'] }), s)
    expect(result.canRun).toBe(false)
    expect(result.why).toContain('provider changed')
  })

  it('requires a prompt and at least one selected, known model', () => {
    let s = session({ apiKey: 'k', models: [{ id: 'm' }], modelsCarriedBy: modelsCacheKey('custom', 'http://localhost:8787') })
    expect(gate(state({ prompt: '', selected: ['m'] }), s).canRun).toBe(false)
    expect(gate(state({ prompt: 'hi', selected: [] }), s).canRun).toBe(false)
    expect(gate(state({ prompt: 'hi', selected: ['ghost'] }), s).canRun).toBe(false)
    expect(gate(state({ prompt: 'hi', selected: ['m'] }), s).canRun).toBe(true)
  })

  it('blocks a sheet run while there are no rows', () => {
    const s = session({ apiKey: 'k', models: [{ id: 'm' }], modelsCarriedBy: modelsCacheKey('custom', 'http://localhost:8787') })
    const result = gate(state({ prompt: 'hi', source: { kind: 'sheet', template: 'x', name: 's' }, selected: ['m'] }), s)
    expect(result.canRun).toBe(false)
    expect(result.why).toContain('prompt first') // write-a-prompt covers source emptiness too
  })

  it('does not gate staging steps', () => {
    expect(stageGate(1, { state: state(), session: session(), preset: PRESET_FIXTURES[2]!, baseUrl: 'x', contractOk: true }).ok).toBe(true)
  })
})
