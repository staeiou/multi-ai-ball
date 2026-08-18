// Composition root: builds the shell once, owns the tiny store (AppState +
// reducers), and drives the run lifecycle. All untrusted text flows through
// h() text nodes; inputs own their text and are never re-rendered, so focus
// survives — only derived regions re-render from state.

// Base application rules include the stage visibility contract. The stage
// layer lives one directory up; without this import every wizard stage is an
// ordinary block and the app degenerates into one long scroll page.
import '../styles.css'
import './styles.css'

import JSZip from 'jszip'

import { fetchModelList, fetchZdrModels } from './data'
import { buildPlan, parseSheetBytes } from '../core/cases'
import type { SheetRow } from '../core/cases'
import { buildContractContext, resolveContract } from '../core/contract'
import { buildRows, download, fileStamp, toCSV, toJSONL, toXLSX, XLSX_MIME } from '../core/export'
import { enrichWithLiteLLMPricing, estimateCostUsd, formatUsd } from '../core/pricing'
import { buildBundleZip, ZIP_MIME } from '../core/py'
import { BUILTIN_PARSERS } from '../core/parsers'
import { presetById, PRESETS, QUICK_MODELS } from '../core/providers'
import { buildRunSpecs, RunController } from '../core/run'
import { countTokens, naiveTokenCount } from '../core/tokenizer'
import { promptPlaceholderNames, renderPromptTemplate } from '../core/template'
import type { CallResult, ContractField, ContractPlacement, ModelCatalogEntry, RunMeta, RunSpec } from '../core/types'
import { defaultState, loadKey, loadRecent, loadState, loadTemplates, pushRecent, saveKey, saveState, saveTemplates, RECENT_KEY } from '../state'
import type { PersistedState, RecentItem, SavedTemplate } from '../state'
import { h } from './dom'
import { ResultsGrid } from './grid'

const persisted = loadState()
const state: PersistedState = persisted

let apiKey = loadKey(state.keyRemember)
let models: ModelCatalogEntry[] = []
let modelsLoadedFailed = ''
let zdrIds = new Set<string>()
let sheetRows: SheetRow[] = []
let templates = loadTemplates()
let tokenEstimate = 0
let running = false
let results: CallResult[] = []
let specs: RunSpec[] = []
let runMeta: RunMeta | null = null
let runController: RunController | null = null
let grid: ResultsGrid | null = null
let tokenTimer: ReturnType<typeof setTimeout> | undefined
let sheetPreviewRow = 0
let promptCaret = 0

const ASSUMED_OUTPUT_TOKENS = 512
const CONFIRM_THRESHOLD_USD = 0.5

interface Refs {
  root: HTMLElement
  preset: HTMLSelectElement
  customBase: HTMLInputElement
  keyInput: HTMLInputElement
  remember: HTMLInputElement
  loadModels: HTMLButtonElement
  loadFacts: HTMLSpanElement
  providerBand: HTMLDetailsElement
  providerSummary: HTMLElement
  system: HTMLTextAreaElement
  prompt: HTMLTextAreaElement
  starters: HTMLDivElement
  sourceTabs: HTMLDivElement
  sheetInput: HTMLInputElement
  sheetFacts: HTMLSpanElement
  sheetPreview: HTMLDivElement
  modelSearch: HTMLInputElement
  hideFreeModels: HTMLInputElement
  modelList: HTMLDivElement
  manualId: HTMLInputElement
  manualAdd: HTMLButtonElement
  quickChips: HTMLDivElement
  budget: HTMLInputElement
  budgetFacts: HTMLSpanElement
  addUnderBudget: HTMLButtonElement
  selected: HTMLDivElement
  paramTemp: HTMLInputElement
  paramMax: HTMLInputElement
  paramTopP: HTMLInputElement
  stream: HTMLInputElement
  streamThreshold: HTMLInputElement
  zdr: HTMLInputElement
  zdrRow: HTMLLabelElement
  repeats: HTMLInputElement
  retries: HTMLInputElement
  concurrency: HTMLInputElement
  run: HTMLButtonElement
  runEstimate: HTMLSpanElement
  contractFields: HTMLDivElement
  contractErrors: HTMLDivElement
  rationaleFirst: HTMLInputElement
  rationaleSpec: HTMLInputElement
  strictJson: HTMLInputElement
  placement: HTMLSelectElement
  schemaPreview: HTMLDetailsElement
  schemaBody: HTMLPreElement
  parser: HTMLSelectElement
  templateName: HTMLInputElement
  saveTemplate: HTMLButtonElement
  templateSelect: HTMLSelectElement
  deleteTemplate: HTMLButtonElement
  facts: HTMLSpanElement
  cancel: HTMLButtonElement
  exportXlsx: HTMLButtonElement
  exportCsv: HTMLButtonElement
  exportJsonl: HTMLButtonElement
  exportPy: HTMLButtonElement
  newPrompt: HTMLButtonElement
  resultsGrid: HTMLDivElement
  resultSearch: HTMLInputElement
  resultStatus: HTMLSelectElement
  reviewSummary: HTMLDivElement
  dark: HTMLInputElement
  wizardNav: HTMLElement
  wizardNext: HTMLButtonElement
  wizardBack: HTMLButtonElement
  restoreInput: HTMLInputElement
  backupBtn: HTMLButtonElement
  restoreBtn: HTMLButtonElement
}

const refs = {} as Refs

// --- shell -------------------------------------------------------------------

function brand(): HTMLElement {
  return h('h1', { class: 'brand' },
    'Mult',
    h('span', { class: 'frac', 'aria-label': 'A/I' },
      h('span', { class: 'frac-num' }, 'A'),
      h('span', { class: 'frac-slash' }),
      h('span', { class: 'frac-den' }, 'I'),
    ),
    'Ball',
  )
}

function buildApp(): void {
  const root = document.querySelector('#app')
  if (!root) throw new Error('missing #app')
  refs.root = root as HTMLElement

  const wizardNav = h('nav', { class: 'wizard-nav', 'aria-label': 'Steps' })
  const restoreInput = h('input', { type: 'file', accept: '.zip' })
  restoreInput.hidden = true
  const backupBtn = h('button', { class: 'btn', type: 'button' }, 'Backup')
  const restoreBtn = h('button', { class: 'btn', type: 'button' }, 'Restore')

  root.replaceChildren(
    h('header', { class: 'app-header' },
      brand(),
      wizardNav,
      h('div', { class: 'header-utils row' },
        restoreInput,
        backupBtn,
        restoreBtn,
        h('label', { class: 'checkbox-row' },
          h('input', { type: 'checkbox' }),
          ' Dark',
        ),
      ),
    ),
    h('main', { class: 'app-main' },
      stepWrap(0, promptCard()),
      stepWrap(1, contractCard()),
      stepWrap(2, modelsCard()),
      stepWrap(3, settingsCard()),
      stepWrap(4, reviewCard()),
      stepWrap(5, resultsCard()),
      h('div', { class: 'wizard-buttons' },
        h('button', { class: 'btn', type: 'button' }, '← Back'),
        h('button', { class: 'btn primary wizard-next', type: 'button' }, 'Next →'),
      ),
    ),
    h('footer', { class: 'app-footer' },
      h('p', {}, 'Keys travel only to the provider you pick, directly from this page — no server, no database, no trackers. Results live in memory; export is the save.'),
    ),
  )

  refs.wizardNav = wizardNav
  refs.wizardBack = root.querySelector('.wizard-buttons button:first-child') as HTMLButtonElement
  refs.wizardNext = root.querySelector('.wizard-buttons button.primary') as HTMLButtonElement
  refs.restoreInput = restoreInput
  refs.backupBtn = backupBtn
  refs.restoreBtn = restoreBtn
  refs.restoreInput = restoreInput

  backupBtn.addEventListener('click', () => void runBackup())
  restoreBtn.addEventListener('click', () => restoreInput.click())
  restoreInput.addEventListener('change', () => void runRestore())
}

function stepWrap(step: number, ...cards: HTMLElement[]): HTMLElement {
  return h('div', { class: 'step', 'data-step': String(step) }, ...cards)
}

function promptCard(): HTMLElement {
  const system = h('textarea', { class: 'input', rows: '2', placeholder: 'System prompt (optional) — placeholders work here too', 'data-field': 'system' })
  system.value = state.system
  const prompt = h('textarea', { class: 'input', rows: '7', placeholder: 'The prompt (or mad-libs template) every selected model will receive…', 'data-field': 'prompt' })
  prompt.value = state.prompt

  const sourceTabs = h('div', { class: 'source-tabs' })
  const sheetInput = h('input', { type: 'file', accept: '.csv,.xlsx,.xls' })
  sheetInput.hidden = true
  const sheetFacts = h('span', { class: 'muted small' })
  const sheetPreview = h('div', { class: 'sheet-preview' })

  const starters = h('div', { class: 'chips' },
    h('span', { class: 'muted small' }, 'Starter:'),
    h('button', { class: 'chip', type: 'button' }, 'Creative'),
    h('button', { class: 'chip', type: 'button' }, 'Analysis'),
    h('button', { class: 'chip', type: 'button' }, 'Explain'),
    h('button', { class: 'chip', type: 'button' }, 'Summarize'),
  )

  refs.system = system
  refs.prompt = prompt
  refs.sourceTabs = sourceTabs
  refs.sheetInput = sheetInput
  refs.sheetFacts = sheetFacts
  refs.sheetPreview = sheetPreview
  refs.starters = starters

  return h('section', { class: 'card stage-card' },
    h('h2', {}, 'Prompt'),
    h('label', { class: 'field' }, h('span', {}, 'System prompt (optional)'), system),
    h('label', { class: 'field' }, h('span', {}, 'Prompt / template'), prompt),
    sourceTabs,
    sheetInput,
    sheetFacts,
    sheetPreview,
    starters,
  )
}

