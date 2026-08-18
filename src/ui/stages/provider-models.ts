// Stage 3 — Provider & models. Owns its entire DOM subtree and every listener
// that touches it; the host (app.ts) only supplies state access and refresh
// hooks, so this stage can be reasoned about — and tested — in isolation.
//
// Layout contract (shared with the rest of the app): nothing on the page
// scrolls. This stage is a two-pane grid: the model list pane and the
// selection pane each own their scroll region (flex:1; min-height:0; overflow
// auto), and the provider band collapses to a one-line summary once models
// are loaded.

import { fetchModelList, fetchZdrModels } from '../data'
import { enrichWithLiteLLMPricing } from '../../core/pricing'
import { presetById, PRESETS, QUICK_MODELS } from '../../core/providers'
import type { ModelCatalogEntry } from '../../core/types'
import type { PersistedState } from '../../state'
import { saveKey } from '../../state'
import { h } from '../dom'
import { modelsCacheKey } from '../model'
import { costSummary, modelCost, modelCostRange, sortByCost, type CostInputs } from '../costs'

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
  const refs = {
    band: null as unknown as HTMLElement,
    bandHead: null as unknown as HTMLButtonElement,
    bandBody: null as unknown as HTMLElement,
    bandState: null as unknown as HTMLSpanElement,
    preset: null as unknown as HTMLSelectElement,
    customBase: null as unknown as HTMLInputElement,
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
    budgetFacts: null as unknown as HTMLSpanElement,
    addUnderBudget: null as unknown as HTMLButtonElement,
    clearSelection: null as unknown as HTMLButtonElement,
    selected: null as unknown as HTMLDivElement,
    zdr: null as unknown as HTMLInputElement,
    zdrRow: null as unknown as HTMLLabelElement,
    quickChips: null as unknown as HTMLDivElement,
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

  // --- model list ------------------------------------------------------------

  function renderModels(): void {
    const read = host.read()
    refs.modelList.replaceChildren()
    const query = refs.modelSearch.value.trim().toLowerCase()
    let list = visibleModels().filter(m => !query || m.id.toLowerCase().includes(query))
    list = sortByCost(list, costInputs(read))

    if (list.length === 0) {
      refs.modelList.append(h('p', { class: 'muted small' },
        read.models.length === 0
          ? 'No models loaded. Set the provider & key above and press "Load models".'
          : read.state.zdr ? 'No ZDR-capable models match these filters.' : 'No models match these filters.',
      ))
      return
    }
    refs.loadFacts.textContent = `${list.length} of ${read.models.length} listed${read.state.zdr ? ' (ZDR only)' : ''}`
    const selectedIds = new Set(read.state.selected)

    for (const m of list) {
      refs.modelList.append(h('label', { class: 'model-option' },
        h('input', { type: 'checkbox', checked: selectedIds.has(m.id) }),
        h('span', { class: 'model-id' }, m.id),
        h('span', { class: 'model-cost' }, costSummary(m, costInputs(read))),
      ))
    }
  }

  function renderSelected(): void {
    const read = host.read()
    const ids = read.state.selected
    if (ids.length === 0) {
      refs.selected.replaceChildren(h('p', { class: 'muted small' }, 'None yet — check models in the list, quick-add below, or type a model ID.'))
    } else {
      refs.selected.replaceChildren(...ids.map(id => {
        const m = read.models.find(candidate => candidate.id === id)
        const remove = h('button', { class: 'minibtn danger', type: 'button' }, '×')
        remove.addEventListener('click', () => {
          const read = host.read()
          read.state.selected = read.state.selected.filter(s => s !== id)
          host.saveState()
          renderSelected()
          renderModels()
          host.refresh()
        })
        const range = m ? modelRunRangeLabel(m) : ''
        return h('div', { class: 'selected-row' },
          h('span', { class: 'selected-id' }, id),
          h('span', { class: 'muted small' }, range),
          remove,
        )
      }))
    }
  }

  function modelRunRangeLabel(m: ModelCatalogEntry): string {
    const { low, high } = runRangeParts(m)
    if (low === null) return 'cost unknown'
    return `~${low}–${high} all rows`
  }

  function runRangeParts(m: ModelCatalogEntry): { low: string | null; high: string | null } {
    const read = host.read()
    const perCall = modelCostRange(m, costInputs(read))
    if (!perCall) return { low: null, high: null }
    const calls = Math.max(1, read.state.source.kind === 'sheet' ? read.sheetRowCount : 1) * Math.max(1, read.state.repeats)
    return { low: usd(perCall.low * calls), high: usd(perCall.high * calls) }
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
    refs.budgetFacts.textContent = `${eligible.length} of ${read.models.length} models under ${usd(read.state.budget)}`
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
    renderSelected()
    renderModels()
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
      refs.loadFacts.textContent = `${models.length} model${models.length === 1 ? '' : 's'} loaded${preset.provider.group === 'openai' || preset.provider.group === 'anthropic' ? ' (pricing via LiteLLM)' : ''}`
      openBand(false)
    } catch (error) {
      host.write({ models: [], modelsCarriedBy: '' })
      refs.loadFacts.textContent = `Load failed: ${(error as Error).message}`
    } finally {
      host.saveState()
      renderBand()
      renderModels()
      renderSelected()
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
    renderModels()
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
    renderModels()
    renderSelected()
    renderQuickChips()
    renderBudgetFacts()
  }

  // --- wiring -----------------------------------------------------------------

  function buildBandBody(): HTMLElement {
    const presetSelect = h('select', { class: 'input' }, ...PRESETS.map(p => h('option', { value: p.id }, p.label)))
    presetSelect.value = host.read().state.presetId
    const customBase = h('input', { class: 'input', placeholder: 'Base URL — e.g. http://localhost:8000 or https://your.llm.example' })
    customBase.value = host.read().state.customBase
    customBase.hidden = host.read().state.presetId !== 'custom'
    const keyInput = h('input', { class: 'input', type: 'password', placeholder: presetById(host.read().state.presetId).keyLabel, autocomplete: 'new-password' })
    keyInput.value = host.read().apiKey || ''
    const remember = h('input', { type: 'checkbox' })
    remember.checked = host.read().state.keyRemember ?? false
    const loadModels = h('button', { class: 'btn', type: 'button' }, 'Load models')
    const loadFacts = h('span', { class: 'muted small', 'data-field': 'loadFacts' })
    refs.preset = presetSelect
    refs.customBase = customBase
    refs.keyInput = keyInput
    refs.remember = remember
    refs.loadModels = loadModels
    refs.loadFacts = loadFacts

    presetSelect.addEventListener('change', () => {
      const read = host.read()
      read.state.presetId = presetSelect.value
      const preset = presetById(presetSelect.value)
      customBase.hidden = !preset.customBase
      customBase.value = read.state.customBase || ''
      keyInput.placeholder = preset.keyLabel
      refs.zdrRow.hidden = preset.provider.group !== 'openrouter'
      read.state.selected = []
      host.write({ models: [], zdrIds: new Set(), modelsCarriedBy: '' })
      host.saveState()
      openBand(true)
      renderBand()
      renderModels()
      renderSelected()
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
        renderModels()
        renderSelected()
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
        h('label', { class: 'field', hidden: customBase.hidden }, h('span', {}, 'Base URL'), customBase),
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
    const budget = h('input', { class: 'input', type: 'range', min: '0.001', max: '0.05', step: '0.0005' })
    budget.value = String(read0.state.budget)
    const budgetFacts = h('span', { class: 'muted small' })
    const addUnderBudget = h('button', { class: 'btn', type: 'button' }, 'Add all under budget')
    const clearSelection = h('button', { class: 'btn ghost', type: 'button' }, 'Clear selection')
    const selected = h('div', { class: 'selected-list' })
    const zdr = h('input', { type: 'checkbox' })
    zdr.checked = read0.state.zdr
    const zdrRow = h('label', { class: 'checkbox-row' }, zdr, ' ZDR only (OpenRouter — hides and deselects models without ZDR)')
    if (read0.state.presetId !== 'openrouter') zdrRow.hidden = true
    const quickChips = h('div', { class: 'chips' })

    refs.modelSearch = modelSearch
    refs.hideFreeModels = hideFreeModels
    refs.modelList = modelList
    refs.manualId = manualId
    refs.manualAdd = manualAdd
    refs.budget = budget
    refs.budgetFacts = budgetFacts
    refs.addUnderBudget = addUnderBudget
    refs.clearSelection = clearSelection
    refs.selected = selected
    refs.zdr = zdr
    refs.zdrRow = zdrRow
    refs.quickChips = quickChips

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

    modelSearch.addEventListener('input', () => renderModels())
    hideFreeModels.addEventListener('change', () => {
      const read = host.read()
      read.state.hideFreeModels = hideFreeModels.checked
      read.state.selected = read.state.selected.filter(id => visibleModels().some(model => model.id === id))
      host.saveState()
      renderModels()
      renderSelected()
      renderQuickChips()
      renderBudgetFacts()
    })
    modelList.addEventListener('change', ev => {
      const input = (ev.target as HTMLElement).closest('input[type=checkbox]')
      if (!input) return
      const option = (input as HTMLElement).closest('.model-option')
      if (!option) return
      const id = option.querySelector('.model-id')?.textContent ?? ''
      if (id) selectModel(id, (input as HTMLInputElement).checked)
    })
    manualAdd.addEventListener('click', () => addModelById(refs.manualId.value))
    manualId.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        addModelById(refs.manualId.value)
        refs.manualId.value = ''
      }
    })
    budget.addEventListener('input', () => {
      host.read().state.budget = Number(budget.value)
      renderBudgetFacts()
      host.saveState()
    })
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
      renderModels()
      refs.budgetFacts.textContent = `${added} model(s) added under ${usd(read.state.budget)}`
    })
    clearSelection.addEventListener('click', () => {
      const read = host.read()
      read.state.selected = []
      host.saveState()
      renderSelected()
      renderModels()
      host.refresh()
    })
    zdr.addEventListener('change', () => void toggleZdr(zdr.checked))

    return h('section', { class: 'card stage-card models-stage' },
      h('div', { class: 'stage-heading' }, h('span', { class: 'eyebrow' }, 'Step 3'), h('h2', {}, 'Provider & models'), h('p', {}, 'Connect a provider, then pick the models to compare. The provider band collapses once models load — open it any time to switch.'),
      ),
      band,
      h('div', { class: 'models-layout' },
        h('div', { class: 'pick-col' },
          h('p', { class: 'section-label' }, 'Model list'),
          modelSearch,
          h('div', { class: 'model-filters' },
            h('label', { class: 'checkbox-row' }, hideFreeModels, ' Hide OpenRouter :free routes (they may use your data)'),
            zdrRow,
            h('span', { class: 'muted small' }, ' :batch routes are always excluded'),
          ),
          h('div', { class: 'model-list-wrap' }, modelList),
        ),
        h('div', { class: 'selected-col' },
          h('p', { class: 'section-label selected-heading' }, 'Selected models'),
          h('div', { class: 'selected-list-wrap' }, selected),
          h('div', { class: 'manual-row' }, manualId, manualAdd),
          h('div', { class: 'row' }, addUnderBudget, clearSelection, budgetFacts),
          h('label', { class: 'budget-slider' }, 'Budget (estimated $ per model per call)', budget),
          h('div', { class: 'quick-add-block' },
            h('p', { class: 'section-label' }, 'Quick add'),
            quickChips,
          ),
        ),
      ),
    )
  }

  const el = build()
  renderBand()
  renderModels()
  renderSelected()
  renderQuickChips()
  renderBudgetFacts()

  const sync = (): void => {
    renderBand()
    renderModels()
    renderSelected()
    renderQuickChips()
    renderBudgetFacts()
    host.refresh()
  }

  return {
    el,
    sync,
    applyRestored() {
      const read = host.read()
      const preset = presetById(read.state.presetId)
      refs.preset.value = read.state.presetId
      refs.customBase.value = read.state.customBase || ''
      refs.customBase.hidden = !preset.customBase
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
