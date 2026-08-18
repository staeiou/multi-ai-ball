import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_RETRY, runCall } from './api'
import { presetById } from './providers'
import type { RunSpec } from './types'

afterEach(() => {
  vi.unstubAllGlobals()
})

function spec(overrides: Partial<RunSpec> = {}): RunSpec {
  const openai = presetById('openai-chat')
  return {
    provider: openai.provider,
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
    params: { temperature: 0.4 },
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

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
  })
}

const SUCCESS = {
  choices: [{ message: { role: 'assistant', content: 'hi' } }],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
}

describe('runCall', () => {
  it('returns an ok result with parts and usage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, SUCCESS)))
    const result = await runCall(spec(), { retry: DEFAULT_RETRY, timeoutMs: 5000 })
    expect(result.status).toBe('ok')
    expect(result.parts[0]).toEqual({ kind: 'text', text: 'hi' })
    expect(result.totalTokens).toBe(3)
  })

  it('retries 429 with backoff then succeeds', async () => {
    let attempts = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      attempts++
      if (attempts === 1) return jsonResponse(429, { error: { message: 'slow down' } }, { 'retry-after': '1' })
      return jsonResponse(200, SUCCESS)
    }))
    const started = Date.now()
    const result = await runCall(spec(), { retry: { maxRetries: 2, backoffMultiplier: 2, baseDelayMs: 1000, maxDelayMs: 5000 }, timeoutMs: 5000 })
    expect(result.status).toBe('ok')
    expect(attempts).toBe(2)
    // Retry-After of ~1s is honored (not the ~4s exponential guess).
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('exhausts retries and reports the last error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => jsonResponse(503, { error: { message: 'boom' } })))
    const result = await runCall(spec(), { retry: { maxRetries: 2, backoffMultiplier: 2, baseDelayMs: 1, maxDelayMs: 5 }, timeoutMs: 5000 })
    expect(result.status).toBe('error')
    expect(result.error).toContain('boom')
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3)
  })

  it('does not retry auth or validation errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { error: { message: 'bad key' } })))
    const result = await runCall(spec(), { retry: { maxRetries: 5, backoffMultiplier: 2, baseDelayMs: 1, maxDelayMs: 5 }, timeoutMs: 5000 })
    expect(result.status).toBe('error')
    expect(result.error).toContain('bad key')
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  it('treats network failures as retryable', async () => {
    let attempts = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      attempts++
      if (attempts === 1) throw new TypeError('Failed to fetch')
      return jsonResponse(200, SUCCESS)
    }))
    const result = await runCall(spec(), { retry: { maxRetries: 2, backoffMultiplier: 2, baseDelayMs: 1, maxDelayMs: 5 }, timeoutMs: 5000 })
    expect(result.status).toBe('ok')
    expect(attempts).toBe(2)
  })

  it('never retries after an outer abort and reports Aborted', async () => {
    const retries: number[] = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }),
    ))
    const controller = new AbortController()
    const promise = runCall(spec(), {
      retry: { maxRetries: 3, backoffMultiplier: 2, baseDelayMs: 1, maxDelayMs: 5 },
      timeoutMs: 5000,
      signal: controller.signal,
      onRetry: () => retries.push(1),
    })
    setTimeout(() => controller.abort(), 10)
    const result = await promise
    expect(result.status).toBe('error')
    expect(result.error).toBe('Aborted.')
    expect(retries).toEqual([])
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })
})