function modelsCard(): HTMLElement {
  const modelSearch = h('input', { class: 'input', type: 'search', placeholder: 'Filter the loaded model list…' })
  const hideFreeModels = h('input', { type: 'checkbox' })
  hideFreeModels.checked = state.hideFreeModels
  const modelList = h('div', { class: 'model-list' })
  const quickChips = h('div', { class: 'chips' })
  const manualId = h('input', { class: 'input', placeholder: 'Add any model by ID — works even if the list is empty' })
  const manualAdd = h('button', { class: 'btn', type: 'button' }, 'Add')

  // --- Provider & key band: same screen as model selection. Collapses once
  // models are loaded (summary shows the live state) and re-expands on click.
  const preset = h('select', { class: 'input' }, ...PRESETS.map(p => h('option', { value: p.id }, p.label)))
  preset.value = state.presetId
  const customBase = h('input', { class: 'input', placeholder: 'Base URL — e.g. http://localhost:8000 or https://your.llm.example' })
  customBase.value = state.customBase
  customBase.hidden = state.presetId !== 'custom'
  const keyInput = h('input', { class: 'input', type: 'password', placeholder: presetById(state.presetId).keyLabel, autocomplete: 'new-password' })
  keyInput.value = apiKey
  const remember = h('input', { type: 'checkbox' })
  remember.checked = state.keyRemember
  const loadModels = h('button', { class: 'btn', type: 'button' }, 'Load models')
  const loadFacts = h('span', { class: 'muted small' })
  const providerSummary = h('span', { class: 'provider-summary', 'aria-hidden': 'true' })
  const providerBand = h('details', { class: 'provider-band provider-card' },
    h('summary', {}, h('span', { class: 'provider-band-label' }, 'Provider & key'), providerSummary),
    h('div', { class: 'provider-band-body' },
      h('div', { class: 'field-grid' },
        h('label', { class: 'field' }, h('span', {}, 'Provider'), preset),
        h('label', { class: 'field', hidden: customBase.hidden }, h('span', {}, 'Base URL'), customBase),
        h('label', { class: 'field' }, h('span', {}, 'API key'), keyInput),
      ),
      h('label', { class: 'checkbox-row' }, remember, ' Remember key on this device (plaintext in localStorage — only on machines you trust)'),
      h('div', { class: 'row' }, loadModels, loadFacts),
    ),
  )

  const budget = h('input', { class: 'input', type: 'range', min: '0.001', max: '0.05', step: '0.0005' })
  budget.value = String(state.budget)
  const budgetFacts = h('span', { class: 'muted small' })
  const addUnderBudget = h('button', { class: 'btn', type: 'button' }, 'Add all under budget')
  const clearSelection = h('button', { class: 'btn ghost', type: 'button' }, 'Clear selection')

  const selected = h('div', { class: 'selected-list' })

  // ZDR is a routing filter, so it lives with the model filters: flipping it
  // fetches the ZDR endpoint list, keeps only ZDR-capable selections, and
  // hides everything else from the list.
  const zdr = h('input', { type: 'checkbox' })
  zdr.checked = state.zdr
  const zdrRow = h('label', { class: 'checkbox-row' }, zdr, ' ZDR only (OpenRouter — hides and deselects models without ZDR)')
  if (state.presetId !== 'openrouter') zdrRow.hidden = true

  refs.modelSearch = modelSearch
  refs.hideFreeModels = hideFreeModels
  refs.modelList = modelList
  refs.quickChips = quickChips
  refs.budget = budget
  refs.budgetFacts = budgetFacts
  refs.addUnderBudget = addUnderBudget
  refs.selected = selected
  refs.zdr = zdr
  refs.zdrRow = zdrRow
  refs.manualId = manualId
  refs.manualAdd = manualAdd
  refs.preset = preset
  refs.customBase = customBase
  refs.keyInput = keyInput
  refs.remember = remember
  refs.loadModels = loadModels
  refs.loadFacts = loadFacts
  refs.providerBand = providerBand
  refs.providerSummary = providerSummary
  clearSelection.addEventListener('click', () => {
    state.selected = []
    saveState(state)
    renderSelected()
    renderModels()
    updateRunButton()
  })

  return h('section', { class: 'card stage-card models-stage' },
    h('div', { class: 'stage-heading' }, h('span', { class: 'eyebrow' }, 'Step 3'), h('h2', {}, 'Provider & models'), h('p', {}, 'Connect a provider, then pick the models to compare. The provider band collapses once models load — open it any time to switch.'),
    ),
    providerBand,
    h('div', { class: 'models-layout' },
      h('div', { class: 'pick-col' },
        h('p', { class: 'section-label' }, 'Model list'),
        modelSearch,
        h('div', { class: 'model-filters' },
          h('label', { class: 'checkbox-row' }, hideFreeModels, ' Hide OpenRouter :free routes (they may use your data)'),
          zdrRow,
          h('span', { class: 'muted small' }, ' :batch routes are always excluded'),
        ),
        modelList,
        h('p', { class: 'section-label selected-heading' }, 'Selected models'),
        selected,
        h('div', { class: 'manual-row' }, manualId, manualAdd),
        h('div', { class: 'row' }, addUnderBudget, clearSelection, budgetFacts),
        h('label', { class: 'budget-slider' }, 'Budget (estimated $ per model per call)', budget),
        h('p', { class: 'section-label' }, 'Quick add'),
        quickChips,
      ),
    ),
  )
}

function contractCard(): HTMLElement {
  const fields = h('div', { class: 'field-table' })
  const errors = h('div', { class: 'contract-errors' })
  const rationaleFirst = h('input', { type: 'checkbox' })
  rationaleFirst.checked = state.contract.rationaleFirst ?? false
  const rationaleSpec = h('input', { class: 'input', placeholder: 'Rationale spec (shown before the answer)' })
  rationaleSpec.value = state.contract.rationaleSpec ?? ''
  const strictJson = h('input', { type: 'checkbox' })
  strictJson.checked = state.contract.strictJson !== false
  const placement = h('select', { class: 'input' },
    h('option', { value: 'system-after' }, 'System prompt, after'),
    h('option', { value: 'system-before' }, 'System prompt, before'),
    h('option', { value: 'user-after' }, 'User prompt, after'),
    h('option', { value: 'user-before' }, 'User prompt, before'),
    h('option', { value: 'none' }, 'No instruction'),
  )
  placement.value = state.placement
  const schemaPreview = h('details', { class: 'schema-preview' },
    h('summary', {}, 'JSON schema preview'),
    h('pre', {}),
  )
  const schemaBody = schemaPreview.querySelector('pre')!

  const parser = h('select', { class: 'input' },
    h('option', { value: '' }, 'No parser — keep full response'),
    ...BUILTIN_PARSERS.map(p => h('option', { value: p.id }, p.name)),
  )
  parser.value = state.parserId ?? ''

  const templateName = h('input', { class: 'input', placeholder: 'Template name' })
  const saveTemplate = h('button', { class: 'btn', type: 'button' }, 'Save as template')
  const templateSelect = h('select', { class: 'input' }, h('option', { value: '' }, 'Load a saved template…'))
  const deleteTemplate = h('button', { class: 'btn ghost', type: 'button' }, 'Delete')

  refs.contractFields = fields
  refs.contractErrors = errors
  refs.rationaleFirst = rationaleFirst
  refs.rationaleSpec = rationaleSpec
  refs.strictJson = strictJson
  refs.placement = placement
  refs.schemaPreview = schemaPreview
  refs.schemaBody = schemaBody
  refs.parser = parser
  refs.templateName = templateName
  refs.saveTemplate = saveTemplate
  refs.templateSelect = templateSelect
  refs.deleteTemplate = deleteTemplate

  return h('section', { class: 'card stage-card' },
    h('div', { class: 'stage-heading' }, h('span', { class: 'eyebrow' }, 'Step 2'), h('h2', {}, 'Output format'), h('p', {}, 'Describe the response you need. The app asks for this format and exposes each returned field as a column.'),
    ),
    h('div', { class: 'field-table-head' }, h('span', {}, 'Field'), h('span', {}, 'Type'), h('span', {}, 'Details')),
    fields,
    h('div', { class: 'contract-options' },
      h('label', { class: 'checkbox-row' }, rationaleFirst, ' Rationale first'),
      h('label', { class: 'param-field' }, h('span', {}, 'Rationale spec'), rationaleSpec),
      h('label', { class: 'checkbox-row' }, strictJson, ' Demand bare JSON (no fences, no commentary)'),
      h('label', { class: 'param-field' }, h('span', {}, 'Instruction placement'), placement),
    ),
    errors,
    schemaPreview,
    h('label', { class: 'param-field' }, h('span', {}, 'Response parser'), parser),
    h('div', { class: 'row' },
      templateName,
      saveTemplate,
      h('select', { class: 'input', style: 'flex:1' }, ...(templates.length ? templates.map(t => h('option', { value: t.id }, t.name)) : [h('option', { value: '' }, 'No saved templates')])),
      deleteTemplate,
    ),
  )
}

