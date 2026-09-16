// Screen 5: review. The run, frozen exactly as it will be sent: per model the
// first call's body, what each parameter did and why, the context check and
// the cost range. Nothing has been sent when this screen shows.

import { totalCalls } from '../../core/freeze'
import { formatUsd } from '../../core/pricing'
import { presetById } from '../../core/providers/presets'
import { coordinateAt, renderCall } from '../../core/render'
import { estimateRow } from '../../core/run'
import { naiveTokenCount } from '../../core/tokenizer'
import type { FrozenRun } from '../../core/types'
import type { Actions } from '../actions'
import { h } from '../dom'
import { canRun } from '../model'
import type { AppData, Store } from '../store'
import type { Screen } from './screen'

export function buildReviewScreen(_store: Store, actions: Actions): Screen {
  const summary = h('div', { class: 'review-summary' })
  const models = h('div', { class: 'review-models' })
  const run = h('button', { class: 'btn primary run-button review-run', type: 'button' }, 'Run it')
  const why = h('span', { class: 'muted small' })
  const el = h('section', { class: 'card stage-card review-stage' },
    h('div', { class: 'stage-heading' }, h('h2', {}, 'Check & run'), h('p', {}, 'Nothing has been sent yet. Below is exactly what will be, so you can check before spending anything.')),
    summary,
    // The button sits above the per-model details: with hundreds of models
    // those run for screens, and the summary already says what will be spent.
    h('div', { class: 'review-action' }, run, why),
    models,
  )
  let frozen: FrozenRun | null = null
  let freezing = false

  run.addEventListener('click', () => void actions.run())

  async function refreshFrozen(data: AppData): Promise<void> {
    const gate = canRun(data)
    run.disabled = !gate.ok || data.session.running
    why.textContent = gate.ok ? '' : gate.why
    if (!gate.ok) { summary.replaceChildren(h('p', { class: 'muted' }, 'Finish the earlier steps first: ' + gate.why)); models.replaceChildren(); return }
    if (freezing) return
    freezing = true
    try {
      frozen = await actions.freeze()
    } catch (error) {
      summary.replaceChildren(h('p', { class: 'contract-error' }, (error as Error).message))
      models.replaceChildren()
      frozen = null
      return
    } finally { freezing = false }
    render(frozen)
  }

  function render(f: FrozenRun): void {
    const calls = totalCalls(f)
    let low = 0, high = 0, unknown = 0
    for (let i = 0; i < calls; i++) {
      const e = estimateRow(f, i, 100000)
      const eLow = estimateRow(f, i, 10)
      if (e === null || eLow === null) { unknown++; continue }
      low += eLow
      high += e
    }
    const itemTokens = Math.max(0, ...f.cases.slice(0, 200).map(c => naiveTokenCount(f.itemTemplate + Object.values(c.bindings).join(' '))))
    summary.replaceChildren(
      item('Cases', f.source ? `${f.cases.length.toLocaleString()} rows to run (${f.partition.examples.length} worked examples${f.partition.ambiguous.length ? `, ${f.partition.ambiguous.length} skipped` : ''})` : `${f.cases.length.toLocaleString()}`),
      item('Models', f.models.length <= 8 ? f.models.map(m => m.id).join(', ') : `${f.models.length} (listed below)`),
      item('Calls', `${calls.toLocaleString()} (${f.cases.length} × ${f.models.length} × ${f.repeats} repeat${f.repeats === 1 ? '' : 's'})`),
      item('Estimated cost', unknown === calls ? 'unknown (no prices for these models)' : `~${formatUsd(low)}–${formatUsd(high)}${unknown ? ` plus ${unknown} calls with no price` : ''}`),
      item('Prompt size', `${f.constantBlockTokens.toLocaleString()} tokens shared by every call (examples + output format) + up to ~${itemTokens.toLocaleString()} per case`),
      item('Settings', `${f.concurrency} calls at once · ${f.retries} retries · ${Math.round(f.timeoutMs / 1000)}s timeout`),
    )
    models.replaceChildren(...f.models.map((m, index) => {
      const g = m.guidance
      // Providers count the answer budget against the context window, so the
      // check is prompt plus budget (a 331-character prompt with an 8192 cap
      // on an 8192-context model 400ed on 2026-09-16).
      const lengthName = g.outputLengthName ?? presetById(m.provider).outputLengthName
      const budget = typeof m.body[lengthName] === 'number' ? (m.body[lengthName] as number) : 0
      const fit = g.contextLimit.value ? f.constantBlockTokens + itemTokens + budget <= g.contextLimit.value : null
      const first = renderCall(f, coordinateAt(f, index * f.repeats))
      const table = h('table', { class: 'report-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Parameter'), h('th', {}, 'Sent'), h('th', {}, 'Why'), h('th', {}, 'Source'))),
        h('tbody', {}, ...m.report.map(r => h('tr', { class: r.sent ? 'sent' : 'omitted' },
          h('td', { class: 'mono' }, r.param), h('td', {}, r.sent ? (r.value === undefined ? 'yes' : typeof r.value === 'object' ? JSON.stringify(r.value) : String(r.value)) : 'no'), h('td', {}, r.reason), h('td', { class: 'muted small' }, r.source)))))
      return h('details', { class: 'review-model' },
        h('summary', {}, h('strong', {}, m.id), h('span', { class: 'muted small' }, ` · ${presetById(m.provider).label} · `),
          fit === null ? h('span', { class: 'muted small' }, 'context limit unknown') : fit ? h('span', { class: 'ok-text' }, `prompt and answer budget fit its ${g.contextLimit.value!.toLocaleString()}-token context`) : h('span', { class: 'preview-warn' }, `prompt plus answer budget (${budget.toLocaleString()}) may exceed its ${g.contextLimit.value!.toLocaleString()}-token context`)),
        table,
        h('p', { class: 'muted small' }, `The first call, exactly as it will be sent to ${m.url} (the payload):`),
        h('pre', { class: 'payload-code' }, JSON.stringify(first.body, null, 2)),
      )
    }))
  }

  function item(label: string, value: string): HTMLElement {
    return h('div', { class: 'review-item' }, h('span', {}, label), h('strong', {}, value))
  }

  return { el, refresh: data => void refreshFrozen(data) }
}
