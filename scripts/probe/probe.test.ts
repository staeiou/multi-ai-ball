// Live probe. See README.md in this directory. Opt-in: MULTIAIBALL_LIVE_PROBE=1
// and provider keys in the environment (source the secrets file; never print).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { runCall } from '../../src/core/api'
import { fetchCatalog } from '../../src/core/catalog'
import { buildContractContext } from '../../src/core/contract'
import { buildFrozenModel } from '../../src/core/providers/build'
import { manualCatalogModel } from '../../src/core/providers/guidance'
import { PRESETS } from '../../src/core/providers/presets'
import { renderCall } from '../../src/core/render'
import type { CatalogModel, FrozenRun, ProviderId, SharedParams } from '../../src/core/types'
import targets from './targets.json'

const enabled = process.env.MULTIAIBALL_LIVE_PROBE === '1'
// 512, not 64: a small cap starves reasoning models into an empty answer that
// looks like a refusal (measured 2026-09-15 on openai/gpt-5-nano via OpenRouter).
const BASE: SharedParams = { outputLength: 512, temperature: null, effort: null, responseFormat: 'none' }
const CONTRACT = buildContractContext({ fields: [{ name: 'answer', type: 'string' }] })

interface Variant {
  name: string
  shared: SharedParams
  extras?: Record<string, unknown>
  contract: boolean
  /** Guidance field this variant tests, for the candidate-exception logic. */
  tests?: 'temperature' | 'effortValues' | 'structuredOutput'
}

const VARIANTS: Variant[] = [
  { name: 'basic default', shared: BASE, contract: false },
  { name: 'temperature 0.3', shared: { ...BASE, temperature: 0.3 }, contract: false, tests: 'temperature' },
  { name: 'effort low', shared: { ...BASE, effort: 'low' }, contract: false, tests: 'effortValues' },
  { name: 'schema forced', shared: { ...BASE, responseFormat: 'schema' }, contract: true, tests: 'structuredOutput' },
  { name: 'unknown key', shared: BASE, extras: { verbosityy: 'low' }, contract: false },
]

interface Record_ {
  provider: string
  model: string
  variant: string
  sent: string[]
  status: number | undefined
  ok: boolean
  error?: string
  excerpt?: string
  candidate?: string
}

describe.skipIf(!enabled)('live probe: the app\'s own bodies against real endpoints', () => {
  it('records what each provider answered', async () => {
    const records: Record_[] = []
    const ran: string[] = []
    const skipped: string[] = []
    for (const preset of PRESETS) {
      if (preset.id === 'custom') continue
      const key = process.env[preset.auth.envVar]
      if (!key) { skipped.push(preset.id); continue }
      ran.push(preset.id)
      const wanted = (targets as Record<string, string[]>)[preset.id] ?? []
      let catalog: CatalogModel[] = []
      try { catalog = await fetchCatalog(preset, preset.baseUrl, key) } catch (error) { records.push({ provider: preset.id, model: '*', variant: 'catalog', sent: [], status: undefined, ok: false, error: (error as Error).message }); continue }
      for (const id of wanted) {
        const model = catalog.find(m => m.id === id) ?? manualCatalogModel(preset.id as ProviderId, id)
        const inCatalog = catalog.some(m => m.id === id)
        for (const variant of VARIANTS) {
          const frozenModel = buildFrozenModel({ preset, baseUrl: preset.baseUrl, model, shared: variant.shared, settings: { extras: variant.extras ?? {} }, contract: variant.contract ? CONTRACT : null, hasSystem: false })
          const run: FrozenRun = {
            version: 1, frozenAt: new Date().toISOString(), source: null, roles: {}, partition: { examples: [], targets: [0], ambiguous: [] },
            cases: [{ ordinal: 0, label: 'probe', bindings: {} }], systemTemplate: '', itemTemplate: 'Say hi', constantBlock: '', constantBlockTokens: 0,
            contract: variant.contract ? CONTRACT!.contract : null, parserId: null, models: [frozenModel], repeats: 1, concurrency: 1, retries: 0, timeoutMs: 60_000,
          }
          const call = renderCall(run, { caseIndex: 0, modelIndex: 0, repeat: 0 })
          const outcome = await runCall(call, frozenModel, { apiKey: key, retry: { maxRetries: 0, backoffMultiplier: 1, baseDelayMs: 1, maxDelayMs: 1 }, timeoutMs: 60_000 })
          const sent = frozenModel.report.filter(r => r.sent).map(r => r.param)
          const record: Record_ = {
            provider: preset.id, model: `${id}${inCatalog ? '' : ' (not in catalog)'}`, variant: variant.name, sent,
            status: outcome.httpStatus, ok: outcome.status === 'ok', error: outcome.error, excerpt: (outcome.raw ?? '').slice(0, 160),
          }
          // Guidance said the shared control applies, the provider refused: a candidate exception.
          const starved = /max_tokens|output limit|answer length/i.test(outcome.error ?? '')
          if (variant.tests && !starved && outcome.status === 'error' && outcome.httpStatus && outcome.httpStatus >= 400 && outcome.httpStatus < 500) {
            const claimed = variant.tests === 'temperature' ? model.guidance.temperature.value === true
              : variant.tests === 'effortValues' ? (model.guidance.effortValues.value ?? []).includes('low')
                : model.guidance.structuredOutput.value === true
            if (claimed) record.candidate = JSON.stringify({ provider: preset.id, models: [id], guidance: variant.tests === 'temperature' ? { temperature: false } : variant.tests === 'effortValues' ? { effortValues: null } : { structuredOutput: false }, note: `probe ${new Date().toISOString().slice(0, 10)}: HTTP ${outcome.httpStatus} ${outcome.error}`, expiresWhen: 'a re-run of the probe answers 2xx' })
          }
          records.push(record)
          console.log(`${preset.id.padEnd(11)} ${id.padEnd(40)} ${variant.name.padEnd(16)} ${String(outcome.httpStatus ?? '-').padEnd(4)} ${outcome.status === 'ok' ? 'ok' : (outcome.error ?? '').slice(0, 90)}`)
        }
      }
    }
    const dir = join(process.cwd(), 'tmp', 'probe')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `results-${new Date().toISOString().slice(0, 10)}.json`)
    writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), ran, skipped, variants: VARIANTS.map(v => v.name), records }, null, 2))
    console.log(`\nran ${ran.length} of ${PRESETS.length - 1} keyed providers (${ran.join(', ')}${skipped.length ? `; no key: ${skipped.join(', ')}` : ''}); ${records.length} calls; written to ${file}`)
    const candidates = records.filter(r => r.candidate)
    if (candidates.length) {
      console.log('\nCANDIDATE EXCEPTIONS (a person decides; nothing is written to src/):')
      for (const c of candidates) console.log(c.candidate)
    }
    expect(records.length).toBeGreaterThan(0)
  })
})