function reviewCard(): HTMLElement {
  const summary = h('div', { class: 'review-summary' })
  const run = h('button', { class: 'btn primary run-button review-run', type: 'button' }, 'Run comparison')
  const estimate = h('span', { class: 'muted small' })
  refs.run = run
  refs.runEstimate = estimate

  refs.reviewSummary = summary
  return h('section', { class: 'card stage-card review-stage' },
    h('div', { class: 'stage-heading' }, h('span', { class: 'eyebrow' }, 'Step 5'), h('h2', {}, 'Review your run'), h('p', {}, 'Check the scope and estimate before sending anything to a provider.'),
    ),
    summary,
    h('div', { class: 'review-action' }, run, estimate),
  )
}

function renderReview(): void {
  const summary = refs.reviewSummary
  if (!summary) return
  const selected = selectedModels()
  const caseCount = state.source.kind === 'sheet' ? sheetRows.length : 1
  const contract = buildContractContext(state.contract)
  const range = computeEstimatedRange()
  summary.replaceChildren(
    h('div', { class: 'review-item' }, h('span', {}, 'Provider'), h('strong', {}, presetById(state.presetId).label)),
    h('div', { class: 'review-item' }, h('span', {}, 'Inputs'), h('strong', {}, state.source.kind === 'sheet' ? `${caseCount} spreadsheet rows` : 'One prompt')),
    h('div', { class: 'review-item' }, h('span', {}, 'Models'), h('strong', {}, selected.length ? selected.map(m => m.id).join(', ') : 'None selected')),
    h('div', { class: 'review-item' }, h('span', {}, 'Calls'), h('strong', {}, `${caseCount * selected.length * Math.max(1, state.repeats)}`)),
    h('div', { class: 'review-item' }, h('span', {}, 'Estimated cost'), h('strong', {}, range.high ? `~${formatUsd(range.low)}–${formatUsd(range.high)} (10–${state.params.maxTokens ?? ASSUMED_OUTPUT_TOKENS} output tokens)` : 'Pricing unavailable for one or more models')),
    h('div', { class: 'review-item' }, h('span', {}, 'Concurrency'), h('strong', {}, `${state.concurrency} model calls at once`)),
    h('div', { class: 'review-item' }, h('span', {}, 'Output'), h('strong', {}, contract ? `${contract.columnCount} structured field${contract.columnCount === 1 ? '' : 's'}` : 'Full response text')),
  )
}

/** Settings are deliberately their own stage. Model selection answers “what
 * will run”; this screen answers “how will it run?” without asking novices to
 * read a provider capability matrix. */
function settingsCard(): HTMLElement {
  const paramTemp = h('input', { class: 'input', type: 'number', min: '0', max: '2', step: '0.1', placeholder: 'Leave blank to omit', 'data-field': 'temperature' })
  paramTemp.value = state.params.temperature === undefined ? '' : String(state.params.temperature)
  const paramMax = h('input', { class: 'input', type: 'number', min: '1', max: '65536', step: '32', placeholder: 'Leave blank to omit', 'data-field': 'maxTokens' })
  paramMax.value = state.params.maxTokens === undefined ? '' : String(state.params.maxTokens)
  const paramTopP = h('input', { class: 'input', type: 'number', min: '0', max: '1', step: '0.1', placeholder: 'Leave blank to omit', 'data-field': 'topP' })
  paramTopP.value = state.params.topP === undefined ? '' : String(state.params.topP)
  const stream = h('input', { type: 'checkbox', 'data-field': 'stream' })
  stream.checked = state.stream
  const streamThreshold = h('input', { class: 'input threshold-input', type: 'number', min: '1', max: '100000', step: '1', 'data-field': 'streamThreshold' })
  streamThreshold.value = String(state.streamThreshold)
  const repeats = h('input', { class: 'input', type: 'number', min: '1', max: '100', 'data-field': 'repeats' })
  repeats.value = String(state.repeats)
  const retries = h('input', { class: 'input', type: 'number', min: '0', max: '5', 'data-field': 'retries' })
  retries.value = String(state.retries)
  const concurrency = h('input', { class: 'input', type: 'number', min: '1', max: '32', 'data-field': 'concurrency' })
  concurrency.value = String(state.concurrency)

  refs.paramTemp = paramTemp
  refs.paramMax = paramMax
  refs.paramTopP = paramTopP
  refs.stream = stream
  refs.streamThreshold = streamThreshold
  refs.repeats = repeats
  refs.retries = retries
  refs.concurrency = concurrency

  return h('section', { class: 'card stage-card settings-stage' },
    h('div', { class: 'stage-heading' }, h('span', { class: 'eyebrow' }, 'Step 4'), h('h2', {}, 'Run settings'), h('p', {}, 'Choose shared defaults. Each model receives only the settings it supports.'),
    ),
    h('div', { class: 'settings-grid' },
      h('section', { class: 'settings-panel' }, h('h3', {}, 'Response settings'),
        h('label', { class: 'param-field' }, h('span', {}, 'Temperature'), paramTemp),
        h('label', { class: 'param-field' }, h('span', {}, 'Maximum output tokens'), paramMax),
        h('label', { class: 'param-field' }, h('span', {}, 'Top P'), paramTopP),
      ),
      h('section', { class: 'settings-panel' }, h('h3', {}, 'Execution'),
        h('label', { class: 'checkbox-row' }, stream, ' Stream responses'),
        h('label', { class: 'param-field inline' }, h('span', {}, '…when the run has at most'), streamThreshold, h('span', {}, 'calls (larger runs use progress counters)')),
        h('label', { class: 'param-field' }, h('span', {}, 'Repeats per input'), repeats),
        h('label', { class: 'param-field' }, h('span', {}, 'Models running at once'), concurrency),
        h('label', { class: 'param-field' }, h('span', {}, 'Retries after a transient failure'), retries),
      ),
    ),
    h('div', { class: 'settings-note' }, 'Unsupported settings are omitted automatically; no model receives an unsupported parameter.'),
  )
}

function resultsCard(): HTMLElement {
  const facts = h('span', { class: 'muted small' })
  const cancel = h('button', { class: 'btn', type: 'button', hidden: true }, 'Cancel')
  const exportXlsx = h('button', { class: 'btn', type: 'button', disabled: true }, 'Export XLSX')
  const exportCsv = h('button', { class: 'btn', type: 'button', disabled: true }, 'CSV')
  const exportJsonl = h('button', { class: 'btn', type: 'button', disabled: true }, 'JSONL')
  const exportPy = h('button', { class: 'btn', type: 'button', disabled: true }, 'Python bundle')
  const newPrompt = h('button', { class: 'btn ghost', type: 'button' }, 'New prompt')
  const resultSearch = h('input', { class: 'input result-search', type: 'search', placeholder: 'Filter model, case, or response…' })
  const resultStatus = h('select', { class: 'input result-status' },
    h('option', { value: 'all' }, 'All statuses'),
    h('option', { value: 'ok' }, 'Successful'),
    h('option', { value: 'error' }, 'Failed'),
    h('option', { value: 'pending' }, 'In progress'),
  )
  const resultsGrid = h('div', { class: 'results-grid' },
    h('p', { class: 'muted' }, 'Run a prompt to see model-by-model answers here.'),
  )

  refs.facts = facts
  refs.cancel = cancel
  refs.exportXlsx = exportXlsx
  refs.exportCsv = exportCsv
  refs.exportJsonl = exportJsonl
  refs.exportPy = exportPy
  refs.newPrompt = newPrompt
  refs.resultsGrid = resultsGrid
  refs.resultSearch = resultSearch
  refs.resultStatus = resultStatus

  return h('section', { class: 'card' },
    h('h2', {}, 'Results'),
    h('div', { class: 'results-toolbar' }, facts, cancel, exportXlsx, exportCsv, exportJsonl, exportPy, newPrompt),
    h('div', { class: 'result-filters' }, resultSearch, resultStatus),
    resultsGrid,
  )
}

// --- renderers ----------------------------------------------------------------

function selectedModels(): ModelCatalogEntry[] {
  return state.selected
    .map(id => models.find(m => m.id === id))
    .filter((m): m is ModelCatalogEntry => m !== undefined)
}

function modelCost(m: ModelCatalogEntry): number | null {
  if (!m.pricing) return null
  // Budget/add-all must use the selected upper bound, not an arbitrary 512
  // token fiction. The catalogue still shows the useful 10-token-to-max
  // range below so a novice can see the uncertainty.
  return estimateCostUsd(m.pricing, tokenEstimate || naiveTokenCount(state.prompt + state.system), state.params.maxTokens ?? ASSUMED_OUTPUT_TOKENS)
}

