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

import { buildPlan, parseSheetBytes } from '../core/cases'
import type { SheetRow } from '../core/cases'
import { buildContractContext, resolveContract } from '../core/contract'
import { buildRows, download, fileStamp, toCSV, toJSONL, toXLSX, XLSX_MIME } from '../core/export'
import { estimateCostUsd, formatUsd } from '../core/pricing'
import { buildBundleZip, ZIP_MIME } from '../core/py'
import { BUILTIN_PARSERS } from '../core/parsers'
import { presetById } from '../core/providers'
import { buildRunSpecs, RunController } from '../core/run'
import { countTokens } from '../core/tokenizer'
import { promptPlaceholderNames, renderPromptTemplate } from '../core/template'
import type { CallResult, ContractField, ContractPlacement, ModelCatalogEntry, RunMeta, RunSpec } from '../core/types'
import { defaultState, loadKey, loadRecent, loadState, loadTemplates, pushRecent, saveState, saveTemplates, RECENT_KEY } from '../state'
import type { PersistedState, RecentItem, SavedTemplate } from '../state'
import { h } from './dom'
import { ResultsGrid } from './grid'
import type { AppSession } from './model'
import { planFingerprint, stageGate } from './model'
import { Wizard } from './wizard'
import { buildModelsStage } from './stages/provider-models'
import { estimateTotalRange, estimateTotalText, selectedModels, type CostInputs } from './costs'

const persisted = loadState()
const state: PersistedState = persisted

let apiKey = loadKey(state.keyRemember)
let models: ModelCatalogEntry[] = []
let zdrIds = new Set<string>()
/** The provider/base URL pair `models` was loaded for (model.ts cache rule). */
let modelsCarriedBy = ''
let resultsFingerprint: string | null = null
let wizard: Wizard | null = null
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
  system: HTMLTextAreaElement
  prompt: HTMLTextAreaElement
  starters: HTMLDivElement
  sourceTabs: HTMLDivElement
  sheetInput: HTMLInputElement
  sheetFacts: HTMLSpanElement
  sheetPreview: HTMLDivElement
  paramTemp: HTMLInputElement
  paramMax: HTMLInputElement
  paramTopP: HTMLInputElement
  stream: HTMLInputElement
  streamThreshold: HTMLInputElement
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
  resultsStale: HTMLElement
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

// The provider & models stage owns its whole subtree; the app only supplies
// state access and refresh hooks (see stages/provider-models.ts).
const modelsStage = buildModelsStage({
  read: () => ({
    state,
    apiKey,
    models,
    zdrIds,
    modelsCarriedBy,
    tokenEstimate,
    sheetRowCount: sheetRows.length,
  }),
  write: patch => {
    if (patch.apiKey !== undefined) apiKey = patch.apiKey
    if (patch.models !== undefined) models = patch.models
    if (patch.zdrIds !== undefined) zdrIds = patch.zdrIds
    if (patch.modelsCarriedBy !== undefined) modelsCarriedBy = patch.modelsCarriedBy
  },
  saveState: () => saveState(state),
  refresh: () => {
    wizard?.refresh()
    updateRunButton()
  },
})

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
      stepWrap(2, modelsStage.el),
      stepWrap(3, settingsCard()),
      stepWrap(4, reviewCard()),
      stepWrap(5, resultsCard()),
      h('div', { class: 'wizard-buttons' },
        h('button', { class: 'btn', type: 'button' }, '← Back'),
        h('p', { class: 'wizard-blocker', hidden: true }),
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

  wizard = new Wizard({
    nav: wizardNav,
    back: refs.wizardBack,
    next: refs.wizardNext,
    blocker: root.querySelector('.wizard-blocker') as HTMLElement,
    gate: wizardGateForStep,
    onStep: step => {
      if (step === 4) renderReview()
      if (step === 5) renderResultsStale()
    },
  })
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
    h('div', { class: 'stage-heading' }, h('h2', {}, 'Prompt')),
    h('label', { class: 'field' }, h('span', {}, 'System prompt (optional)'), system),
    h('label', { class: 'field' }, h('span', {}, 'Prompt / template'), prompt),
    sourceTabs,
    sheetInput,
    sheetFacts,
    sheetPreview,
    starters,
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
  const templateSelect = h('select', { class: 'input', style: 'flex:1' }, h('option', { value: '' }, 'Load a saved template…'))
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
    h('div', { class: 'stage-heading' }, h('h2', {}, 'Output format'), h('p', {}, 'Each field you describe becomes a column in the export.')),
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
      templateSelect,
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
    h('div', { class: 'stage-heading' }, h('h2', {}, 'Review your run'), h('p', {}, 'Nothing has been sent to a provider yet.')),
    summary,
    h('div', { class: 'review-action' }, run, estimate),
  )
}

