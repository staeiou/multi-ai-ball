// Composition root: the store, the actions, six screens, the wizard. Every
// screen renders its structure once and refreshes derived regions when the
// store notifies; inputs own their text and are rewritten only on restore.

import '../styles.css'
import './styles.css'

import { Actions } from './actions'
import { h } from './dom'
import { stageGate } from './model'
import { buildModelsScreen } from './screens/models'
import { buildOutputScreen } from './screens/output'
import { buildDataScreen } from './screens/data'
import { buildInstructionsScreen } from './screens/instructions'
import { buildResultsScreen } from './screens/results'
import { buildReviewScreen } from './screens/review'
import { buildSettingsScreen } from './screens/settings'
import type { Screen } from './screens/screen'
import { Store } from './store'
import { Wizard } from './wizard'
import { countTokens } from '../core/tokenizer'

const store = new Store()
let wizard: Wizard | null = null
const actions = new Actions(store, step => wizard?.goTo(step))

function brand(): HTMLElement {
  return h('h1', { class: 'brand' }, 'Mult', h('span', { class: 'frac', 'aria-label': 'A/I' }, h('span', { class: 'frac-num' }, 'A'), h('span', { class: 'frac-slash' }), h('span', { class: 'frac-den' }, 'I')), 'Ball')
}

function init(): void {
  const root = document.querySelector('#app')
  if (!root) throw new Error('missing #app')

  const screens: Screen[] = []
  const data = buildDataScreen(store, actions)
  const instructions = buildInstructionsScreen(store)
  const output = buildOutputScreen(store, () => { for (const s of screens) s.restore?.({ state: store.state, session: store.session }) })
  const models = buildModelsScreen(store, actions)
  const settings = buildSettingsScreen(store)
  const review = buildReviewScreen(store, actions)
  const results = buildResultsScreen(store, actions)
  screens.push(data, instructions, output, models, settings, review, results)

  const nav = h('nav', { class: 'wizard-nav', 'aria-label': 'Steps' })
  const dark = h('input', { type: 'checkbox' })
  dark.checked = store.state.dark
  dark.addEventListener('change', () => store.update(d => { d.state.dark = dark.checked }))
  const back = h('button', { class: 'btn', type: 'button' }, '← Back')
  const blocker = h('p', { class: 'wizard-blocker', hidden: true })
  const next = h('button', { class: 'btn primary wizard-next', type: 'button' }, 'Next →')

  root.replaceChildren(
    h('header', { class: 'app-header' }, brand(), nav, h('div', { class: 'header-utils row' }, h('label', { class: 'checkbox-row' }, dark, ' Dark'))),
    h('main', { class: 'app-main' },
      ...screens.map((screen, step) => h('div', { class: 'step', 'data-step': String(step) }, screen.el)),
      h('div', { class: 'wizard-buttons' }, back, blocker, next),
    ),
    h('footer', { class: 'app-footer' }, h('p', {}, 'Your key goes only to the provider you pick, straight from this page. Runs are saved in this browser as they progress; exports are yours to keep.')),
  )

  wizard = new Wizard({
    nav, back, next, blocker,
    gate: step => {
      const gate = stageGate(step, { state: store.state, session: store.session })
      return { ok: gate.ok, why: gate.why, canRun: false }
    },
    onStep: step => { screens[step]?.refresh({ state: store.state, session: store.session }) },
  })

  const applyTheme = (): void => { document.documentElement.dataset.theme = store.state.dark ? 'dark' : 'light' }
  applyTheme()
  store.subscribe(data => {
    applyTheme()
    const step = wizard?.step() ?? 0
    // Only the visible screen re-renders; the rest catch up when shown.
    screens[step]?.refresh(data)
    wizard?.refresh()
  })
  for (const s of screens) s.restore?.({ state: store.state, session: store.session })
  screens[0]!.refresh({ state: store.state, session: store.session })
  // Start the tokenizer worker now so the first real count is fast.
  void countTokens('warm up')
}

init()