function modelCostRange(m: ModelCatalogEntry): { low: number; high: number } | null {
  if (!m.pricing) return null
  const input = tokenEstimate || naiveTokenCount(state.prompt + state.system)
  const highTokens = state.params.maxTokens ?? ASSUMED_OUTPUT_TOKENS
  const low = estimateCostUsd(m.pricing, input, Math.min(10, highTokens))
  const high = estimateCostUsd(m.pricing, input, highTokens)
  return low === null || high === null ? null : { low, high }
}

function sortByCost(list: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return [...list].sort((a, b) => {
    const ca = modelCost(a)
    const cb = modelCost(b)
    if (ca === null && cb === null) return a.id.localeCompare(b.id)
    if (ca === null) return 1
    if (cb === null) return -1
    return ca - cb || a.id.localeCompare(b.id)
  })
}

function fmtPerMillion(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value >= 10 ? value.toFixed(1) : value.toFixed(2)
}

function perMillionText(m: ModelCatalogEntry): string {
  if (!m.pricing) return ''
  return `$${fmtPerMillion(m.pricing.prompt * 1e6)}/${fmtPerMillion(m.pricing.completion * 1e6)}M`
}

function modelRunRange(m: ModelCatalogEntry): { low: number; high: number } | null {
  const range = modelCostRange(m)
  if (!range) return null
  const calls = (state.source.kind === 'sheet' ? Math.max(1, sheetRows.length) : 1) * Math.max(1, state.repeats)
  return { low: range.low * calls, high: range.high * calls }
}

function costSummary(m: ModelCatalogEntry): string {
  const parts: string[] = []
  const range = modelRunRange(m)
  if (range) parts.push(`~${formatUsd(range.low)}–${formatUsd(range.high)} all rows`)
  const perMillion = perMillionText(m)
  if (perMillion) parts.push(`${perMillion} / 1M`)
  return parts.join(' · ')
}

function isOpenRouterBatchModel(model: ModelCatalogEntry): boolean {
  return state.presetId === 'openrouter' && /:batch(?:$|[-:])/i.test(model.id)
}

function isOpenRouterFreeModel(model: ModelCatalogEntry): boolean {
  return state.presetId === 'openrouter' && /:free(?:$|[-:])/i.test(model.id)
}

/** One catalog predicate feeds list, quick add, budget bulk-add, and run
 * validation. Provider-side filters are not cosmetic. */
function visibleModels(): ModelCatalogEntry[] {
  return models.filter(model => {
    if (isOpenRouterBatchModel(model)) return false
    if (state.hideFreeModels && isOpenRouterFreeModel(model)) return false
    if (state.zdr && !zdrIds.has(model.id)) return false
    return true
  })
}

function renderProviderBand(): void {
  if (!refs.providerBand) return
  const preset = presetById(state.presetId)
  const keySet = apiKey.length > 0
  const parts = [preset.label]
  if (models.length > 0) parts.push(`${models.length} model${models.length === 1 ? '' : 's'}`)
  if (keySet) parts.push('key set ✓')
  else if (models.length > 0) parts.push('no key')
  refs.providerSummary.textContent = `— ${parts.join(' · ')}`
  // Collapsed once models are loaded; a novice with nothing configured yet
  // sees the form open instead of an empty screen.
  refs.providerBand.open = models.length === 0
}

function renderModels(): void {
  refs.modelList.replaceChildren()
  const query = refs.modelSearch.value.trim().toLowerCase()
  let list = visibleModels().filter(m => !query || m.id.toLowerCase().includes(query))
  list = sortByCost(list)

  if (list.length === 0) {
    refs.modelList.append(h('p', { class: 'muted small' },
      models.length === 0
        ? 'No models loaded. Pick a provider and press "Load models" — an API key is needed for providers that require one.'
        : state.zdr ? 'No ZDR-capable models match these filters.' : 'No models match these filters.',
    ))
    return
  }
  refs.loadFacts.textContent = `${list.length} of ${models.length} listed${state.zdr ? ' (ZDR only)' : ''}`
  const selectedIds = new Set(state.selected)

  for (const m of list) {
    const summary = costSummary(m)
    refs.modelList.append(h('label', { class: 'model-option' },
      h('input', { type: 'checkbox', checked: selectedIds.has(m.id) }),
      h('span', { class: 'model-id' }, m.id),
      h('span', { class: 'model-cost' }, summary),
    ))
  }
}

function renderSelected(): void {
  const selected = selectedModels()
  if (selected.length === 0) {
    refs.selected.replaceChildren(h('p', { class: 'muted small' }, 'None yet — check models in the list, quick-add below, or type a model ID.'))
  } else {
    refs.selected.replaceChildren(...selected.map(m => {
      const remove = h('button', { class: 'minibtn danger', type: 'button' }, '×')
      remove.addEventListener('click', () => {
        state.selected = state.selected.filter(id => id !== m.id)
        saveState(state)
        renderSelected()
        renderModels()
      })
      return h('div', { class: 'selected-row' },
        h('span', { class: 'selected-id' }, m.id),
        h('span', { class: 'muted small' }, m.pricing ? (modelRunRange(m) ? `~${formatUsd(modelRunRange(m)!.low)}–${formatUsd(modelRunRange(m)!.high)} all rows` : 'cost unknown') : 'cost unknown'),
        remove,
      )
    }))
  }
  updateRunButton()
}

function renderQuickChips(): void {
  const preset = presetById(state.presetId)
  const available = new Set(visibleModels().map(model => model.id))
  const curated = (QUICK_MODELS[preset.provider.group] ?? []).filter(model => available.has(model.id))
  const recent = loadRecent()
    .filter(r => r.presetId === state.presetId && !curated.some(q => q.id === r.model))
    .slice(0, 5)
  const chips = h('div', { class: 'chip-row' })
  for (const q of curated) {
    chips.append(h('button', { class: 'chip', type: 'button', title: q.id }, q.id))
  }
  for (const r of recent) {
    if (!available.has(r.model)) continue
    chips.append(h('button', { class: 'chip recent', type: 'button', title: 'recently run' }, r.model))
  }
  refs.quickChips.replaceChildren(
    h('span', { class: 'muted small' }, 'Quick add:'),
    chips.childElementCount ? chips : h('span', { class: 'muted small' }, 'run a model to keep it here'),
  )
}

function renderBudgetFacts(): void {
  const eligible = sortByCost(visibleModels().filter(m => {
    const cost = modelCost(m)
    return cost !== null && cost <= state.budget
  }))
  refs.budgetFacts.textContent = `${eligible.length} of ${models.length} models under ${formatUsd(state.budget)}`
}

function renderContract(): void {
  refs.contractFields.replaceChildren()
  const fields = state.contract.fields ?? []
  fields.forEach((field, index) => {
    const row = h('div', { class: 'field-entry' })
    const name = h('input', { class: 'input', placeholder: 'field name' })
    name.value = field.name
    const type = h('select', { class: 'input' },
      h('option', { value: 'string' }, 'string'),
      h('option', { value: 'number' }, 'number'),
      h('option', { value: 'enum' }, 'enum'),
    )
    type.value = field.type
    const remove = h('button', { class: 'minibtn danger', type: 'button' }, '×')
    remove.addEventListener('click', () => {
      state.contract.fields = fields.filter((_, i) => i !== index)
      saveState(state)
      renderContract()
    })
    row.append(
      h('label', { class: 'param-field' }, h('span', {}, 'Field'), name),
      h('label', { class: 'param-field' }, h('span', {}, 'Type'), type),
      remove,
    )
    const detail = h('div', { class: 'field-detail' })
    if (field.type === 'number') {
      const min = h('input', { class: 'input', type: 'number', placeholder: 'min' })
      min.value = field.min === undefined ? '' : String(field.min)
      const max = h('input', { class: 'input', type: 'number', placeholder: 'max' })
      max.value = field.max === undefined ? '' : String(field.max)
      const apply = () => {
        field.min = min.value === '' ? undefined : Number(min.value)
        field.max = max.value === '' ? undefined : Number(max.value)
        saveState(state)
        renderContract()
      }
      min.addEventListener('change', apply)
      max.addEventListener('change', apply)
      detail.append(
        h('label', { class: 'param-field' }, h('span', {}, 'Min'), min),
        h('label', { class: 'param-field' }, h('span', {}, 'Max'), max),
      )
    } else if (field.type === 'enum') {
      const choices = field.values ?? []
      const choiceList = h('div', { class: 'choice-editor' })
      const write = (nextValues: string[], nextNotes: Record<string, string>): void => {
        field.values = nextValues
        field.valueNotes = Object.keys(nextNotes).length ? nextNotes : undefined
        saveState(state)
        renderContract()
      }
      choices.forEach((choice, choiceIndex) => {
        const value = h('input', { class: 'input', placeholder: 'Choice' })
        value.value = choice
        const note = h('input', { class: 'input', placeholder: 'What this choice means (optional)' })
        note.value = field.valueNotes?.[choice] ?? ''
        const removeChoice = h('button', { class: 'minibtn danger', type: 'button' }, '×')
        removeChoice.addEventListener('click', () => {
          const next = choices.filter((_, index) => index !== choiceIndex)
          const notes = { ...(field.valueNotes ?? {}) }
          delete notes[choice]
          write(next, notes)
        })
        const commit = () => {
          const next = [...choices]
          const nextValue = value.value.trim()
          if (!nextValue) return
          next[choiceIndex] = nextValue
          const notes = { ...(field.valueNotes ?? {}) }
          delete notes[choice]
          if (note.value.trim()) notes[nextValue] = note.value.trim()
          write(next, notes)
        }
        value.addEventListener('change', commit)
        note.addEventListener('change', commit)
        choiceList.append(h('div', { class: 'choice-row' }, value, note, removeChoice))
      })
      const addChoice = h('button', { class: 'btn', type: 'button' }, '+ Add choice')
      addChoice.addEventListener('click', () => write([...choices, ''], { ...(field.valueNotes ?? {}) }))
      detail.append(h('div', { class: 'choice-detail' }, h('strong', {}, 'Allowed choices'), choiceList, addChoice))
    }
    const description = h('input', { class: 'input', placeholder: 'description (optional)' })
    description.value = field.description ?? ''
    description.addEventListener('change', () => {
      field.description = description.value || undefined
      saveState(state)
    })
    const commitMeta = () => {
      field.name = name.value.trim()
      field.type = type.value as ContractField['type']
      saveState(state)
      renderContract()
    }
    name.addEventListener('change', commitMeta)
    type.addEventListener('change', commitMeta)
    row.append(detail)
    row.append(h('label', { class: 'param-field' }, h('span', {}, 'Description'), description))
    refs.contractFields.append(row)
  })
  const add = h('button', { class: 'btn', type: 'button' }, '+ Add field')
  add.addEventListener('click', () => {
    state.contract.fields = [...(state.contract.fields ?? []), { name: '', type: 'string' }]
    saveState(state)
    renderContract()
  })
  refs.contractFields.append(add)
  renderContractMeta()
}

