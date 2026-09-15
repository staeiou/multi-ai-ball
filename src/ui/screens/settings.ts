// Screen 4: run settings. Four shared controls that apply to every selected
// model only where that model is reported to take them, plus how many times
// and how fast. The review screen shows, per model, what actually goes.

import { h } from '../dom'
import type { AppData, Store } from '../store'
import type { Screen } from './screen'
import type { ResponseFormatChoice } from '../../core/types'

const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function buildSettingsScreen(store: Store): Screen {
  const outputLength = h('input', { class: 'input', type: 'number', min: '1', step: '64', placeholder: 'endpoint default', 'data-field': 'outputLength' })
  const temperature = h('input', { class: 'input', type: 'number', min: '0', max: '2', step: '0.1', placeholder: 'not set', 'data-field': 'temperature' })
  const effort = h('select', { class: 'input', 'data-field': 'effort' }, h('option', { value: '' }, 'not set'), ...EFFORTS.map(e => h('option', { value: e }, e)))
  const format = h('select', { class: 'input', 'data-field': 'responseFormat' },
    h('option', { value: 'auto' }, 'Automatic: JSON schema where the model is reported to take it'),
    h('option', { value: 'schema' }, 'JSON schema on every model (a model that lacks it will error)'),
    h('option', { value: 'json_object' }, 'JSON object: valid JSON, shape not enforced'),
    h('option', { value: 'none' }, 'No format parameter (instructions in the prompt only)'))
  const repeats = h('input', { class: 'input', type: 'number', min: '1', max: '100', 'data-field': 'repeats' })
  const concurrency = h('input', { class: 'input', type: 'number', min: '1', max: '32', 'data-field': 'concurrency' })
  const retries = h('input', { class: 'input', type: 'number', min: '0', max: '5', 'data-field': 'retries' })
  const timeout = h('input', { class: 'input', type: 'number', min: '10', max: '600', step: '10', 'data-field': 'timeout' })

  const el = h('section', { class: 'card stage-card settings-stage' },
    h('div', { class: 'stage-heading' }, h('h2', {}, 'Run settings'), h('p', {}, 'Shared across the selected models. A model that is not reported to take a setting simply does not receive it; the review screen shows which.')),
    h('div', { class: 'settings-grid' },
      h('section', { class: 'settings-panel' }, h('h3', {}, 'What the model may produce'),
        h('label', { class: 'param-field' }, h('span', {}, 'Maximum answer length (tokens)'), outputLength),
        h('p', { class: 'muted small' }, 'Roughly four characters per token. Blank leaves each endpoint\'s own default (Anthropic requires a value; 2048 is used).'),
        h('label', { class: 'param-field' }, h('span', {}, 'Temperature'), temperature),
        h('p', { class: 'muted small' }, '0 is most repeatable, 1 is the usual default, 2 is wild. Blank sends nothing, so each model uses its own default. Many current reasoning models accept only their default; they are skipped automatically.'),
        h('label', { class: 'param-field' }, h('span', {}, 'Reasoning effort'), effort),
        h('p', { class: 'muted small' }, 'How long a reasoning model may think before answering. Sent only to models that list the chosen level.'),
        h('label', { class: 'param-field' }, h('span', {}, 'Response format'), format),
        h('p', { class: 'muted small' }, 'The output-format instructions are always in the prompt; this decides whether the schema is also enforced by the provider.'),
      ),
      h('section', { class: 'settings-panel' }, h('h3', {}, 'How the run proceeds'),
        h('label', { class: 'param-field' }, h('span', {}, 'Repeats per case'), repeats),
        h('p', { class: 'muted small' }, 'Ask each model the same case this many times, to see how stable its answers are.'),
        h('label', { class: 'param-field' }, h('span', {}, 'Calls in flight at once'), concurrency),
        h('label', { class: 'param-field' }, h('span', {}, 'Retries after a rate limit or server error'), retries),
        h('label', { class: 'param-field' }, h('span', {}, 'Give up on a call after (seconds)'), timeout),
      ),
    ),
  )

  const num = (input: HTMLInputElement, min: number, max: number, fallback: number): number => Math.max(min, Math.min(max, Number(input.value) || fallback))
  outputLength.addEventListener('change', () => store.update(d => { d.state.shared.outputLength = outputLength.value.trim() === '' ? null : Math.max(1, Math.round(Number(outputLength.value) || 2048)) }))
  temperature.addEventListener('change', () => store.update(d => { d.state.shared.temperature = temperature.value.trim() === '' ? null : Math.max(0, Math.min(2, Number(temperature.value) || 0)) }))
  effort.addEventListener('change', () => store.update(d => { d.state.shared.effort = effort.value || null }))
  format.addEventListener('change', () => store.update(d => { d.state.shared.responseFormat = format.value as ResponseFormatChoice }))
  repeats.addEventListener('change', () => store.update(d => { d.state.repeats = num(repeats, 1, 100, 1) }))
  concurrency.addEventListener('change', () => store.update(d => { d.state.concurrency = num(concurrency, 1, 32, 6) }))
  retries.addEventListener('change', () => store.update(d => { d.state.retries = num(retries, 0, 5, 2) }))
  timeout.addEventListener('change', () => store.update(d => { d.state.timeoutMs = num(timeout, 10, 600, 120) * 1000 }))

  function restore(data: AppData): void {
    outputLength.value = data.state.shared.outputLength === null ? '' : String(data.state.shared.outputLength)
    temperature.value = data.state.shared.temperature === null ? '' : String(data.state.shared.temperature)
    effort.value = data.state.shared.effort ?? ''
    format.value = data.state.shared.responseFormat
    repeats.value = String(data.state.repeats)
    concurrency.value = String(data.state.concurrency)
    retries.value = String(data.state.retries)
    timeout.value = String(Math.round(data.state.timeoutMs / 1000))
  }
  restore({ state: store.state, session: store.session })
  return { el, refresh: () => {}, restore }
}
