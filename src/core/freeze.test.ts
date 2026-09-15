import { describe, expect, it } from 'vitest'

import { compileConstantBlock, exampleOutput } from './examples'
import { freezeRun, templateProblems, totalCalls } from './freeze'
import { columnsOf, defaultRoles, inferPartition } from './partition'
import { presetById } from './providers/presets'
import { canonicalJson, coordinateAt, indexOf, renderCall, sha256Hex } from './render'
import { GPT41_LIKE, GPT_LIKE, ROLES, ROWS } from './testing/fixtures'

const CONTRACT = { fields: [{ name: 'frame', type: 'enum' as const, values: ['economic', 'civic'] }, { name: 'score', type: 'integer' as const, min: 1, max: 5 }] }

describe('partition', () => {
  it('splits by output-column sparsity: full = example, blank = target, partial = ambiguous', () => {
    expect(inferPartition(ROWS, ROLES)).toEqual({ examples: [0, 1], targets: [2, 3], ambiguous: [4] })
  })
  it('with no output columns every row is a target', () => {
    expect(inferPartition(ROWS, defaultRoles(columnsOf(ROWS)))).toEqual({ examples: [], targets: [0, 1, 2, 3, 4], ambiguous: [] })
  })
})

describe('examples', () => {
  it('coerces human outputs by contract type and omits blanks', () => {
    expect(exampleOutput(ROWS[0]!, ROLES, CONTRACT)).toEqual({ frame: 'economic', score: 4 })
    expect(exampleOutput(ROWS[4]!, ROLES, CONTRACT)).toEqual({ frame: 'economic' })
  })
  it('renders each example as the item the model will see plus the expected JSON, then the output-format prose', () => {
    const block = compileConstantBlock({ rows: ROWS, roles: ROLES, exampleOrdinals: [1, 0], itemTemplate: 'Article: {{text}}', contract: CONTRACT })
    expect(block.indexOf('The council debated')).toBeLessThan(block.indexOf('Markets fell'))
    expect(block).toContain('<input>\nArticle: Markets fell sharply on rate fears.\n</input>')
    expect(block).toContain('{"frame":"economic","score":4}')
    expect(block).toContain('<output-format>')
    expect(block).toContain('- frame (one choice): exactly one of "economic", "civic"')
    expect(block).toContain('- score (whole number): min 1, max 5')
  })
})

describe('freezeRun and renderCall', () => {
  const input = () => ({
    preset: presetById('openai'),
    baseUrl: 'https://api.openai.com',
    source: { name: 'articles.csv', bytes: 100, sha256: 'abc', rowCount: ROWS.length },
    rows: ROWS,
    roles: ROLES,
    partition: inferPartition(ROWS, ROLES),
    systemTemplate: 'You code news frames.',
    itemTemplate: 'Article: {{text}}',
    contract: CONTRACT,
    parserId: 'json-unstack',
    models: [{ model: GPT_LIKE, settings: { extras: {} } }, { model: GPT41_LIKE, settings: { extras: {} } }],
    shared: { outputLength: 512, temperature: 0.3, effort: null, responseFormat: 'auto' as const },
    repeats: 2,
    concurrency: 4,
    retries: 1,
    timeoutMs: 1000,
  })

  it('blocks templates that reference reference, metadata, output, or missing columns', () => {
    expect(templateProblems('{{text}} {{id}} {{source}} {{frame}} {{nope}}', '', ROLES, true).map(p => p.placeholder)).toEqual(['id', 'source', 'frame', 'nope'])
    expect(templateProblems('{{text}}', '', ROLES, true)).toEqual([])
  })

  it('carries only target rows and only referenced input columns; the constant block once', async () => {
    const run = await freezeRun(input())
    expect(run.cases.map(c => c.ordinal)).toEqual([2, 3])
    expect(Object.keys(run.cases[0]!.bindings)).toEqual(['text'])
    expect(run.constantBlock).toContain('<examples>')
    expect(run.constantBlockTokens).toBeGreaterThan(0)
    expect(totalCalls(run)).toBe(2 * 2 * 2)
    expect(run.models[0]!.body).not.toHaveProperty('temperature')
    expect(run.models[1]!.body.temperature).toBe(0.3)
  })

  it('INVARIANT 1: no reference-column value appears in any rendered body', async () => {
    const run = await freezeRun(input())
    const leaks = ['A1', 'A2', 'A3', 'A4', 'A5', 'Reuters', 'Herald']
    for (let index = 0; index < totalCalls(run); index++) {
      const call = renderCall(run, coordinateAt(run, index))
      for (const leak of leaks) expect(call.bodyString.includes(`"${leak}`) || call.bodyString.includes(` ${leak}`)).toBe(false)
    }
  })

  it('renders the system channel as template + blank line + constant block, and the sentinels never survive', async () => {
    const run = await freezeRun(input())
    const call = renderCall(run, { caseIndex: 0, modelIndex: 0, repeat: 0 })
    expect(call.system.startsWith('You code news frames.\n\n<examples>')).toBe(true)
    expect(call.prompt).toBe('Article: Hospital wait times doubled.')
    expect(call.bodyString).not.toContain('{{')
    const messages = (call.body as { messages: Array<{ role: string; content: string }> }).messages
    expect(messages[0]!.role).toBe('system')
    expect(messages[1]!.content).toBe(call.prompt)
  })

  it('coordinates round-trip in case-major order', async () => {
    const run = await freezeRun(input())
    for (let index = 0; index < totalCalls(run); index++) expect(indexOf(run, coordinateAt(run, index))).toBe(index)
    expect(coordinateAt(run, 3)).toEqual({ caseIndex: 0, modelIndex: 1, repeat: 1 })
  })

  it('canonicalJson sorts keys at every level; sha256Hex is stable', async () => {
    expect(canonicalJson({ b: [{ z: 1, a: 2 }], a: 'x' })).toBe('{"a":"x","b":[{"a":2,"z":1}]}')
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