function renderContractMeta(): void {
  const { errors } = resolveContract(state.contract)
  const ctx = buildContractContext(state.contract)
  const parserNotice = ctx && state.parserId && state.parserId !== 'json-unstack'
    ? [h('p', { class: 'parser-notice' }, 'This parser will not expose the structured fields as columns. Choose “JSON Object (Unstack to Columns)” below.')]
    : []
  refs.contractErrors.replaceChildren(...errors.map(e => h('p', { class: 'contract-error' }, e.message)), ...parserNotice)
  if (ctx) {
    refs.schemaBody.textContent = JSON.stringify(ctx.schema, null, 2)
  } else {
    refs.schemaBody.textContent = ''
  }
}

function renderTemplates(): void {
  refs.templateSelect.replaceChildren(
    h('option', { value: '' }, templates.length ? 'Load a saved template…' : 'No saved templates'),
    ...templates.map(t => h('option', { value: t.id }, t.name)),
  )
}

function updateRunButton(): void {
  const selected = selectedModels()
  refreshWizard()
  if (running || models.length === 0 || selected.length === 0 || !state.prompt.trim()) {
    refs.run.disabled = true
    refs.run.textContent = selected.length ? `Run on ${selected.length} model${selected.length === 1 ? '' : 's'}` : 'Run comparison'
    if (!running) {
      let why = ''
      if (models.length === 0) why = modelsLoadedFailed ? `Blocked — ${modelsLoadedFailed}` : 'Load the model list first'
      else if (selected.length === 0) why = 'Select at least one loaded model'
      else if (!state.prompt.trim()) why = 'Write a prompt'
      refs.runEstimate.textContent = why
    }
    return
  }
  refs.run.disabled = false
  refs.run.textContent = `Run on ${selected.length} model${selected.length === 1 ? '' : 's'}`
  refs.runEstimate.textContent = estimateTotal()
}

function estimateTotal(): string {
  const range = computeEstimatedRange()
  const caseCount = state.source.kind === 'sheet' ? Math.max(1, sheetRows.length) : 1
  return range.high > 0
    ? `~${formatUsd(range.low)}–${formatUsd(range.high)} (${caseCount} case${caseCount === 1 ? '' : 's'} × ${selectedModels().length} model${selectedModels().length === 1 ? '' : 's'}${state.repeats > 1 ? ` × ${state.repeats}` : ''}; 10–${state.params.maxTokens ?? ASSUMED_OUTPUT_TOKENS} output tokens)`
    : ''
}

function computeEstimatedRange(): { low: number; high: number } {
  return selectedModels().reduce((sum, model) => {
    const range = modelRunRange(model)
    return range ? { low: sum.low + range.low, high: sum.high + range.high } : sum
  }, { low: 0, high: 0 })
}

// --- actions ------------------------------------------------------------------

/** Sheet mode: surface the columns and let the user preview the filled prompt
 * for any row before firing anything. */
function renderSheetPreview(): void {
  refs.sheetPreview.replaceChildren()
  if (state.source.kind !== 'sheet' || sheetRows.length === 0) return

  const columns = new Set<string>()
  for (const row of sheetRows) for (const key of Object.keys(row.bindings)) columns.add(key)
  const placeholders = promptPlaceholderNames(state.prompt, state.system)
  const unresolved = placeholders.filter(name => ![...columns].includes(name))

  const columnList = [...columns]
  const header = h('div', { class: 'preview-header' },
    h('strong', {}, `${sheetRows.length} rows · ${columnList.length} columns`),
    h('div', { class: 'column-inserter' }, h('span', {}, 'Insert field at cursor:'), ...columnList.map(column => {
      const button = h('button', { class: 'chip', type: 'button', title: `Insert {{${column}}}` }, `{{${column}}}`)
      button.addEventListener('click', () => insertPromptColumn(column))
      return button
    })),
    placeholders.length > 0 ? h('span', { class: 'preview-pl' }, `Template fields: ${placeholders.join(', ')}`) : null,
    unresolved.length > 0 ? h('span', { class: 'preview-warn' }, `Never bound: ${unresolved.join(', ')}`) : null,
  )

  let previewBox = h('div', { class: 'preview-prompt' })
  const renderRow = (index: number): void => {
    const row = sheetRows[index]
    if (!row) return
    const user = renderPromptTemplate(state.prompt, row.bindings)
    const system = renderPromptTemplate(state.system, row.bindings)
    previewBox.replaceChildren(
      ...(system ? [h('p', { class: 'preview-system' }, 'System: ', (() => { const t = document.createTextNode(system); return t })())] : []),
      h('p', { class: 'preview-user' }, h('span', { class: 'preview-label' }, `${row.label} →`), (() => { const t = document.createTextNode(user); return t })()),
    )
  }

  const rowSelect = h('select', { class: 'input' }, ...sheetRows.map((row, i) => h('option', { value: String(i) }, row.label)))
  rowSelect.value = String(Math.min(sheetPreviewRow, sheetRows.length - 1))
  rowSelect.addEventListener('change', () => {
    sheetPreviewRow = Number(rowSelect.value)
    renderRow(sheetPreviewRow)
  })

  const table = h('table', { class: 'sheet-table' })
  table.append(h('thead', {}, h('tr', {}, h('th', {}, '#'), ...columnList.map(column => h('th', { title: column }, column)))) )
  const body = h('tbody')
  for (const [index, row] of sheetRows.slice(0, 10).entries()) {
    const tr = h('tr', { class: index === sheetPreviewRow ? 'active' : '' })
    tr.append(h('td', { class: 'sheet-index' }, String(index + 1)))
    for (const column of columnList) {
      const value = normalizeSheetCell(row.bindings[column])
      tr.append(h('td', { title: value }, value))
    }
    tr.addEventListener('click', () => {
      sheetPreviewRow = index
      rowSelect.value = String(index)
      renderSheetPreview()
    })
    body.append(tr)
  }
  table.append(body)
  const tableWrap = h('div', { class: 'sheet-table-wrap' }, table)
  refs.sheetPreview.append(header, tableWrap, h('div', { class: 'preview-row' },
    h('label', { class: 'param-field' }, h('span', {}, 'Preview row'), rowSelect), previewBox,
  ))
  renderRow(Math.min(sheetPreviewRow, sheetRows.length - 1))
}

function insertPromptColumn(column: string): void {
  const marker = `{{${column}}}`
  const input = refs.prompt
  const start = Math.max(0, Math.min(promptCaret, input.value.length))
  input.value = `${input.value.slice(0, start)}${marker}${input.value.slice(start)}`
  state.prompt = input.value
  promptCaret = start + marker.length
  input.focus()
  input.setSelectionRange(promptCaret, promptCaret)
  saveState(state)
  scheduleTokenCount()
  renderSheetPreview()
  updateRunButton()
}

function normalizeSheetCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : String(value)
}

