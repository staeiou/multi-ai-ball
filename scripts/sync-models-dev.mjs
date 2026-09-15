#!/usr/bin/env node
// Vendors the models.dev registry subset this app reads: the `openai` and
// `anthropic` provider sections, trimmed to the fields the guidance layer
// uses. OpenRouter is not vendored; its live catalog is the authority for its
// own models. Run: npm run sync:models-dev
//
// models.dev is MIT-licensed reported profile data. It is advice to the form
// (starting values, offered effort values, schema default); it never removes
// a control and a provider 400 is always the final word.
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = process.env.MODELS_DEV_URL ?? 'https://models.dev/api.json'
const PROVIDERS = ['openai', 'anthropic']
const out = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'src', 'data', 'models-dev.json')

const res = await fetch(SOURCE)
if (!res.ok) throw new Error(`models.dev fetch failed: HTTP ${res.status}`)
const all = await res.json()

const trimmed = { fetchedAt: new Date().toISOString(), source: SOURCE, providers: {} }
for (const provider of PROVIDERS) {
  const models = all[provider]?.models ?? {}
  const kept = {}
  for (const [id, m] of Object.entries(models)) {
    kept[id] = {
      name: m.name,
      temperature: typeof m.temperature === 'boolean' ? m.temperature : null,
      reasoning: typeof m.reasoning === 'boolean' ? m.reasoning : null,
      reasoning_options: Array.isArray(m.reasoning_options) ? m.reasoning_options : [],
      structured_output: typeof m.structured_output === 'boolean' ? m.structured_output : null,
      limit: { context: m.limit?.context ?? null, output: m.limit?.output ?? null },
      cost: m.cost ? { input: m.cost.input ?? null, output: m.cost.output ?? null } : null,
      release_date: m.release_date ?? null,
      last_updated: m.last_updated ?? null,
    }
  }
  trimmed.providers[provider] = kept
}
writeFileSync(out, JSON.stringify(trimmed, null, 2) + '\n')
console.log(`Wrote ${out}: ${PROVIDERS.map(p => `${p}=${Object.keys(trimmed.providers[p]).length}`).join(', ')}`)
