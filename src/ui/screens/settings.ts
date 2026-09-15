// Screen 5: settings, in words. Four things about the answers, three about
// the run. Each applies to every chosen model in that model's own terms; the
// Check screen shows what each model actually receives.

import type { ResponseFormatChoice } from '../../core/types'
import { h } from '../dom'
import type { AppData, Store } from '../store'
import type { Screen } from './screen'

const TEMPERATURE_WORDS: Array<[string, number | null, string]> = [
  ['default', null, 'Let each model use its own default (recommended)'],
  ['focused', 0.2, 'Focused: as repeatable as the model allows'],
  ['balanced', 0.7, 'Balanced'],
  ['creative', 1.0, 'Creative: more variety between answers'],
]

export function buildSettingsScreen(store: Store): Screen {
  const outputLength = h('input', { class: 'input', type: 'number', min: '1', step: '64', placeholder: 'model default', 'data-field': 'outputLength' })
  const temperatureWords = h('select', { class: 'input', 'data-field': 'temperatureWords' }, ...TEMPERATURE_WORDS.map(([key, , label]) => h('option', { value: key }, label)), h('option', { value: 'exact' }, 'An exact number…'))
  const temperature = h('input', { class: 'input', type: 'number', min: '0', max: '2', step: '0.1', placeholder: '0 to 2', 'data-field': 'temperature' })
  const temperatureField = h('label', { class: 'param-field' }, h('span', {}, 'Exact temperature'), temperature)
  const effort = h('select', { class: 'input', 'data-field': 'effort' },
    h('option', { value: '' }, 'Let each model decide (recommended)'),
    h('option', { value: 'less' }, 'Less thinking: faster and cheaper'),
    h('option', { value: 'more' }, 'More thinking: slower, often better on hard tasks'))
  const format = h('select', { class: 'input', 'data-field': 'responseFormat' },
    h('option', { value: 'auto' }, 'Automatic: enforce the fields where the model supports it (recommended)'),
    h('option', { value: 'none' }, 'Do not enforce; rely on the instructions alone'),
    h('option', { value: 'schema' }, 'Enforce on every model (a model that cannot will error)'),
    h('option', { value: 'json_object' }, 'Ask for JSON but do not enforce the fields'))
  const repeats = h('input', { class: 'input', type: 'number', min: '1', max: '100', 'data-field': 'repeats' })
  const concurrency = h('input', { class: 'input', type: 'number', min: '1', max: '32', 'data-field': 'concurrency' })
  const retries = h('input', { class: 'input', type: 'number', min: '0', max: '5', 'data-field': 'retries' })
  const timeout = h('input', { class: 'input', type: 'number', min: '10', max: '600', step: '10', 'data-field': 'timeout' })

  const el = h('section', { class: 'card stage-card settings-stage' },
    h('div', { class: 'stage-heading' }, h('h2', {}, 'Settings'), h('p', {}, 'The defaults are fine for most runs. Whatever you choose applies to every model in that model\'s own terms; the next screen shows exactly what each one gets.')),
    h('div', { class: 'settings-grid' },
      h('section', { class: 'settings-panel' }, h('h3', {}, 'The answers'),
        h('label', { class: 'param-field' }, h('span', {}, 'Longest answer allowed (in tokens; a token is about four letters)'), outputLength),
        h('p', { class: 'muted small' }, '2048 is a few paragraphs. Models that think before answering use this budget for thinking too; if answers come back empty, raise it.'),
        h('label', { class: 'param-field' }, h('span', {}, 'How much variety between answers'), temperatureWords),
        temperatureField,
        h('p', { class: 'muted small' }, 'This is the "temperature" setting. Some newer models only accept their default; they are left alone automatically.'),
        h('label', { class: 'param-field' }, h('span', {}, 'How long models that reason may think'), effort),
        h('p', { class: 'muted small' }, 'Only models with a thinking dial are affected; "less" and "more" mean each model\'s own lowest and highest setting.'),
        h('label', { class: 'param-field' }, h('span', {}, 'Making the model stick to the fields'), format),
        h('p', { class: 'muted small' }, 'The instructions always describe the fields. This adds provider-side enforcement where it exists, so the answer cannot come back in the wrong shape.'),
      ),
      h('section', { class: 'settings-panel' }, h('h3', {}, 'The run'),
        h('label', { class: 'param-field' }, h('span', {}, 'Ask each model the same case this many times'), repeats),
        h('p', { class: 'muted small' }, 'More than once shows how stable a model\'s answers are. Multiplies the cost.'),
        h('label', { class: 'param-field' }, h('span', {}, 'Calls in flight at the same time'), concurrency),
        h('label', { class: 'param-field' }, h('span', {}, 'Retries when a provider is busy'), retries),
        h('label', { class: 'param-field' }, h('span', {}, 'Give up on a call after (seconds)'), timeout),
      ),
    ),
  )

  const num = (input: HTMLInputElement, min: number, max: number, fallback: number): number => Math.max(min, Math.min(max, Number(input.value) || fallback))
  outputLength.addEventListener('change', () => store.update(d => { d.state.shared.outputLength = outputLength.value.trim() === '' ? null : Math.max(1, Math.round(Number(outputLength.value) || 2048)) }))
  temperatureWords.addEventListener('change', () => {
    const chosen = TEMPERATURE_WORDS.find(([key]) => key === temperatureWords.value)
    if (chosen) store.update(d => { d.state.shared.temperature = chosen[1] })
    temperatureField.hidden = temperatureWords.value !== 'exact'
    if (temperatureWords.value === 'exact') temperature.focus()
  })
  temperature.addEventListener('change', () => store.update(d => { d.state.shared.temperature = temperature.value.trim() === '' ? null : Math.max(0, Math.min(2, Number(temperature.value) || 0)) }))
  effort.addEventListener('change', () => store.update(d => { d.state.shared.effort = effort.value || null }))
  format.addEventListener('change', () => store.update(d => { d.state.shared.responseFormat = format.value as ResponseFormatChoice }))
  repeats.addEventListener('change', () => store.update(d => { d.state.repeats = num(repeats, 1, 100, 1) }))
  concurrency.addEventListener('change', () => store.update(d => { d.state.concurrency = num(concurrency, 1, 32, 6) }))
  retries.addEventListener('change', () => store.update(d => { d.state.retries = num(retries, 0, 5, 2) }))
  timeout.addEventListener('change', () => store.update(d => { d.state.timeoutMs = num(timeout, 10, 600, 120) * 1000 }))

  function restore(data: AppData): void {
    const t = data.state.shared.temperature
    outputLength.value = data.state.shared.outputLength === null ? '' : String(data.state.shared.outputLength)
    const word = TEMPERATURE_WORDS.find(([, value]) => value === t)
    temperatureWords.value = word ? word[0] : 'exact'
    temperatureField.hidden = temperatureWords.value !== 'exact'
    temperature.value = t === null ? '' : String(t)
    effort.value = data.state.shared.effort && ['less', 'more'].includes(data.state.shared.effort) ? data.state.shared.effort : data.state.shared.effort ? 'more' : ''
    format.value = data.state.shared.responseFormat
    repeats.value = String(data.state.repeats)
    concurrency.value = String(data.state.concurrency)
    retries.value = String(data.state.retries)
    timeout.value = String(Math.round(data.state.timeoutMs / 1000))
  }
  restore({ state: store.state, session: store.session })
  return { el, refresh: () => {}, restore }
}