function renderReview(): void {
  const summary = refs.reviewSummary
  if (!summary) return
  const selected = selectedModels({ models, selected: state.selected })
  const caseCount = state.source.kind === 'sheet' ? sheetRows.length : 1
  const contract = buildContractContext(state.contract)
  const range = estimateTotalRange(costInputs())
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
    h('div', { class: 'stage-heading' }, h('h2', {}, 'Run settings'), h('p', {}, 'Shared defaults — each model receives only the settings it supports.')),
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
  const resultsStale = h('p', { class: 'results-stale', hidden: true })
  const resultsGrid = h('div', { class: 'results-grid' },
    h('p', { class: 'muted' }, 'Run a prompt to see model-by-model answers here.'),
  )

  refs.facts = facts
  refs.resultsStale = resultsStale
  refs.cancel = cancel
  refs.exportXlsx = exportXlsx
  refs.exportCsv = exportCsv
  refs.exportJsonl = exportJsonl
  refs.exportPy = exportPy
  refs.newPrompt = newPrompt
  refs.resultsGrid = resultsGrid
  refs.resultSearch = resultSearch
  refs.resultStatus = resultStatus

  return h('section', { class: 'card stage-card' },
    h('div', { class: 'stage-heading' }, h('h2', {}, 'Results')),
    resultsStale,
    h('div', { class: 'results-toolbar' }, facts, cancel, exportXlsx, exportCsv, exportJsonl, exportPy, newPrompt),
    h('div', { class: 'result-filters' }, resultSearch, resultStatus),
    resultsGrid,
  )
}

// --- derived state bridging (costs + gates) -----------------------------------

function costInputs(): CostInputs {
  return {
    models,
    selected: state.selected,
    tokenEstimate,
    prompt: state.prompt,
    system: state.system,
    params: state.params,
    repeats: state.repeats,
    caseCount: state.source.kind === 'sheet' ? Math.max(1, sheetRows.length) : 1,
  }
}

function sessionSnapshot(): AppSession {
  return { apiKey, models, zdrIds, sheetRowCount: sheetRows.length, tokenEstimate, modelsCarriedBy }
}

function wizardGateForStep(step: number): { ok: boolean; why: string; canRun: boolean } {
  return stageGate(step, {
    state,
    session: sessionSnapshot(),
    preset: presetById(state.presetId),
    baseUrl: modelsStage.currentBaseUrl(),
    contractOk: resolveContract(state.contract).errors.length === 0,
  })
}

/** Flags displayed results as stale once the authoring the run came from no
 * longer matches what the UI currently holds (plan.fingerprint). */
