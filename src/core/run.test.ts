import { afterEach, describe, expect, it, vi } from 'vitest'

import { freezeRun } from './freeze'
import { inferPartition } from './partition'
import { presetById } from './providers/presets'
import { renderCall, sha256Hex } from './render'
import { RunController, pendingRows } from './run'
import { GPT41_LIKE, ROLES, ROWS } from './testing/fixtures'
import type { FrozenRun } from './types'

afterEach(() => vi.unstubAllGlobals())

async function frozen(): Promise<FrozenRun> {
  return freezeRun({
    preset: presetById('custom'),
    baseUrl: 'http://stub',
    source: { name: 's.csv', bytes: 1, sha256: 'x', rowCount: ROWS.length },
    rows: ROWS,
    roles: ROLES,
    partition: inferPartition(ROWS, ROLES),
    systemTemplate: '',
    itemTemplate: 'Frame: {{text}}',
    contract: { fields: [{ name: 'frame', type: 'enum', values: ['economic', 'civic'] }] },
    parserId: 'json-unstack',
    models: [{ model: GPT41_LIKE, settings: { extras: {} } }],
    shared: { outputLength: 64, temperature: null, effort: null, responseFormat: 'none' },
    repeats: 1,
    concurrency: 2,
    retries: 0,
    timeoutMs: 2000,
  })
}

function ok(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('RunController', () => {
  it('INVARIANT 2: the body fetch receives is the body renderCall produced, and its hash is on the row', async () => {
    const run = await frozen()
    const sentBodies: string[] = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      sentBodies.push(String(init.body))
      return ok('{"frame": "civic"}')
    }))
    const outcome = await new RunController(run, 'k').start()
    expect(outcome.rows).toHaveLength(2)
    for (const [index, row] of outcome.rows.entries()) {
      const expected = renderCall(run, row.coord).bodyString
      expect(sentBodies).toContain(expected)
      expect(row.bodyHash).toBe(await sha256Hex(expected))
      expect(row.status).toBe('ok')
      expect(row.parsed).toEqual({ frame: 'civic' })
      expect(row.parseStatus).toBe('strict')
      expect(row.coord.caseIndex).toBe(index)
    }
  })

  it('substitutes the key into headers and drops the auth header when the key is empty', async () => {
    const run = await frozen()
    const headers: Array<Record<string, string>> = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      headers.push(init.headers as Record<string, string>)
      return ok('x')
    }))
    await new RunController(run, '').start()
    expect(headers[0]).not.toHaveProperty('Authorization')
    await new RunController(run, 'secret').start()
    expect(headers[2]!.Authorization).toBe('Bearer secret')
  })

  it('reports repaired JSON as repaired and unparseable braces as failed', async () => {
    const run = await frozen()
    let n = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => ok(n++ === 0 ? "{'frame': 'civic'}" : '{"frame": ')))
    const outcome = await new RunController({ ...run, concurrency: 1 }, 'k').start()
    expect(outcome.rows[0]!.parseStatus).toBe('repaired')
    expect(outcome.rows[1]!.parseStatus).toBe('failed')
  })

  it('records an error row with the provider message and never parses it', async () => {
    const run = await frozen()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })))
    const outcome = await new RunController(run, 'k').start()
    expect(outcome.rows[0]!.status).toBe('error')
    expect(outcome.rows[0]!.httpStatus).toBe(401)
    expect(outcome.rows[0]!.error).toContain('bad key')
    expect(outcome.rows[0]!.parseStatus).toBe('none')
  })

  it('abort stops admission and marks the rest aborted; a subset run only touches its indices', async () => {
    const run = await frozen()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>((_r, reject) => setTimeout(() => reject(new DOMException('aborted', 'AbortError')), 50))))
    const controller = new RunController({ ...run, concurrency: 1 }, 'k')
    const promise = controller.start()
    setTimeout(() => controller.abort(), 10)
    const outcome = await promise
    expect(outcome.aborted).toBe(true)
    expect(outcome.rows[0]!.error).toBe('Aborted.')
    expect(outcome.rows[1]!.status).toBe('pending')

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => ok('again')))
    const second = new RunController(run, 'k')
    const partial = await second.start([1])
    expect(partial.rows[1]!.status).toBe('ok')
    expect(partial.rows[0]!.status).toBe('pending')
  })

  it('pending rows carry a cost estimate when the model has a price', async () => {
    const run = await frozen()
    const rows = pendingRows(run)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.estimatedCostUsd).toBeGreaterThan(0)
  })
})
