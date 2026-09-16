// Screen 3: provider and models. A collapsible provider band (provider, base
// URL for custom, key, Load models) above a transfer list: available models on
// the left, selected on the right, a model on exactly one side. Each selected
// model has a gear for its own settings: response-format override, extra
// parameters, and OpenRouter routing.

import { manualCatalogModel } from '../../core/providers/guidance'
import { PRESETS, presetById } from '../../core/providers/presets'
import type { CatalogModel, ProviderId, ResponseFormatChoice } from '../../core/types'
import { loadRecent } from '../../state'
import type { Actions } from '../actions'
import { costInputs, costParts, modelCost, sortByCost, totalRange } from '../costs'
import { formatUsd } from '../../core/pricing'
import { h } from '../dom'
import { caseCount, catalogCurrent, previewConstantBlock, selectedCatalogModels, visibleCatalog } from '../model'
import type { AppData, Store } from '../store'
import type { Screen } from './screen'

export function buildModelsScreen(store: Store, actions: Actions): Screen {
  let bandOpen = true
  const preset = h('select', { class: 'input' }, ...PRESETS.map(p => h('option', { value: p.id }, p.label)))
  preset.value = store.state.providerId
  const customBase = h('input', { class: 'input', placeholder: 'Base URL, e.g. http://localhost:11434 or https://your.llm.example' })
  customBase.value = store.state.customBase
  const customBaseField = h('label', { class: 'field' }, h('span', {}, 'Base URL'), customBase)
  // This is intentionally never a password input: browsers treat a real
  // password field as a login credential and offer to save it on step change.
  // CSS masks the provider secret without advertising it to credential tools.
  const keyInput = h('input', {
    class: 'input secret-input',
    type: 'text',
    name: 'provider-api-key',
    'data-field': 'api-key',
    placeholder: 'API key',
    autocomplete: 'off',
    'data-bwignore': 'true',
    'data-1p-ignore': 'true',
    'data-lpignore': 'true',
  })
  keyInput.value = store.session.apiKey
  const remember = h('input', { type: 'checkbox' })
  remember.checked = store.state.keyRemember
  const loadBtn = h('button', { class: 'btn', type: 'button' }, 'Load models')
  const note = h('span', { class: 'muted small', 'data-field': 'loadFacts' })
  const bandState = h('span', { class: 'provider-band-state' })
  const bandHead = h('button', { class: 'provider-band-head', type: 'button' }, h('span', { class: 'provider-band-label' }, 'Provider & key'), bandState, h('span', { class: 'provider-chevron', 'aria-hidden': 'true' }, '▾'))
  const bandBody = h('div', { class: 'provider-band-body' },
    h('div', { class: 'field-grid' }, h('label', { class: 'field' }, h('span', {}, 'Provider'), preset), customBaseField, h('label', { class: 'field' }, h('span', {}, 'API key'), keyInput)),
    h('label', { class: 'checkbox-row' }, remember, ' Remember the key on this device (plain text in this browser\'s storage)'),
    h('div', { class: 'row' }, loadBtn, note),
  )
  const band = h('div', { class: 'provider-band' }, bandHead, bandBody)

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Filter the loaded models…' })
  const hideFree = h('input', { type: 'checkbox' })
  const zdr = h('input', { type: 'checkbox' })
  const zdrRow = h('label', { class: 'checkbox-row' }, zdr, ' ZDR only (OpenRouter: hide sub-providers that retain data)')
  const available = h('div', { class: 'model-list' })
  const manualId = h('input', { class: 'input', placeholder: 'Add a model by id (works even if the list is empty)' })
  const manualAdd = h('button', { class: 'btn', type: 'button' }, 'Add')
  const selected = h('div', { class: 'selected-list' })
  const listFacts = h('span', { class: 'muted small' })
  const selectedFacts = h('span', { class: 'muted small' })
  const clearSel = h('button', { class: 'minibtn', type: 'button' }, 'Clear')
  const budget = h('input', { class: 'input budget-field', type: 'number', min: '0', step: '0.01', 'aria-label': 'Budget for the whole run in dollars' })
  budget.value = '0.05'
  const addUnder = h('button', { class: 'btn', type: 'button' }, 'Add them')
  const budgetNote = h('span', { class: 'muted small budget-note' })
  const quick = h('div', { class: 'chips' })

  const layout = h('div', { class: 'models-layout' },
    h('div', { class: 'pick-col' },
      h('div', { class: 'pane-head' }, h('p', { class: 'section-label' }, 'Available'), listFacts),
      search,
      h('div', { class: 'model-filters' }, h('label', { class: 'checkbox-row' }, hideFree, ' Hide :free routes'), zdrRow),
      h('div', { class: 'model-list-wrap' }, available),
      h('div', { class: 'manual-row' }, manualId, manualAdd),
    ),
    h('div', { class: 'pane-splitter', role: 'separator', 'aria-hidden': 'true' }),
    h('div', { class: 'selected-col' },
      h('div', { class: 'pane-head' }, h('p', { class: 'section-label' }, 'Selected'), selectedFacts, clearSel),
      h('div', { class: 'selected-list-wrap' }, selected),
      h('div', { class: 'budget-row' },
        h('span', { class: 'muted small' }, 'Add the cheapest models that together keep the whole run under'),
        h('span', { class: 'budget-money' }, '$', budget),
        addUnder,
        budgetNote),
      h('div', { class: 'quick-add-block' }, quick),
    ),
  )

  const el = h('section', { class: 'card stage-card models-stage' },
    h('div', { class: 'stage-heading' }, h('h2', {}, 'Provider & models')),
    band,
    layout,
  )

  // --- listeners
  bandHead.addEventListener('click', () => { bandOpen = !bandOpen; refresh(current()) })
  preset.addEventListener('change', () => store.update(d => {
    d.state.providerId = preset.value as ProviderId
    d.state.selected = []
    d.session.catalog = []
    d.session.catalogKey = ''
    d.session.catalogNote = ''
    bandOpen = true
  }))
  customBase.addEventListener('change', () => store.update(d => {
    d.state.customBase = customBase.value.trim()
    if (d.session.catalog.length) { d.session.catalog = []; d.session.catalogKey = ''; d.session.catalogNote = 'Base URL changed: reload the model list.' }
  }))
  keyInput.addEventListener('input', () => actions.setApiKey(keyInput.value))
  remember.addEventListener('change', () => { store.update(d => { d.state.keyRemember = remember.checked }); actions.setApiKey(keyInput.value) })
  loadBtn.addEventListener('click', () => void actions.loadCatalog().then(() => { bandOpen = presetById(store.state.providerId).keyRequired && !store.session.apiKey; refresh(current()) }))
  search.addEventListener('input', () => renderAvailable(current()))
  hideFree.addEventListener('change', () => store.update(d => { d.state.hideFreeModels = hideFree.checked }))
  zdr.addEventListener('change', () => void actions.toggleZdr(zdr.checked))
  const addManual = (): void => {
    const id = manualId.value.trim()
    if (!id) return
    store.update(d => {
      if (!d.session.catalog.some(m => m.id === id)) {
        d.session.catalog.push(manualCatalogModel(d.state.providerId, id))
        if (!d.session.catalogKey) d.session.catalogKey = `${d.state.providerId}|${d.state.customBase.trim().replace(/\/+$/, '')}`
      }
      if (!d.state.selected.some(s => s.id === id)) d.state.selected.push({ id, settings: { extras: {} } })
    })
    manualId.value = ''
  }
  manualAdd.addEventListener('click', addManual)
  manualId.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); addManual() } })
  clearSel.addEventListener('click', () => store.update(d => { d.state.selected = [] }))
  // The budget is for the whole run: what is already selected counts, and
  // the cheapest unselected models are added, in cost order, while the total
  // (worst case, every answer at the output limit) stays under the figure.
  addUnder.addEventListener('click', () => {
    const data = current()
    const inputs = inputsFor(data)
    const limit = Number(budget.value) || 0
    let added = 0
    store.update(d => {
      const chosen = new Set(d.state.selected.map(s => s.id))
      let total = 0
      for (const m of data.session.catalog) if (chosen.has(m.id)) total += modelCost(m, inputs) ?? 0
      for (const m of sortByCost(visibleCatalog(data).filter(m => !chosen.has(m.id)), inputs)) {
        const cost = modelCost(m, inputs)
        if (cost === null || total + cost > limit) break
        total += cost
        added++
        d.state.selected.push({ id: m.id, settings: { extras: {} } })
      }
      budgetNote.textContent = added ? `Added ${added}.` : total >= limit ? 'Nothing added: the models already selected use the whole budget.' : 'Nothing added: no unselected model with a known price fits.'
    })
  })
  budget.addEventListener('input', () => { budgetNote.textContent = '' })

  function current(): AppData { return { state: store.state, session: store.session } }

  function inputsFor(data: AppData) {
    return costInputs(previewConstantBlock(data), data.state.prompt, data.state.system, data.state.shared.outputLength, caseCount(data) * Math.max(1, data.state.repeats))
  }

  function select(id: string, on: boolean): void {
    store.update(d => {
      if (on) { if (!d.state.selected.some(s => s.id === id)) d.state.selected.push({ id, settings: { extras: {} } }) }
      else d.state.selected = d.state.selected.filter(s => s.id !== id)
    })
  }

  function row(model: CatalogModel | undefined, id: string, side: 'available' | 'selected', data: AppData): HTMLElement {
    const arrow = h('span', { class: 'model-arrow', 'aria-hidden': 'true' }, side === 'available' ? '→' : '←')
    const label = h('span', { class: 'model-id' }, id)
    const cost = h('span', { class: 'model-cost' }, ...costCells(model, data))
    const button = h('button', { class: `model-row ${side}`, type: 'button', title: side === 'available' ? `Add ${id}` : `Remove ${id}` }, ...(side === 'available' ? [label, cost, arrow] : [arrow, label, cost]))
    button.addEventListener('click', () => select(id, side === 'available'))
    if (side === 'selected') {
      const gear = h('button', { class: 'minibtn gear', type: 'button', title: 'Settings for this model' }, '⚙')
      gear.addEventListener('click', ev => { ev.stopPropagation(); openSettings(id) })
      return h('div', { class: 'model-row-wrap' }, button, gear)
    }
    return button
  }

  /** Run cost in bold (the number a person decides on), list price plain. */
  function costCells(model: CatalogModel | undefined, data: AppData): Array<HTMLElement | string> {
    if (!model) return ['not in the loaded list']
    const parts = costParts(model, inputsFor(data))
    if (!parts.run && !parts.perMillion) return ['price unknown']
    const cells: Array<HTMLElement | string> = []
    if (parts.run) cells.push(h('strong', {}, parts.run))
    if (parts.run && parts.perMillion) cells.push(' · ')
    if (parts.perMillion) cells.push(parts.perMillion)
    return cells
  }

  function renderAvailable(data: AppData): void {
    const q = search.value.trim().toLowerCase()
    const chosen = new Set(data.state.selected.map(s => s.id))
    const list = sortByCost(visibleCatalog(data).filter(m => !chosen.has(m.id) && (!q || m.id.toLowerCase().includes(q))), inputsFor(data))
    listFacts.textContent = data.session.catalog.length ? String(list.length) : ''
    // Picking a model re-renders both panes; keep the reader's place in a long list.
    const wrap = available.parentElement
    const scrollTop = wrap?.scrollTop ?? 0
    available.replaceChildren()
    if (list.length === 0) {
      available.append(h('p', { class: 'muted small' }, data.session.catalog.length ? 'No models match.' : 'No models loaded yet: connect a provider above.'))
      return
    }
    // Only the first 400 are drawn; the search box narrows a long catalog.
    for (const m of list.slice(0, 400)) available.append(row(m, m.id, 'available', data))
    if (list.length > 400) available.append(h('p', { class: 'muted small' }, `${list.length - 400} more: use the filter`))
    if (wrap) wrap.scrollTop = scrollTop
  }

  function renderSelected(data: AppData): void {
    const ids = data.state.selected.map(s => s.id)
    const range = totalRange(selectedCatalogModels(data), inputsFor(data))
    selectedFacts.textContent = ids.length
      ? `${ids.length} · about ${formatUsd(range.low)}–${formatUsd(range.high)} for the whole run${range.unknown ? ` (${range.unknown} without a price)` : ''}`
      : ''
    clearSel.hidden = ids.length === 0
    const byId = new Map(data.session.catalog.map(m => [m.id, m]))
    selected.replaceChildren(...(ids.length ? ids.map(id => row(byId.get(id), id, 'selected', data)) : [h('p', { class: 'muted small' }, 'Nothing selected yet: pick models on the left.')]))
  }

  function renderQuick(data: AppData): void {
    const ids = new Set(visibleCatalog(data).map(m => m.id))
    const chosen = new Set(data.state.selected.map(s => s.id))
    const recents = loadRecent().filter(r => r.providerId === data.state.providerId && ids.has(r.model) && !chosen.has(r.model))
    quick.replaceChildren(h('span', { class: 'muted small' }, 'Recently run:'), ...(recents.length ? recents.map(r => {
      const chip = h('button', { class: 'chip recent', type: 'button' }, r.model)
      chip.addEventListener('click', () => select(r.model, true))
      return chip
    }) : [h('span', { class: 'muted small' }, 'none yet')]))
  }

  function openSettings(id: string): void {
    const data = current()
    const p = presetById(data.state.providerId)
    const entry = data.state.selected.find(s => s.id === id)
    if (!entry) return
    const model = data.session.catalog.find(m => m.id === id)
    const dialog = h('dialog', { class: 'payload-dialog settings-dialog', 'aria-label': `Settings for ${id}` })
    const format = h('select', { class: 'input' },
      h('option', { value: '' }, 'Use the shared setting'),
      h('option', { value: 'auto' }, 'Automatic (schema where the model is reported to take it)'),
      h('option', { value: 'schema' }, 'JSON schema (force it)'),
      h('option', { value: 'json_object' }, 'JSON object (valid JSON, shape not enforced)'),
      h('option', { value: 'none' }, 'No format parameter'))
    format.value = entry.settings.responseFormat ?? ''
    const extras = h('textarea', { class: 'input mono', rows: '5', placeholder: '{"top_p": 0.9}' })
    extras.value = Object.keys(entry.settings.extras).length ? JSON.stringify(entry.settings.extras, null, 2) : ''
    const extrasError = h('p', { class: 'contract-error' })
    extrasError.hidden = true
    const routing = entry.settings.routing ?? { requireParameters: true, zdr: data.state.zdrOnly }
    const requireParams = h('input', { type: 'checkbox' })
    requireParams.checked = routing.requireParameters
    const order = h('input', { class: 'input', placeholder: 'Azure, OpenAI' })
    order.value = (routing.order ?? []).join(', ')
    const ignore = h('input', { class: 'input', placeholder: 'sub-providers to skip' })
    ignore.value = (routing.ignore ?? []).join(', ')
    const noFallback = h('input', { type: 'checkbox' })
    noFallback.checked = routing.allowFallbacks === false
    const routingBox = h('div', { class: 'settings-panel' }, h('h3', {}, 'OpenRouter routing'),
      h('label', { class: 'checkbox-row' }, requireParams, ' Only route to sub-providers that accept every parameter (off: OpenRouter may drop some silently)'),
      h('label', { class: 'param-field' }, h('span', {}, 'Try sub-providers in this order'), order),
      h('label', { class: 'param-field' }, h('span', {}, 'Never use these sub-providers'), ignore),
      h('label', { class: 'checkbox-row' }, noFallback, ' Do not fall back to other sub-providers'))
    routingBox.hidden = !p.routing
    const facts = model ? h('p', { class: 'muted small' }, factsLine(model)) : h('p', { class: 'muted small' }, 'Not in the loaded list: nothing is known about this model, so only the output length is sent by default.')
    const close = h('button', { class: 'btn primary', type: 'button' }, 'Done')
    close.addEventListener('click', () => {
      let parsed: Record<string, unknown> = {}
      if (extras.value.trim()) {
        try {
          const value = JSON.parse(extras.value) as unknown
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('must be a JSON object')
          parsed = value as Record<string, unknown>
        } catch (error) {
          extrasError.hidden = false
          extrasError.textContent = `Extra parameters must be a JSON object: ${(error as Error).message}`
          return
        }
      }
      store.update(d => {
        const s = d.state.selected.find(x => x.id === id)
        if (!s) return
        s.settings.responseFormat = (format.value || undefined) as ResponseFormatChoice | undefined
        s.settings.extras = parsed
        if (p.routing) {
          s.settings.routing = {
            requireParameters: requireParams.checked,
            zdr: d.state.zdrOnly,
            order: order.value.split(',').map(x => x.trim()).filter(Boolean),
            ignore: ignore.value.split(',').map(x => x.trim()).filter(Boolean),
            ...(noFallback.checked ? { allowFallbacks: false } : {}),
          }
        }
      })
      dialog.close()
    })
    dialog.addEventListener('close', () => dialog.remove())
    dialog.append(
      h('div', { class: 'payload-dialog-head' }, h('strong', {}, id), close),
      facts,
      h('label', { class: 'param-field' }, h('span', {}, 'Response format for this model'), format),
      h('label', { class: 'param-field' }, h('span', {}, 'Extra request parameters (JSON, sent as typed, merged last)'), extras),
      extrasError,
      routingBox,
    )
    document.body.append(dialog)
    dialog.showModal()
  }

  function factsLine(model: CatalogModel): string {
    const g = model.guidance
    const parts = [
      `temperature: ${g.temperature.value === true ? 'accepted' : g.temperature.value === false ? 'only its default' : 'unknown'} (${g.temperature.source})`,
      `effort: ${g.effortValues.value ? g.effortValues.value.join('/') : 'none'} (${g.effortValues.source})`,
      `JSON schema: ${g.structuredOutput.value === true ? 'yes' : g.structuredOutput.value === false ? 'no' : 'unknown'} (${g.structuredOutput.source})`,
      `JSON mode: ${g.jsonObject.value === true ? 'yes' : g.jsonObject.value === false ? 'no' : 'unknown'} (${g.jsonObject.source})`,
      `context: ${g.contextLimit.value ? g.contextLimit.value.toLocaleString() : '?'} · output ceiling: ${g.outputLimit.value ? g.outputLimit.value.toLocaleString() : '?'}`,
    ]
    return parts.join(' · ')
  }

  function refresh(data: AppData): void {
    const p = presetById(data.state.providerId)
    customBaseField.hidden = p.id !== 'custom'
    zdrRow.hidden = p.id !== 'openrouter'
    hideFree.checked = data.state.hideFreeModels
    zdr.checked = data.state.zdrOnly
    hideFree.parentElement!.hidden = p.id !== 'openrouter'
    keyInput.placeholder = p.keyRequired ? `${p.auth.envVar.replace('_API_KEY', '')} API key` : 'API key (optional for local servers)'
    const parts = [p.label]
    if (data.session.catalog.length) parts.push(`${data.session.catalog.length} models`)
    parts.push(data.session.apiKey ? 'key set ✓' : p.keyRequired ? 'no key' : 'no key needed')
    bandState.textContent = `— ${parts.join(' · ')}`
    if (!catalogCurrent(data.state, data.session)) bandOpen = true
    bandBody.hidden = !bandOpen
    bandHead.setAttribute('aria-expanded', String(bandOpen))
    note.textContent = data.session.catalogNote
    renderAvailable(data)
    renderSelected(data)
    renderQuick(data)
  }

  return {
    el,
    refresh,
    restore(data) {
      preset.value = data.state.providerId
      customBase.value = data.state.customBase
      keyInput.value = data.session.apiKey
      remember.checked = data.state.keyRemember
    },
  }
}
