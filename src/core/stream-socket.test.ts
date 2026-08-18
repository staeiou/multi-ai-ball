import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runCallStream } from './api'
import { presetById } from './providers'
import type { RunSpec } from './types'

let server: ReturnType<typeof createServer>
let url: string

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  url = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

function spec(): RunSpec {
  const custom = presetById('custom')
  return {
    provider: { ...custom.provider, api: { ...custom.provider.api, baseUrl: url } },
    apiKey: '',
    model: 'stub-echo',
    params: {},
    prompt: 'Hi',
    system: '',
    stream: true,
    zdr: false,
    caseLabel: 'Input',
    bindings: {},
    repeatIndex: 0,
  }
}

describe('runCallStream over a real socket', () => {
  it('accumulates SSE deltas, usage, and raw lines', async () => {
    const seen: string[] = []
    const result = await runCallStream(spec(), {
      retry: { maxRetries: 0, backoffMultiplier: 1, baseDelayMs: 1, maxDelayMs: 5 },
      timeoutMs: 5000,
      onProgress: p => seen.push(p.text),
    })
    expect(result.status).toBe('ok')
    expect(result.parts[0]).toEqual({ kind: 'text', text: 'Hello' })
    expect(result.totalTokens).toBe(8)
    const lines = (result.rawJson ?? '').split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(3)
    expect(seen[seen.length - 1]).toBe('Hello')
  })
})