async function loadModels(): Promise<void> {
  const preset = presetById(state.presetId)
  const baseUrl = preset.customBase ? refs.customBase.value.trim() : preset.provider.api.baseUrl
  if (preset.customBase && !baseUrl) {
    refs.loadFacts.textContent = 'Enter the base URL first.'
    return
  }
  refs.loadModels.disabled = true
  refs.loadModels.textContent = 'Loading…'
  try {
    models = await fetchModelList(preset, baseUrl, apiKey)
    if (preset.provider.group === 'openai' || preset.provider.group === 'anthropic') {
      await enrichWithLiteLLMPricing(models, preset.provider.group)
    }
    if (state.zdr && preset.provider.group === 'openrouter') {
      zdrIds = await fetchZdrModels(baseUrl)
    }
    refs.loadFacts.textContent = `${models.length} model${models.length === 1 ? '' : 's'} loaded${preset.provider.group === 'openai' || preset.provider.group === 'anthropic' ? ' (pricing via LiteLLM)' : ''}`
  } catch (error) {
    models = []
    refs.loadFacts.textContent = `Load failed: ${(error as Error).message}`
  } finally {
    modelsLoadedFailed = models.length === 0 ? refs.loadFacts.textContent : ''
    renderProviderBand()
    renderModels()
    renderSelected()
    renderBudgetFacts()
    renderQuickChips()
    updateRunButton()
    refs.loadModels.disabled = false
    refs.loadModels.textContent = 'Load models'
  }
}

function selectModel(id: string, checked: boolean): void {
  if (checked) {
    if (state.zdr && !zdrIds.has(id)) return
    if (!state.selected.includes(id)) {
      state.selected = [...state.selected, id]
      pushRecent({ presetId: state.presetId, model: id })
      renderQuickChips()
    }
  } else {
    state.selected = state.selected.filter(s => s !== id)
  }
  saveState(state)
  renderSelected()
  renderModels()
}

function addModelById(id: string): void {
  const trimmed = id.trim()
  if (!trimmed) return
  if (state.zdr && !zdrIds.has(trimmed)) {
    refs.loadFacts.textContent = 'ZDR mode: model is not on the ZDR endpoint list.'
    return
  }
  if (!models.some(m => m.id === trimmed)) {
    models = [...models, { id: trimmed }]
  }
  selectModel(trimmed, true)
  renderModels()
}

function scheduleTokenCount(): void {
  clearTimeout(tokenTimer)
  tokenTimer = setTimeout(async () => {
    tokenEstimate = await countTokens(`${state.system}\n${state.prompt}`)
    renderModels()
    renderBudgetFacts()
    updateRunButton()
  }, 300)
}

async function run(): Promise<void> {
  if (running) return
  const preset = presetById(state.presetId)
  const baseUrl = preset.customBase ? refs.customBase.value.trim() : preset.provider.api.baseUrl
  if (preset.customBase && !baseUrl) { alert('Enter the custom endpoint base URL first.'); return }
  if (models.length === 0) { alert('Load the model list first.'); return }
  const selected = selectedModels()
  if (selected.length === 0) { alert('Add at least one loaded model.'); return }

  const provider = { ...preset.provider, api: { ...preset.provider.api, baseUrl } }
  const plan = buildPlan(state.source, state.prompt, state.system, sheetRows)
  if (plan.cases.length === 0) { alert('The sheet has no rows.'); return }
  const repeats = Math.max(1, state.repeats)
  const totalCalls = plan.cases.length * selected.length * repeats

  const estimatedRange = computeEstimatedRange()
  if (estimatedRange.high > CONFIRM_THRESHOLD_USD && !confirm(`Estimated run cost ~${formatUsd(estimatedRange.low)}–${formatUsd(estimatedRange.high)} for ${totalCalls} calls (10 to ${state.params.maxTokens ?? ASSUMED_OUTPUT_TOKENS} output tokens). Continue?`)) return

  // Move immediately. Token counting and spec construction may take a moment
  // for a large workbook; the user should see that Run was accepted.
  refs.facts.textContent = `Preparing ${totalCalls} calls…`
  goTo(5)

  const contractCtx = buildContractContext(state.contract)
  const built = await buildRunSpecs({
    provider,
    apiKey,
    models,
    selected: selected.map(m => m.id),
    repeats,
    params: state.params,
    zdr: state.zdr,
    stream: state.stream,
    streamThreshold: state.streamThreshold,
    plan,
    contractAuthoring: state.contract,
    contractPlacement: state.placement,
    strictJson: state.contract.strictJson !== false,
  })
  specs = built.specs
  const inputTokens = built.inputTokens
  const caseLabels = specs.map(spec => spec.caseLabel)

  runMeta = {
    ts: new Date().toISOString(),
    providerId: preset.id,
    providerLabel: preset.label,
    promptTemplate: plan.template,
    systemTemplate: plan.systemTemplate,
    contract: contractCtx?.contract ?? null,
    parserId: state.parserId,
    repeats,
  }

  const pricingBySpec = specs.map(spec => models.find(m => m.id === spec.model)?.pricing ?? null)

  runController = new RunController({
    concurrency: Math.min(state.concurrency, provider.execution?.maxConcurrency ?? state.concurrency),
    retry: { maxRetries: state.retries, backoffMultiplier: 2, baseDelayMs: 1000, maxDelayMs: 30000 },
    timeoutMs: provider.execution?.timeout ?? 120000,
    streamThreshold: state.streamThreshold,
    inputTokens,
    pricing: pricingBySpec,
    assumedOutputTokens: ASSUMED_OUTPUT_TOKENS,
  })

  if (!grid) grid = new ResultsGrid(refs.resultsGrid)
  // The tally mirrors the run 1:1: pending rows carry the estimate, finished
  // rows carry the actual cost, so the running total is always live, never a
  // snapshot taken at the end.
  const tally: CallResult[] = specs.map((spec, index) => {
    const estimated = estimateCostUsd(pricingBySpec[index], inputTokens[index], ASSUMED_OUTPUT_TOKENS)
    return {
      model: spec.model,
      status: 'pending' as const,
      parts: [],
      ...(estimated !== null ? { estimatedCostUsd: estimated } : {}),
    }
  })
  let finished = 0
  const liveTotal = (): number => tally.reduce((sum, result) => sum + (result.costUsd ?? result.estimatedCostUsd ?? 0), 0)
  const runningLine = (done: number): string =>
    `Running ${done}/${totalCalls} · ~${formatUsd(liveTotal())} so far${totalCalls > state.streamThreshold ? ' — streaming off (run too large)' : ''}`
  grid.reset(tally, caseLabels)

  running = true
  refs.cancel.hidden = false
  refs.run.disabled = true
  refs.exportXlsx.disabled = true
  refs.exportCsv.disabled = true
  refs.exportJsonl.disabled = true
  refs.exportPy.disabled = true
  refs.facts.textContent = runningLine(0)
  // Results is the progress screen. Do not make the user guess whether Run
  // registered while requests happen invisibly on the review step.
  const outcome = await runController.start(
    specs,
    (index, result) => {
      tally[index] = result
      if (result.status === 'ok' || result.status === 'error') finished++
      grid?.update(index, result)
      refs.facts.textContent = runningLine(finished)
    },
    (index, progress) => {
      grid?.update(index, {
        model: specs[index]!.model,
        status: 'pending',
        parts: [{ kind: 'text', text: progress.text }],
        thinking: progress.thinking || undefined,
      })
      refs.facts.textContent = runningLine(finished)
    },
    (index, event) => grid?.markRetrying(index, event.attempt, event.maxRetries),
  )
  running = false
  refs.cancel.hidden = true
  updateRunButton()
  results = outcome.results
  const ok = results.filter(r => r.status === 'ok').length
  const totalCost = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
  const costLabel = totalCost > 0 ? ` · ~${formatUsd(totalCost)} actual` : ''
  refs.facts.textContent = `${outcome.elapsedMs} ms — ${ok} ok · ${results.length - ok} failed${costLabel}`
  refs.exportXlsx.disabled = false
  refs.exportCsv.disabled = false
  refs.exportJsonl.disabled = false
  refs.exportPy.disabled = false
  grid?.showCompleted(runMeta, specs, results, state.parserId)
  for (const spec of specs) pushRecent({ presetId: state.presetId, model: spec.model })
  renderQuickChips()
}

function cancelRun(): void {
  runController?.abort()
}

function exportRows() {
  if (!runMeta) return null
  return buildRows(runMeta, specs, results, state.parserId)
}

function exportXlsx(): void {
  const built = exportRows()
  if (!built) return
  download(`multiaiball-${fileStamp(runMeta!.ts)}.xlsx`, toXLSX(built.rows, built.columns), XLSX_MIME)
}

function exportCsv(): void {
  const built = exportRows()
  if (!built) return
  download(`multiaiball-${fileStamp(runMeta!.ts)}.csv`, toCSV(built.rows, built.columns), 'text/csv;charset=utf-8')
}

function exportJsonl(): void {
  const built = exportRows()
  if (!built) return
  download(`multiaiball-${fileStamp(runMeta!.ts)}.jsonl`, toJSONL(built.rows, built.columns), 'application/x-ndjson')
}

async function exportPy(): Promise<void> {
  if (!runMeta || specs.length === 0) return
  const parser = BUILTIN_PARSERS.find(p => p.id === state.parserId) ?? null
  const blob = await buildBundleZip({
    name: 'MultAIBall run',
    meta: runMeta,
    specs,
    parser,
  })
  download(`multiaiball-${fileStamp(runMeta.ts)}-python.zip`, blob, ZIP_MIME)
}

