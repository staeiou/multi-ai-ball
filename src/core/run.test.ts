import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildRunSpecs, shouldStream, RunController } from './run'
import { presetById } from './providers'
import type { CallResult, RowProgress, RunSpec } from './types'

afterEach(() => {
  vi.unstubAllGlobals()
})

function spec(model: string, stream = true): RunSpec {
  const openai = presetById('openai-chat')
  return {
    provider: openai.provider,
    apiKey: 'sk-test',
    model,
    params: {},
    prompt: 'Hello',
    system: '',
    stream,
    zdr: false,
    caseLabel: 'Input',
    bindings: {},
    repeatIndex: 0,
  }
}

const RESPONSE = { choices: [{ message: { role: 'assistant', content: 'ok' } }] }

function controller(options: Partial<ConstructorParameters<typeof RunController>[0]> = {}): RunController {
  return new RunController({
    concurrency: 2,
    retry: { maxRetries: 0, backoffMultiplier: 1, baseDelayMs: 1, maxDelayMs: 5 },
    timeoutMs: 5000,
    streamThreshold: 25,
    inputTokens: [10, 10, 10, 10],
    pricing: [null, null, null, null],
    assumedOutputTokens: 512,
    ...options,
  })
}

describe('RunController', () => {
  it('runs every spec and reports results in order', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify(RESPONSE), { headers: { 'Content-Type': 'application/json' } }),
    ))
    const run = controller({ concurrency: 4, inputTokens: [10, 10], pricing: [null, null] })
    const specs = [spec('a', false), spec('b', false)]
    const updates: Array<[number, CallResult]> = []
    const outcome = await run.start(specs, (i, r) => updates.push([i, r]), () => {})
    expect(outcome.results.map(r => r.status)).toEqual(['ok', 'ok'])
    expect(updates.map(u => u[0])).toEqual([0, 1])
  })

  it('never exceeds the concurrency cap', async () => {
    let inFlight = 0
    let peak = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(r => setTimeout(r, 20))
      inFlight--
      return new Response(JSON.stringify(RESPONSE), { headers: { 'Content-Type': 'application/json' } })
    }))
    const run = controller({ concurrency: 2, inputTokens: [10, 10, 10, 10], pricing: [null, null, null, null] })
    const specs = [spec('a'), spec('b'), spec('c'), spec('d')]
    await run.start(specs, () => {}, () => {})
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('abort() stops outstanding work and flags the outcome', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 200))
      throw new DOMException('aborted', 'AbortError')
    }))
    const run = controller({ concurrency: 1 })
    const promise = run.start([spec('a'), spec('b')], () => {}, () => {})
    setTimeout(() => run.abort(), 30)
    const outcome = await promise
    expect(outcome.aborted).toBe(true)
    expect(outcome.results.every(r => r.status === 'error' || r.status === 'pending')).toBe(true)
  })

  it('streams progress through the callback', async () => {
    const reader = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'))
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'))
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(reader, { headers: { 'Content-Type': 'text/event-stream' } })))
    const run = controller({ concurrency: 1, inputTokens: [10], pricing: [null] })
    const progress: Array<RowProgress> = []
    await run.start([spec('a', true)], () => {}, (_i, p) => progress.push(p))
    expect(progress.length).toBeGreaterThan(0)
    expect(progress[0]!.text).toBe('Hel')
    expect(progress[progress.length - 1]!.text).toBe('Hello')
  })
})

describe('shouldStream', () => {
  it('streams small runs only', () => {
    expect(shouldStream(10, 25)).toBe(true)
    expect(shouldStream(100, 25)).toBe(false)
  })
})

describe('buildRunSpecs', () => {
  it('expands models × cases × repeats into the spec matrix', async () => {
    const openai = presetById('openai-chat')
    const plan = {
      source: { kind: 'single' as const },
      template: 'Rate: {{x}}',
      systemTemplate: '',
      cases: [{ id: 'case0', label: 'Input', bindings: { x: 5 } }],
    }
    const { specs, inputTokens } = await buildRunSpecs({
      provider: openai.provider,
      apiKey: 'sk-test',
      models: [{ id: 'gpt-4o-mini', supportedParams: ['temperature'] }, { id: 'gpt-4o', supportedParams: [] }],
      selected: ['gpt-4o-mini', 'gpt-4o'],
      repeats: 2,
      params: { temperature: 0.7, maxTokens: 100 },
      zdr: false,
      stream: true,
      streamThreshold: 100,
      plan,
      contractAuthoring: { fields: [{ name: 'score', type: 'number' }], strictJson: true },
      contractPlacement: 'system-after',
      strictJson: true,
    })
    expect(specs.map(s => s.model)).toEqual(['gpt-4o-mini', 'gpt-4o-mini', 'gpt-4o', 'gpt-4o'])
    expect(specs.map(s => s.repeatIndex)).toEqual([0, 1, 0, 1])
    expect(specs[0].prompt).toBe('Rate: 5')
    expect(specs[0].stream).toBe(true)
    // Supported-parameter gate is carried into the spec.
    expect(specs[0].supportedParams).toEqual(['temperature'])
    expect(inputTokens).toHaveLength(4)
  })

  it('compiles the output contract into the prompt channels and wire params', async () => {
    const openai = presetById('openai-chat')
    const plan = {
      source: { kind: 'single' as const },
      template: 'Rate it',
      systemTemplate: 'You are a grader.',
      cases: [{ id: 'case0', label: 'Input', bindings: {} }],
    }
    const { specs } = await buildRunSpecs({
      provider: openai.provider,
      apiKey: 'sk-test',
      models: [{ id: 'gpt-4o-mini' }],
      selected: ['gpt-4o-mini'],
      repeats: 1,
      params: {},
      zdr: false,
      stream: true,
      streamThreshold: 100,
      plan,
      contractAuthoring: { fields: [{ name: 'score', type: 'number' }], strictJson: true },
      contractPlacement: 'system-after',
      strictJson: true,
    })
    expect(specs[0].system).toContain('<output-format>')
    expect(specs[0].system).toContain('- score (number)')
    expect(specs[0].extraParams?.['response_format.type']).toBe('json_schema')
  })

  it('never streams beyond the threshold and renders per-row bindings for sheets', async () => {
    const openai = presetById('openai-chat')
    const plan = {
      source: { kind: 'sheet', template: 'Hi {{name}}', name: 's' } as const,
      template: 'Hi {{name}}',
      systemTemplate: '',
      cases: [
        { id: 'row0', label: 'Row 1', bindings: { name: 'Ann' } },
        { id: 'row1', label: 'Row 2', bindings: { name: 'Bob' } },
      ],
    }
    const { specs, inputTokens } = await buildRunSpecs({
      provider: openai.provider,
      apiKey: '',
      models: [],
      selected: ['x'],
      repeats: 1,
      params: {},
      zdr: false,
      stream: true,
      streamThreshold: 1,
      plan,
      contractAuthoring: null,
      contractPlacement: 'none',
      strictJson: true,
    })
    expect(specs.map(s => s.prompt)).toEqual(['Hi Ann', 'Hi Bob'])
    expect(specs.map(s => s.stream)).toEqual([false, false])
    expect(specs.map(s => s.caseLabel)).toEqual(['Row 1', 'Row 2'])
    expect(inputTokens).toHaveLength(2)
  })
})