function renderResultsStale(): void {
  if (!refs.resultsStale) return
  if (!resultsFingerprint || results.length === 0) {
    refs.resultsStale.hidden = true
    return
  }
  const current = planFingerprint({
    state,
    session: { sheetRowCount: sheetRows.length },
    // Must match run(): plan.template is always state.prompt for both sources.
    sheetTemplate: state.prompt,
  })
  const stale = current !== resultsFingerprint
  refs.resultsStale.hidden = !stale
  refs.resultsStale.textContent = 'These results match an earlier version of your prompt, models, or settings — run again to refresh them.'
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
  const selected = selectedModels({ models, selected: state.selected })
  wizard?.refresh()
  if (running || models.length === 0 || selected.length === 0 || !state.prompt.trim()) {
    refs.run.disabled = true
    refs.run.textContent = selected.length ? `Run on ${selected.length} model${selected.length === 1 ? '' : 's'}` : 'Run comparison'
    if (!running) {
      let why = ''
      if (models.length === 0) why = 'Load the model list first (provider band above)'
      else if (selected.length === 0) why = 'Select at least one loaded model'
      else if (!state.prompt.trim()) why = 'Write a prompt'
      refs.runEstimate.textContent = why
    }
    return
  }
  refs.run.disabled = false
  refs.run.textContent = `Run on ${selected.length} model${selected.length === 1 ? '' : 's'}`
  refs.runEstimate.textContent = estimateTotalText(costInputs())
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

function scheduleTokenCount(): void {
  clearTimeout(tokenTimer)
  tokenTimer = setTimeout(async () => {
    tokenEstimate = await countTokens(`${state.system}\n${state.prompt}`)
    modelsStage.sync()
  }, 300)
}

async function run(): Promise<void> {
  if (running) return
  const preset = presetById(state.presetId)
  const baseUrl = modelsStage.currentBaseUrl()
  if (preset.customBase && !baseUrl) { alert('Enter the custom endpoint base URL first.'); return }
  if (models.length === 0) { alert('Load the model list first.'); return }
  const selected = selectedModels({ models, selected: state.selected })
  if (selected.length === 0) { alert('Add at least one loaded model.'); return }

  const provider = { ...preset.provider, api: { ...preset.provider.api, baseUrl } }
  const plan = buildPlan(state.source, state.prompt, state.system, sheetRows)
  if (plan.cases.length === 0) { alert('The sheet has no rows.'); return }
  const repeats = Math.max(1, state.repeats)
  const totalCalls = plan.cases.length * selected.length * repeats

  const estimatedRange = estimateTotalRange(costInputs())
  if (estimatedRange.high > CONFIRM_THRESHOLD_USD && !confirm(`Estimated run cost ~${formatUsd(estimatedRange.low)}–${formatUsd(estimatedRange.high)} for ${totalCalls} calls (10 to ${state.params.maxTokens ?? ASSUMED_OUTPUT_TOKENS} output tokens). Continue?`)) return

  // Move immediately. Token counting and spec construction may take a moment
  // for a large workbook; the user should see that Run was accepted.
  refs.facts.textContent = `Preparing ${totalCalls} calls…`
  resultsFingerprint = planFingerprint({
    state,
    session: { sheetRowCount: sheetRows.length },
    sheetTemplate: plan.template,
  })
  wizard?.goTo(5)

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
  renderResultsStale()
  for (const spec of specs) pushRecent({ presetId: state.presetId, model: spec.model })
  modelsStage.sync()
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
  modelsStage.sync()
  wizard?.goTo(0)
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

  for (const [input, key] of [[refs.paramTemp, 'temperature'], [refs.paramMax, 'maxTokens'], [refs.paramTopP, 'topP']] as const) {
    input.addEventListener('change', () => {
      const raw = input.value.trim()
      ;(state.params as Record<string, number | undefined>)[key] = raw === '' ? undefined : Number(raw)
      saveState(state)
      modelsStage.sync()
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
    state: { ...state },
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
      apiKey = ''
      modelsCarriedBy = ''
      saveState(state)
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
      resultsFingerprint = 'restored'
      if (!grid) grid = new ResultsGrid(refs.resultsGrid)
      grid.showCompleted(runMeta, specs, results, runMeta.parserId)
      refs.exportXlsx.disabled = false
      refs.exportCsv.disabled = false
      refs.exportJsonl.disabled = false
      refs.exportPy.disabled = false
    }
    applyRestoredState()
    if (backup.run) wizard?.goTo(5)
    alert('Backup restored.')
  } catch (error) {
    alert(`Restore failed: ${(error as Error).message}`)
  }
}

/** Re-sync every input from the (possibly restored) persisted state. */
function applyRestoredState(): void {
  refs.stream.checked = state.stream
  refs.streamThreshold.value = String(state.streamThreshold)
  refs.repeats.value = String(state.repeats)
  refs.retries.value = String(state.retries)
  refs.concurrency.value = String(state.concurrency)
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
  modelsCarriedBy = ''
  modelsStage.applyRestored()
  renderContract()
  renderTemplates()
  updateRunButton()
  renderSourceTabs()
}

function init(): void {
  buildApp()
  document.documentElement.dataset.theme = state.dark ? 'dark' : 'light'
  modelsStage.sync()
  renderContract()
  renderTemplates()
  updateRunButton()
  setupListeners()
  scheduleTokenCount()
}

init()
