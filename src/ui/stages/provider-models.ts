// Stage 3 — Provider & models. Owns its entire DOM subtree and every listener
// that touches it; the host (app.ts) only supplies state access and refresh
// hooks, so this stage can be reasoned about — and tested — in isolation.
//
// Layout contract (shared with the rest of the app): nothing on the page
// scrolls. This stage is a transfer list — available models on the left,
// selected on the right, a model on exactly one side at a time — split by a
// draggable divider whose ratio persists. Each pane owns its scroll region
// (flex:1; min-height:0; overflow auto), and the provider band collapses to a
// one-line summary once models are loaded and a key is present.

import { fetchModelList, fetchZdrModels } from '../data'
import { enrichWithLiteLLMPricing } from '../../core/pricing'
import { presetById, PRESETS, QUICK_MODELS } from '../../core/providers'
import type { ModelCatalogEntry } from '../../core/types'
import type { PersistedState } from '../../state'
import { saveKey } from '../../state'
import { h } from '../dom'
import { modelsCacheKey, providerKeyRequired } from '../model'
import { costSummary, modelCost, sortByCost, type CostInputs } from '../costs'

export interface ModelsStageRead {
  state: PersistedState
  apiKey: string
  models: ModelCatalogEntry[]
  zdrIds: Set<string>
  modelsCarriedBy: string
  tokenEstimate: number
  sheetRowCount: number
}

export interface ModelsStageHost {
  read(): ModelsStageRead
  write(patch: Partial<Pick<ModelsStageRead, 'apiKey' | 'models' | 'zdrIds' | 'modelsCarriedBy'>>): void
  saveState(): void
  /** Re-derive the wizard gates and Run button (cheap; idempotent). */
  refresh(): void
  dispose?(): void
}

export interface ModelsStage {
  el: HTMLElement
  /** The base URL the run should hit right now (band's custom input when set). */
  currentBaseUrl(): string
  /** Re-render every surface from host state (restore, token updates). */
  sync(): void
  /** State-restore entry point: the provider band must re-open when the
   * restored session has no models loaded yet. */
  applyRestored(): void
}

function isBatchModel(state: PersistedState, model: ModelCatalogEntry): boolean {
  return state.presetId === 'openrouter' && /:batch(?:$|[-:])/i.test(model.id)
}

function isFreeModel(state: PersistedState, model: ModelCatalogEntry): boolean {
  return state.presetId === 'openrouter' && /:free(?:$|[-:])/i.test(model.id)
}