function newRun(): void {
  if (results.length > 0 && !confirm('Clear results and start over? Export first if you want the data.')) return
  results = []
  specs = []
  runMeta = null
  state.prompt = ''
  state.system = ''
  state.selected = []
  state.source = { kind: 'single' }
  sheetRows = []
  refs.prompt.value = ''
  refs.system.value = ''
  refs.sheetFacts.textContent = ''
  refs.facts.textContent = ''
  refs.exportXlsx.disabled = true
  refs.exportCsv.disabled = true
  refs.exportJsonl.disabled = true
  refs.exportPy.disabled = true
  grid?.clear()
  refs.resultsGrid.replaceChildren(h('p', { class: 'muted' }, 'Run a prompt to see model-by-model answers here.'))
  saveState(state)
  renderSelected()
  renderModels()
  goTo(0)
}

function renderSourceTabs(): void {
  const tabs = [
    h('button', { class: `chip ${state.source.kind === 'single' ? 'active' : ''}`, type: 'button' }, 'Single prompt'),
    h('button', { class: `chip ${state.source.kind === 'sheet' ? 'active' : ''}`, type: 'button' }, 'Spreadsheet × template'),
  ]
  if (state.source.kind === 'sheet') {
    tabs.push(h('button', { class: 'chip accent', type: 'button' }, 'Upload sheet…'))
  }
  refs.sourceTabs.replaceChildren(...tabs)
  refs.sheetFacts.textContent = state.source.kind === 'sheet'
    ? (sheetRows.length ? `${sheetRows.length} rows loaded — placeholders like {{column}} are filled per row` : 'Upload a CSV/XLSX sheet (first row = column names)')
    : ''
  renderSheetPreview()
}

// --- listeners ----------------------------------------------------------------

function setupListeners(): void {
  refs.preset.addEventListener('change', () => {
    state.presetId = refs.preset.value
    const preset = presetById(state.presetId)
    refs.customBase.hidden = !preset.customBase
    refs.keyInput.placeholder = preset.keyLabel
    refs.zdrRow.hidden = preset.provider.group !== 'openrouter'
    models = []
    zdrIds = new Set()
    state.selected = []
    renderProviderBand()
    renderModels()
    renderQuickChips()
    saveState(state)
  })

  refs.customBase.addEventListener('change', () => {
    state.customBase = refs.customBase.value.trim()
    saveState(state)
  })

  refs.keyInput.addEventListener('input', () => {
    apiKey = refs.keyInput.value.trim()
    saveKey(apiKey, refs.remember.checked)
  })

  refs.remember.addEventListener('change', () => {
    state.keyRemember = refs.remember.checked
    saveKey(apiKey, refs.remember.checked)
    saveState(state)
  })

  refs.loadModels.addEventListener('click', () => void loadModels())

  refs.prompt.addEventListener('input', () => {
    state.prompt = refs.prompt.value
    promptCaret = refs.prompt.selectionStart ?? refs.prompt.value.length
    updateRunButton()
    scheduleTokenCount()
    if (state.source.kind === 'sheet') renderSheetPreview()
    saveState(state)
  })
  for (const event of ['click', 'keyup', 'select'] as const) {
    refs.prompt.addEventListener(event, () => { promptCaret = refs.prompt.selectionStart ?? refs.prompt.value.length })
  }

  refs.system.addEventListener('input', () => {
    state.system = refs.system.value
    scheduleTokenCount()
    saveState(state)
  })

  refs.starters.addEventListener('click', ev => {
    const btn = (ev.target as HTMLElement).closest('button')
    if (!btn) return
    const STARTERS: Record<string, string> = {
      Creative: 'Write a creative short story about:',
      Analysis: 'Analyze the following text and provide insights:',
      Explain: 'Explain this concept in simple terms:',
      Summarize: 'Summarize the following content:',
    }
    const next = STARTERS[btn.textContent ?? '']
    if (!next) return
    refs.prompt.value = next
    state.prompt = next
    updateRunButton()
    scheduleTokenCount()
    saveState(state)
  })

  // source tabs: single vs sheet
  refs.sourceTabs.addEventListener('click', ev => {
    const btn = (ev.target as HTMLElement).closest('button')
    if (!btn) return
    if (btn.textContent === 'Upload sheet…') {
      refs.sheetInput.click()
      return
    }
    state.source = btn.textContent!.startsWith('Single') ? { kind: 'single' } : { kind: 'sheet', template: state.prompt, name: 'Sheet' }
    renderSourceTabs()
    updateRunButton()
    saveState(state)
  })
  refs.sheetInput.addEventListener('change', () => {
    const file = refs.sheetInput.files?.[0]
    if (!file) return
    void file.arrayBuffer().then(buffer => {
      try {
        sheetRows = parseSheetBytes(buffer)
        sheetPreviewRow = 0
        renderSourceTabs()
        updateRunButton()
        scheduleTokenCount()
      } catch (error) {
        refs.sheetFacts.textContent = `Sheet parse failed: ${(error as Error).message}`
      }
    })
  })
  renderSourceTabs()

  refs.modelSearch.addEventListener('input', () => renderModels())
  refs.hideFreeModels.addEventListener('change', () => {
    state.hideFreeModels = refs.hideFreeModels.checked
    // A hidden route is not a selected route. This prevents a privacy filter
    // from being cosmetic and prevents stale batch/free ids reaching RunSpec.
    state.selected = state.selected.filter(id => visibleModels().some(model => model.id === id))
    saveState(state)
    renderModels()
    renderSelected()
    renderQuickChips()
    renderBudgetFacts()
  })
  refs.modelList.addEventListener('change', ev => {
    const input = (ev.target as HTMLElement).closest('input[type=checkbox]')
    if (!input) return
    const option = input.closest('.model-option')
    if (!option) return
    const id = option.querySelector('.model-id')?.textContent ?? ''
    if (id) selectModel(id, (input as HTMLInputElement).checked)
  })

  refs.manualAdd.addEventListener('click', () => void addModelById(refs.manualId.value))
  refs.manualId.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') {
      ev.preventDefault()
      addModelById(refs.manualId.value)
      refs.manualId.value = ''
    }
  })

  refs.budget.addEventListener('input', () => {
    state.budget = Number(refs.budget.value)
    renderBudgetFacts()
    saveState(state)
  })
  refs.addUnderBudget.addEventListener('click', () => void (async () => {
    if (tokenEstimate === 0) tokenEstimate = await countTokens(`${state.system}\n${state.prompt}`)
    let added = 0
    for (const m of sortByCost(visibleModels())) {
      const cost = modelCost(m)
      if (cost !== null && cost <= state.budget) {
        selectModel(m.id, true)
        added++
      }
    }
    renderBudgetFacts()
    renderModels()
    refs.budgetFacts.textContent = `${added} model(s) added under ${formatUsd(state.budget)}`
  })())

  for (const [input, key] of [[refs.paramTemp, 'temperature'], [refs.paramMax, 'maxTokens'], [refs.paramTopP, 'topP']] as const) {
    input.addEventListener('change', () => {
      const raw = input.value.trim()
      ;(state.params as Record<string, number | undefined>)[key] = raw === '' ? undefined : Number(raw)
      saveState(state)
      renderModels()
      renderBudgetFacts()
      updateRunButton()
    })
  }

  refs.stream.addEventListener('change', () => {
    state.stream = refs.stream.checked
    saveState(state)
  })
  refs.streamThreshold.addEventListener('change', () => {
    state.streamThreshold = Math.max(1, Math.min(100000, Number(refs.streamThreshold.value) || 100))
    refs.streamThreshold.value = String(state.streamThreshold)
    saveState(state)
  })
  refs.zdr.addEventListener('change', () => {
    state.zdr = refs.zdr.checked
    saveState(state)
    void (async () => {
      if (state.zdr && state.presetId === 'openrouter') {
        try {
          zdrIds = await fetchZdrModels(presetById('openrouter').provider.api.baseUrl)
        } catch (error) {
          refs.runEstimate.textContent = `Could not load ZDR routes: ${(error as Error).message}`
          refs.zdr.checked = false
          state.zdr = false
        }
      }
      state.selected = state.selected.filter(id => visibleModels().some(model => model.id === id))
      renderModels()
      renderSelected()
      renderQuickChips()
      renderBudgetFacts()
    })()
  })
  refs.repeats.addEventListener('change', () => {
    state.repeats = Math.max(1, Number(refs.repeats.value) || 1)
    updateRunButton()
    saveState(state)
  })
  refs.retries.addEventListener('change', () => {
    state.retries = Math.max(0, Math.min(5, Number(refs.retries.value) || 0))
    saveState(state)
  })
  refs.concurrency.addEventListener('change', () => {
    state.concurrency = Math.max(1, Math.min(32, Number(refs.concurrency.value) || 1))
    refs.concurrency.value = String(state.concurrency)
    saveState(state)
  })

  refs.run.addEventListener('click', () => void run())
  refs.resultSearch.addEventListener('input', () => grid?.setFilter(refs.resultSearch.value, refs.resultStatus.value))
  refs.resultStatus.addEventListener('change', () => grid?.setFilter(refs.resultSearch.value, refs.resultStatus.value))
  refs.cancel.addEventListener('click', cancelRun)

  refs.exportXlsx.addEventListener('click', exportXlsx)
  refs.exportCsv.addEventListener('click', exportCsv)
  refs.exportJsonl.addEventListener('click', exportJsonl)
  refs.exportPy.addEventListener('click', () => void exportPy())
  refs.newPrompt.addEventListener('click', newRun)

  refs.rationaleFirst.addEventListener('change', () => {
    state.contract.rationaleFirst = refs.rationaleFirst.checked
    saveState(state)
    renderContractMeta()
  })
  refs.rationaleSpec.addEventListener('change', () => {
    state.contract.rationaleSpec = refs.rationaleSpec.value
    saveState(state)
    renderContractMeta()
  })
  refs.strictJson.addEventListener('change', () => {
    state.contract.strictJson = refs.strictJson.checked
    saveState(state)
    renderContractMeta()
  })
  refs.placement.addEventListener('change', () => {
    state.placement = refs.placement.value as ContractPlacement
    saveState(state)
  })
  refs.parser.addEventListener('change', () => {
    state.parserId = refs.parser.value || null
    saveState(state)
  })

  refs.saveTemplate.addEventListener('click', () => {
    const name = refs.templateName.value.trim()
    if (!name) { alert('Name the template first.'); return }
    templates = [...templates.filter(t => t.name !== name), {
      id: `${Date.now()}`,
      name,
      template: state.prompt,
      system: state.system,
      contract: state.contract,
      parserId: state.parserId,
      updated: new Date().toISOString(),
    }]
    saveTemplates(templates)
    refs.templateName.value = ''
    renderTemplates()
  })
  refs.templateSelect.addEventListener('change', () => {
    const t = templates.find(t => t.id === refs.templateSelect.value)
    if (!t) return
    state.prompt = t.template
    state.system = t.system
    state.contract = t.contract
    state.parserId = t.parserId
    refs.prompt.value = t.template
    refs.system.value = t.system
    refs.parser.value = t.parserId ?? ''
    refs.rationaleFirst.checked = t.contract.rationaleFirst ?? false
    refs.rationaleSpec.value = t.contract.rationaleSpec ?? ''
    refs.strictJson.checked = t.contract.strictJson !== false
    saveState(state)
    renderContract()
    updateRunButton()
  })
  refs.deleteTemplate.addEventListener('click', () => {
    templates = templates.filter(t => t.id !== refs.templateSelect.value)
    saveTemplates(templates)
    renderTemplates()
  })

  const darkInput = refs.root.querySelector('.app-header input[type=checkbox]') as HTMLInputElement
  darkInput.checked = state.dark
  darkInput.addEventListener('change', () => {
    state.dark = darkInput.checked
    document.documentElement.dataset.theme = state.dark ? 'dark' : 'light'
    saveState(state)
  })
}