export function buildModelsStage(host: ModelsStageHost): ModelsStage {
  const bandOpen = { value: true }
  let splitRatio = host.read().state.splitRatio
  const refs = {
    band: null as unknown as HTMLElement,
    bandHead: null as unknown as HTMLButtonElement,
    bandBody: null as unknown as HTMLElement,
    bandState: null as unknown as HTMLSpanElement,
    preset: null as unknown as HTMLSelectElement,
    customBase: null as unknown as HTMLInputElement,
    /** The label wrapping `customBase`. Visibility is toggled here, not on the
     * input: hiding only the input leaves its "Base URL" caption on screen. */
    customBaseField: null as unknown as HTMLLabelElement,
    keyInput: null as unknown as HTMLInputElement,
    remember: null as unknown as HTMLInputElement,
    loadModels: null as unknown as HTMLButtonElement,
    loadFacts: null as unknown as HTMLSpanElement,
    modelSearch: null as unknown as HTMLInputElement,
    hideFreeModels: null as unknown as HTMLInputElement,
    modelList: null as unknown as HTMLDivElement,
    manualId: null as unknown as HTMLInputElement,
    manualAdd: null as unknown as HTMLButtonElement,
    budget: null as unknown as HTMLInputElement,
    budgetField: null as unknown as HTMLInputElement,
    budgetFacts: null as unknown as HTMLSpanElement,
    addUnderBudget: null as unknown as HTMLButtonElement,
    clearSelection: null as unknown as HTMLButtonElement,
    selected: null as unknown as HTMLDivElement,
    zdr: null as unknown as HTMLInputElement,
    zdrRow: null as unknown as HTMLLabelElement,
    quickChips: null as unknown as HTMLDivElement,
    listFacts: null as unknown as HTMLSpanElement,
    selectedFacts: null as unknown as HTMLSpanElement,
  }

  function costInputs(read: ModelsStageRead): CostInputs {
    return {
      models: read.models,
      selected: read.state.selected,
      tokenEstimate: read.tokenEstimate,
      prompt: read.state.prompt,
      system: read.state.system,
      params: read.state.params,
      repeats: read.state.repeats,
      caseCount: read.state.source.kind === 'sheet' ? Math.max(1, read.sheetRowCount) : 1,
    }
  }

  function visibleModels(): ModelCatalogEntry[] {
    const read = host.read()
    return read.models.filter(model => {
      if (isBatchModel(read.state, model)) return false
      if (read.state.hideFreeModels && isFreeModel(read.state, model)) return false
      if (read.state.zdr && !read.zdrIds.has(model.id)) return false
      return true
    })
  }

  function modelsCurrent(): boolean {
    const read = host.read()
    const preset = presetById(read.state.presetId)
    const baseUrl = preset.customBase ? refs.customBase.value.trim() : preset.provider.api.baseUrl
    return read.modelsCarriedBy === modelsCacheKey(preset.id, baseUrl)
  }

  // --- provider band ---------------------------------------------------------

  function renderBand(): void {
    const read = host.read()
    const preset = presetById(read.state.presetId)
    const keySet = read.apiKey.length > 0
    const parts = [preset.label]
    const loaded = modelsCurrent() || read.models.length === 0
    if (read.models.length > 0) parts.push(`${read.models.length} model${read.models.length === 1 ? '' : 's'}`)
    if (loaded && read.models.length === 0) {
      refs.bandState.textContent = '— not connected yet'
    } else if (!keySet) {
      parts.push('no key')
      refs.bandState.textContent = `— ${parts.join(' · ')}`
    } else {
      parts.push('key set ✓')
      refs.bandState.textContent = `— ${parts.join(' · ')}`
    }
    refs.bandBody.hidden = !bandOpen.value
    refs.bandHead.setAttribute('aria-expanded', String(bandOpen.value))
  }

  function openBand(open: boolean): void {
    bandOpen.value = open
    renderBand()
  }

  // --- the two panes ---------------------------------------------------------
  // A transfer list: every model is on exactly one side. Picking one moves it
  // right, releasing one moves it left. Nothing is ever drawn twice, so the
  // cost on a row is the only place that model's price appears.

  function paneRow(id: string, side: 'available' | 'selected'): HTMLElement {
    const read = host.read()
    const model = read.models.find(candidate => candidate.id === id)
    const arrow = h('span', { class: 'model-arrow', 'aria-hidden': 'true' }, side === 'available' ? '→' : '←')
    const label = h('span', { class: 'model-id' }, id)
    // Same element, same width, both sides: the cost column is how a user
    // compares what they picked against what they did not.
    const cost = h('span', { class: 'model-cost' }, model ? costSummary(model, costInputs(read)) : 'cost unknown')
    const row = h('button', {
      class: `model-row ${side}`,
      type: 'button',
      title: side === 'available' ? `Add ${id}` : `Remove ${id}`,
    }, ...(side === 'available' ? [label, cost, arrow] : [arrow, label, cost]))
    row.addEventListener('click', () => selectModel(id, side === 'available'))
    return row
  }

  function renderAvailable(): void {
    const read = host.read()
    const query = refs.modelSearch.value.trim().toLowerCase()
    const chosen = new Set(read.state.selected)
    const list = sortByCost(
      visibleModels().filter(m => !chosen.has(m.id) && (!query || m.id.toLowerCase().includes(query))),
      costInputs(read),
    )

    // The count belongs on the pane, not in the provider band: the band spends
    // most of its life collapsed, which is exactly when the count matters.
    refs.listFacts.textContent = read.models.length === 0 ? '' : String(list.length)

    refs.modelList.replaceChildren()
    if (list.length === 0) {
      refs.modelList.append(h('p', { class: 'muted small' },
        read.models.length === 0
          ? 'No models loaded yet — connect a provider above.'
          : read.state.zdr ? 'No ZDR-capable models match these filters.' : 'No models match these filters.',
      ))
      return
    }
    for (const m of list) refs.modelList.append(paneRow(m.id, 'available'))
  }

  function renderSelected(): void {
    const read = host.read()
    const ids = read.state.selected
    refs.selectedFacts.textContent = ids.length ? String(ids.length) : ''
    refs.clearSelection.hidden = ids.length === 0

    if (ids.length === 0) {
      refs.selected.replaceChildren(h('p', { class: 'muted small' }, 'Nothing selected yet — pick models on the left.'))
      return
    }
    refs.selected.replaceChildren(...ids.map(id => paneRow(id, 'selected')))
  }

  /** Both sides always move together: a model leaving one pane arrives in the
   * other, so rendering one without the other shows it twice or not at all. */
  function renderPanes(): void {
    renderAvailable()
    renderSelected()
  }

  function renderQuickChips(): void {
    const read = host.read()
    const preset = presetById(read.state.presetId)
    const available = new Set(visibleModels().map(model => model.id))
    const curated = (QUICK_MODELS[preset.provider.group] ?? []).filter(model => available.has(model.id))
    const chips = h('div', { class: 'chip-row' })
    for (const q of curated) chips.append(h('button', { class: 'chip', type: 'button', title: q.id }, q.id))
    for (const r of readRecently()) {
      if (!available.has(r.model)) continue
      chips.append(h('button', { class: 'chip recent', type: 'button', title: 'recently run' }, r.model))
    }
    refs.quickChips.replaceChildren(
      h('span', { class: 'muted small' }, 'Quick add:'),
      chips.childElementCount ? chips : h('span', { class: 'muted small' }, 'run a model to keep it here'),
    )
    for (const chip of refs.quickChips.querySelectorAll('button.chip')) {
      chip.addEventListener('click', () => selectModel((chip as HTMLButtonElement).textContent ?? '', true))
    }
  }

  function renderBudgetFacts(): void {
    const read = host.read()
    const inputs = costInputs(read)
    const eligible = sortByCost(visibleModels().filter(m => {
      const cost = modelCost(m, inputs)
      return cost !== null && cost <= read.state.budget
    }), inputs)
    refs.budgetFacts.textContent = `${eligible.length} under ${usd(read.state.budget)}`
  }

  function readRecently(): Array<{ presetId: string; model: string }> {
    try {
      const raw = localStorage.getItem('multiaiball:recent:v2')
      const parsed = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  function selectModel(id: string, checked: boolean): void {
    const read = host.read()
    if (checked) {
      if (read.state.zdr && !read.zdrIds.has(id)) return
      if (!read.state.selected.includes(id)) {
        read.state.selected = [...read.state.selected, id]
        const recent = readRecently().filter(r => !(r.presetId === read.state.presetId && r.model === id))
        try {
          localStorage.setItem('multiaiball:recent:v2', JSON.stringify([{ presetId: read.state.presetId, model: id }, ...recent].slice(0, 8)))
        } catch { /* persistence optional */ }
        renderQuickChips()
      }
    } else {
      read.state.selected = read.state.selected.filter(s => s !== id)
    }
    host.saveState()
    renderPanes()
    host.refresh()
  }

  // --- async flows -----------------------------------------------------------

  async function performLoad(): Promise<void> {
    const read = host.read()
    const preset = presetById(read.state.presetId)
    const baseUrl = preset.customBase ? refs.customBase.value.trim() : preset.provider.api.baseUrl
    if (preset.customBase && !baseUrl) {
      refs.loadFacts.textContent = 'Enter the base URL first.'
      return
    }
    refs.loadModels.disabled = true
    refs.loadModels.textContent = 'Loading…'
    try {
      let models = await fetchModelList(preset, baseUrl, read.apiKey)
      if (preset.provider.group === 'openai' || preset.provider.group === 'anthropic') {
        await enrichWithLiteLLMPricing(models, preset.provider.group)
      }
      let zdrIds = read.zdrIds
      if (read.state.zdr && preset.provider.group === 'openrouter') {
        zdrIds = await fetchZdrModels(baseUrl)
      }
      host.write({ models, zdrIds, modelsCarriedBy: modelsCacheKey(preset.id, baseUrl) })
      // OpenRouter's catalog is public, so a keyless load succeeds and then the
      // run is gated on a key that is nowhere on screen. Collapsing the band on
      // success took the key field away at the exact moment it became the only
      // thing left to do — so it stays open until there is a key to run with.
      const keyMissing = providerKeyRequired(preset) && host.read().apiKey.length === 0
      const count = `${models.length} model${models.length === 1 ? '' : 's'} loaded`
      refs.loadFacts.textContent = keyMissing
        ? `${count} — add your API key to run (listing the catalog is free, calling a model is not).`
        : `${count}${preset.provider.group === 'openai' || preset.provider.group === 'anthropic' ? ' (pricing via LiteLLM)' : ''}`
      openBand(keyMissing)
    } catch (error) {
      host.write({ models: [], modelsCarriedBy: '' })
      refs.loadFacts.textContent = `Load failed: ${(error as Error).message}`
    } finally {
      host.saveState()
      renderBand()
      renderPanes()
      renderBudgetFacts()
      renderQuickChips()
      host.refresh()
      refs.loadModels.disabled = false
      refs.loadModels.textContent = 'Load models'
    }
  }

  function addModelById(idRaw: string): void {
    const id = idRaw.trim()
    if (!id) return
    const read = host.read()
    if (read.state.zdr && !read.zdrIds.has(id)) {
      refs.loadFacts.textContent = 'ZDR mode: model is not on the ZDR endpoint list.'
      return
    }
    if (!read.models.some(m => m.id === id)) {
      host.write({ models: [...read.models, { id }] })
    }
    selectModel(id, true)
    renderAvailable()
  }

  async function toggleZdr(enabled: boolean): Promise<void> {
    const read = host.read()
    read.state.zdr = enabled
    host.saveState()
    if (enabled && read.state.presetId === 'openrouter') {
      try {
        const zdrIds = await fetchZdrModels(presetById('openrouter').provider.api.baseUrl)
        host.write({ zdrIds })
        host.saveState()
      } catch (error) {
        refs.loadFacts.textContent = `Could not load ZDR routes: ${(error as Error).message}`
        read.state.zdr = false
        refs.zdr.checked = false
      }
    }
    read.state.selected = read.state.selected.filter(id => visibleModels().some(model => model.id === id))
    host.saveState()
    renderPanes()
    renderQuickChips()
    renderBudgetFacts()
  }

  // --- wiring -----------------------------------------------------------------

  function buildBandBody(): HTMLElement {
    const presetSelect = h('select', { class: 'input' }, ...PRESETS.map(p => h('option', { value: p.id }, p.label)))
    presetSelect.value = host.read().state.presetId
    const customBase = h('input', { class: 'input', placeholder: 'Base URL — e.g. http://localhost:8000 or https://your.llm.example' })
    customBase.value = host.read().state.customBase
    const customBaseField = h('label', { class: 'field' }, h('span', {}, 'Base URL'), customBase)
    customBaseField.hidden = host.read().state.presetId !== 'custom'
    const keyInput = h('input', { class: 'input', type: 'password', placeholder: presetById(host.read().state.presetId).keyLabel, autocomplete: 'new-password' })
    keyInput.value = host.read().apiKey || ''
    const remember = h('input', { type: 'checkbox' })
    remember.checked = host.read().state.keyRemember ?? false
    const loadModels = h('button', { class: 'btn', type: 'button' }, 'Load models')
    const loadFacts = h('span', { class: 'muted small', 'data-field': 'loadFacts' })
    refs.preset = presetSelect
    refs.customBase = customBase
    refs.customBaseField = customBaseField
    refs.keyInput = keyInput
    refs.remember = remember
    refs.loadModels = loadModels
    refs.loadFacts = loadFacts

    presetSelect.addEventListener('change', () => {
      const read = host.read()
      read.state.presetId = presetSelect.value
      const preset = presetById(presetSelect.value)
      customBaseField.hidden = !preset.customBase
      customBase.value = read.state.customBase || ''
      keyInput.placeholder = preset.keyLabel
      refs.zdrRow.hidden = preset.provider.group !== 'openrouter'
      read.state.selected = []
      host.write({ models: [], zdrIds: new Set(), modelsCarriedBy: '' })
      host.saveState()
      openBand(true)
      renderBand()
      renderPanes()
      renderQuickChips()
      host.refresh()
    })

    customBase.addEventListener('change', () => {
      const read = host.read()
      read.state.customBase = customBase.value.trim()
      if (read.models.length > 0) {
        // Switching endpoints invalidates the loaded list: model ids exist on
        // the OLD server, and the run must not silently 404 against the new one.
        host.write({ models: [], modelsCarriedBy: '' })
        refs.loadFacts.textContent = 'Base URL changed — reload the model list.'
        renderPanes()
      }
      host.saveState()
      host.refresh()
    })

    keyInput.addEventListener('input', () => {
      host.write({ apiKey: keyInput.value.trim() })
      saveKey(keyInput.value.trim(), remember.checked)
      host.refresh()
      renderBand()
    })

    remember.addEventListener('change', () => {
      const read = host.read()
      read.state.keyRemember = remember.checked
      saveKey(read.apiKey, remember.checked)
      host.saveState()
    })

    loadModels.addEventListener('click', () => void performLoad())

    return h('div', { class: 'provider-band-body' },
      h('div', { class: 'field-grid' },
        h('label', { class: 'field' }, h('span', {}, 'Provider'), presetSelect),
        customBaseField,
        h('label', { class: 'field' }, h('span', {}, 'API key'), keyInput),
      ),
      h('label', { class: 'checkbox-row' }, remember, ' Remember key on this device (plaintext in localStorage — only on machines you trust)'),
      h('div', { class: 'row' }, loadModels, loadFacts),
    )
  }

  function build(): HTMLElement {
    const read0 = host.read()
    const modelSearch = h('input', { class: 'input', type: 'search', placeholder: 'Filter the loaded model list…' })
    const hideFreeModels = h('input', { type: 'checkbox' })
    hideFreeModels.checked = read0.state.hideFreeModels
    const modelList = h('div', { class: 'model-list' })
    const manualId = h('input', { class: 'input', placeholder: 'Add any model by ID — works even if the list is empty' })
    const manualAdd = h('button', { class: 'btn', type: 'button' }, 'Add')
    const budget = h('input', { class: 'input budget-slider-input', type: 'range', min: '0.0005', max: '0.05', step: '0.0005' })
    budget.value = String(read0.state.budget)
    // Slider and field are two views of one number: the slider to sweep, the
    // field to type an exact figure the slider's step cannot land on.
    const budgetField = h('input', { class: 'input budget-field', type: 'number', min: '0', max: '1', step: '0.0005' })
    budgetField.value = String(read0.state.budget)
    const budgetFacts = h('span', { class: 'muted small' })
    const addUnderBudget = h('button', { class: 'btn', type: 'button' }, 'Add all under')
    const splitter = h('div', {
      class: 'pane-splitter',
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': 'Resize the model panes',
      tabindex: '0',
      title: 'Drag to resize',
    })
    const clearSelection = h('button', { class: 'minibtn', type: 'button' }, 'Clear')
    const selected = h('div', { class: 'selected-list' })
    const zdr = h('input', { type: 'checkbox' })
    zdr.checked = read0.state.zdr
    const zdrRow = h('label', { class: 'checkbox-row' }, zdr, ' ZDR only (OpenRouter — hides and deselects models without ZDR)')
    if (read0.state.presetId !== 'openrouter') zdrRow.hidden = true
    const quickChips = h('div', { class: 'chips' })
    const listFacts = h('span', { class: 'muted small' })
    const selectedFacts = h('span', { class: 'muted small' })

    refs.modelSearch = modelSearch
    refs.hideFreeModels = hideFreeModels
    refs.modelList = modelList
    refs.manualId = manualId
    refs.manualAdd = manualAdd
    refs.budgetField = budgetField
    refs.budget = budget
    refs.budgetFacts = budgetFacts
    refs.addUnderBudget = addUnderBudget
    refs.clearSelection = clearSelection
    refs.selected = selected
    refs.zdr = zdr
    refs.zdrRow = zdrRow
    refs.quickChips = quickChips
    refs.listFacts = listFacts
    refs.selectedFacts = selectedFacts

    const bandState = h('span', { class: 'provider-band-state' })
    const bandHead = h('button', { class: 'provider-band-head', type: 'button' },
      h('span', { class: 'provider-band-label' }, 'Provider & key'),
      bandState,
      h('span', { class: 'provider-chevron', 'aria-hidden': 'true' }, '▾'),
    )
    const bandBody = buildBandBody()
    refs.bandHead = bandHead
    refs.bandState = bandState
    refs.bandBody = bandBody
    const band = h('div', { class: 'provider-band' }, bandHead, bandBody)
    refs.band = band
    bandHead.addEventListener('click', () => openBand(!bandOpen.value))

    modelSearch.addEventListener('input', () => renderAvailable())
    hideFreeModels.addEventListener('change', () => {
      const read = host.read()
      read.state.hideFreeModels = hideFreeModels.checked
      read.state.selected = read.state.selected.filter(id => visibleModels().some(model => model.id === id))
      host.saveState()
      renderPanes()
      renderQuickChips()
      renderBudgetFacts()
    })
    manualAdd.addEventListener('click', () => {
      addModelById(refs.manualId.value)
      refs.manualId.value = ''
    })
    manualId.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        addModelById(refs.manualId.value)
        refs.manualId.value = ''
      }
    })
    const setBudget = (value: number, source: 'slider' | 'field'): void => {
      const next = Number.isFinite(value) ? Math.max(0, value) : 0.005
      host.read().state.budget = next
      // Only the other control is rewritten. Echoing a clamped value back into
      // the field mid-keystroke fights the person typing "0.02" one key at a
      // time, so the field commits on change (blur/Enter) and is left alone.
      if (source === 'field') budget.value = String(Math.min(0.05, next))
      else budgetField.value = String(next)
      renderBudgetFacts()
      host.saveState()
    }
    budget.addEventListener('input', () => setBudget(Number(budget.value), 'slider'))
    budgetField.addEventListener('change', () => setBudget(Number(budgetField.value), 'field'))
    addUnderBudget.addEventListener('click', () => {
      const read = host.read()
      const inputs = costInputs(read)
      let added = 0
      for (const m of sortByCost(visibleModels(), inputs)) {
        const cost = modelCost(m, inputs)
        if (cost !== null && cost <= read.state.budget) {
          selectModel(m.id, true)
          added++
        }
      }
      renderBudgetFacts()
      renderAvailable()
      refs.budgetFacts.textContent = `added ${added}`
    })
    clearSelection.addEventListener('click', () => {
      const read = host.read()
      read.state.selected = []
      host.saveState()
      renderPanes()
      host.refresh()
    })
    zdr.addEventListener('change', () => void toggleZdr(zdr.checked))

    const layout = h('div', { class: 'models-layout' },
      h('div', { class: 'pick-col' },
        h('div', { class: 'pane-head' }, h('p', { class: 'section-label' }, 'Available'), listFacts),
        modelSearch,
        h('div', { class: 'model-filters' },
          h('label', { class: 'checkbox-row' }, hideFreeModels, ' Hide :free routes'),
          zdrRow,
          h('span', { class: 'muted small' }, ':batch always excluded'),
        ),
        h('div', { class: 'model-list-wrap' }, modelList),
        h('div', { class: 'manual-row' }, manualId, manualAdd),
      ),
      splitter,
      h('div', { class: 'selected-col' },
        h('div', { class: 'pane-head' }, h('p', { class: 'section-label' }, 'Selected'), selectedFacts, clearSelection),
        h('div', { class: 'selected-list-wrap' }, selected),
        h('div', { class: 'budget-row' }, addUnderBudget, budget, budgetField, budgetFacts),
        h('div', { class: 'quick-add-block' }, quickChips),
      ),
    )

    // --- the splitter ---------------------------------------------------------
    // The two panes serve opposite jobs depending on the run: a hundred-model
    // shootout wants the left pane wide, a six-model sheet job wants the right.
    // Rather than guess per mode, the divider is draggable and the ratio is
    // remembered.
    const applySplit = (ratio: number): void => {
      splitRatio = Math.min(0.8, Math.max(0.2, ratio))
      layout.style.gridTemplateColumns = `${(splitRatio * 100).toFixed(2)}% var(--splitter-width) 1fr`
    }
    const commitSplit = (): void => {
      host.read().state.splitRatio = splitRatio
      host.saveState()
    }
    applySplit(read0.state.splitRatio)

    splitter.addEventListener('pointerdown', down => {
      down.preventDefault()
      const bounds = layout.getBoundingClientRect()
      splitter.setPointerCapture(down.pointerId)
      const onMove = (move: PointerEvent): void => applySplit((move.clientX - bounds.left) / bounds.width)
      const onUp = (up: PointerEvent): void => {
        splitter.releasePointerCapture(up.pointerId)
        splitter.removeEventListener('pointermove', onMove)
        splitter.removeEventListener('pointerup', onUp)
        splitter.removeEventListener('pointercancel', onUp)
        commitSplit()
      }
      splitter.addEventListener('pointermove', onMove)
      splitter.addEventListener('pointerup', onUp)
      splitter.addEventListener('pointercancel', onUp)
    })
    splitter.addEventListener('keydown', ev => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return
      ev.preventDefault()
      applySplit(splitRatio + (ev.key === 'ArrowLeft' ? -0.02 : 0.02))
      commitSplit()
    })

    return h('section', { class: 'card stage-card models-stage' },
      h('div', { class: 'stage-heading' }, h('h2', {}, 'Provider & models')),
      band,
      layout,
    )
  }

  const el = build()
  renderBand()
  renderPanes()
  renderQuickChips()
  renderBudgetFacts()

  const sync = (): void => {
    renderBand()
    renderPanes()
    renderQuickChips()
    renderBudgetFacts()
    host.refresh()
  }

  return {
    el,
    currentBaseUrl() {
      const preset = presetById(host.read().state.presetId)
      return preset.customBase ? refs.customBase.value.trim() : preset.provider.api.baseUrl
    },
    sync,
    applyRestored() {
      const read = host.read()
      const preset = presetById(read.state.presetId)
      refs.preset.value = read.state.presetId
      refs.customBase.value = read.state.customBase || ''
      refs.customBaseField.hidden = !preset.customBase
      refs.keyInput.placeholder = preset.keyLabel
      refs.keyInput.value = read.apiKey || ''
      refs.remember.checked = read.state.keyRemember ?? false
      refs.zdr.checked = read.state.zdr
      refs.zdrRow.hidden = preset.provider.group !== 'openrouter'
      refs.modelSearch.value = ''
      refs.budget.value = String(read.state.budget)
      openBand(true)
      sync()
    },
  }
}

function usd(value: number): string {
  if (value === 0) return '$0'
  if (value < 0.01) return `$${value.toFixed(6)}`
  if (value < 1) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}