// --- step wizard ---------------------------------------------------------------

const WIZARD_STEPS = ['Prompt & data', 'Output format', 'Provider & models', 'Run settings', 'Review & run', 'Results']
let currentStep = 0

function wizardGate(step: number): { ok: boolean; why: string } {
  if (step === 0) return state.prompt.trim().length > 0 ? { ok: true, why: '' } : { ok: false, why: 'Write a prompt first' }
  if (step === 2) {
    if (models.length === 0) return { ok: false, why: modelsLoadedFailed || 'Load the model list first (provider band above)' }
    if (selectedModels().length === 0) return { ok: false, why: 'Select at least one loaded model' }
    return { ok: true, why: '' }
  }
  return { ok: true, why: '' }
}

function goTo(step: number): void {
  if (step > currentStep && !wizardGate(currentStep).ok) return
  currentStep = Math.max(0, Math.min(WIZARD_STEPS.length - 1, step))
  saveState(state)
  document.querySelectorAll<HTMLElement>('.step').forEach(el => {
    el.classList.toggle('active', Number(el.dataset.step) === currentStep)
  })
  refs.wizardNav.replaceChildren(...WIZARD_STEPS.map((label, i) => {
    const chip = h('button', {
      class: `step-chip ${i === currentStep ? 'active' : ''} ${i < currentStep ? 'done' : ''}`,
      type: 'button',
      disabled: i > currentStep || (i === currentStep + 1 && !wizardGate(currentStep).ok),
    }, `${i + 1}. ${label}`)
    chip.addEventListener('click', () => goTo(i))
    return chip
  }))
  refs.wizardBack.disabled = currentStep === 0
  if (currentStep === 4) renderReview()
  refreshWizard()
}

/** Re-evaluate the current step's gate without navigating. Called whenever a
 * required condition (prompt, model selection) may have just been met. */
function refreshWizard(): void {
  if (!refs.wizardNext) return
  const gate = wizardGate(currentStep)
  refs.wizardNext.disabled = currentStep >= 4 || currentStep === WIZARD_STEPS.length - 1 || !gate.ok
  refs.wizardNext.textContent = 'Next →'
  refs.wizardNext.title = gate.ok ? '' : gate.why
  refs.wizardNext.hidden = currentStep >= 4
}

function wireWizard(): void {
  refs.wizardBack.addEventListener('click', () => goTo(currentStep - 1))
  refs.wizardNext.addEventListener('click', () => {
    goTo(currentStep + 1)
  })
  goTo(0)
}

// --- backup / restore -----------------------------------------------------------

interface BackupFile {
  version: number
  createdAt: string
  state: PersistedState
  templates: SavedTemplate[]
  recent: RecentItem[]
  run: { meta: RunMeta; specs: RunSpec[]; results: CallResult[] } | null
}

async function runBackup(): Promise<void> {
  const backup: BackupFile = {
    version: 1,
    createdAt: new Date().toISOString(),
    state: { ...state, keyRemember: true },
    templates,
    recent: loadRecent(),
    run: runMeta && specs.length ? { meta: runMeta, specs, results } : null,
  }
  const zip = new JSZip()
  zip.file('multiaiball-backup.json', JSON.stringify(backup, null, 2))
  const blob = await zip.generateAsync({ type: 'blob' })
  download(`multiaiball-backup-${fileStamp(new Date().toISOString())}.zip`, blob, ZIP_MIME)
}

async function runRestore(): Promise<void> {
  const file = refs.restoreInput.files?.[0]
  if (!file) return
  try {
    const zip = await JSZip.loadAsync(await file.arrayBuffer())
    const raw = await zip.file('multiaiball-backup.json')?.async('string')
    if (!raw) throw new Error('backup.json missing from the archive')
    const backup = JSON.parse(raw) as BackupFile

    if (backup.state && typeof backup.state === 'object') {
      Object.assign(state, defaultState(), backup.state)
      refs.keyInput.value = ''
    }
    if (Array.isArray(backup.templates)) {
      templates = backup.templates
      saveTemplates(templates)
    }
    if (Array.isArray(backup.recent)) {
      localStorage.setItem(RECENT_KEY, JSON.stringify(backup.recent))
    }
    if (backup.run) {
      specs = backup.run.specs
      results = backup.run.results
      runMeta = backup.run.meta
      if (!grid) grid = new ResultsGrid(refs.resultsGrid)
      grid.reset(results, specs.map(s => s.caseLabel))
      refs.exportXlsx.disabled = false
      refs.exportCsv.disabled = false
      refs.exportJsonl.disabled = false
      refs.exportPy.disabled = false
    }
    applyRestoredState()
    alert('Backup restored.')
  } catch (error) {
    alert(`Restore failed: ${(error as Error).message}`)
  }
}

/** Re-sync every input from the (possibly restored) persisted state. */
function applyRestoredState(): void {
  const preset = presetById(state.presetId)
  refs.preset.value = state.presetId
  refs.customBase.hidden = !preset.customBase
  refs.customBase.value = state.customBase
  refs.keyInput.placeholder = preset.keyLabel
  refs.zdrRow.hidden = preset.provider.group !== 'openrouter'
  refs.zdr.checked = state.zdr
  refs.stream.checked = state.stream
  refs.streamThreshold.value = String(state.streamThreshold)
  refs.repeats.value = String(state.repeats)
  refs.retries.value = String(state.retries)
  refs.concurrency.value = String(state.concurrency)
  refs.budget.value = String(state.budget)
  refs.paramTemp.value = state.params.temperature === undefined ? '' : String(state.params.temperature)
  refs.paramMax.value = state.params.maxTokens === undefined ? '' : String(state.params.maxTokens)
  refs.paramTopP.value = state.params.topP === undefined ? '' : String(state.params.topP)
  refs.prompt.value = state.prompt
  refs.system.value = state.system
  refs.parser.value = state.parserId ?? ''
  refs.rationaleFirst.checked = state.contract.rationaleFirst ?? false
  refs.rationaleSpec.value = state.contract.rationaleSpec ?? ''
  refs.strictJson.checked = state.contract.strictJson !== false
  refs.placement.value = state.placement
  models = []
  zdrIds = new Set()
  renderProviderBand()
  renderModels()
  renderSelected()
  renderQuickChips()
  renderBudgetFacts()
  renderContract()
  renderTemplates()
  updateRunButton()
  renderSourceTabs()
}

function init(): void {
  buildApp()
  document.documentElement.dataset.theme = state.dark ? 'dark' : 'light'
  renderModels()
  renderSelected()
  renderQuickChips()
  renderBudgetFacts()
  renderContract()
  renderTemplates()
  updateRunButton()
  setupListeners()
  wireWizard()
  scheduleTokenCount()
}

init()
