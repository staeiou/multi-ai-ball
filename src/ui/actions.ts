// Everything the screens can ask the app to do. Screens never touch the
// network, the run, or storage directly; they call these and re-render from
// the store.

import JSZip from 'jszip'

import { fetchCatalog, fetchZdrModels } from '../core/catalog'
import { parseSheetBytes } from '../core/cases'
import type { SheetWorkerFailure, SheetWorkerResponse } from '../core/sheet.worker'
import { buildCompletedDatasets, buildRows, download, fileStamp, plainColumns, toCSV, toJSONL, toXLSX, XLSX_MIME } from '../core/export'
import { freezeRun } from '../core/freeze'
import { presetById } from '../core/providers/presets'
import { buildBundleZip, ZIP_MIME } from '../core/py'
import { sha256Hex } from '../core/render'
import { RunController, pendingRows } from '../core/run'
import { appendRow, deleteRun, listRuns, loadRun, newRunId, saveRun } from '../core/runstore'
import { countTokens } from '../core/tokenizer'
import type { CallRow, FrozenRun } from '../core/types'
import { pushRecent, saveKey } from '../state'
import { applyGuesses, catalogKey, currentBaseUrl, currentPartition, currentRows, selectedCatalogModels } from './model'
import { guessRoles } from '../core/guess'
import type { ColumnRole } from '../core/types'
import type { Store } from './store'

export class Actions {
  private controller: RunController | null = null

  constructor(private store: Store, private goTo: (step: number) => void) {}

  // --- provider and catalog -------------------------------------------------------

  setApiKey(key: string): void {
    this.store.update(d => { d.session.apiKey = key.trim() })
    saveKey(key.trim(), this.store.state.keyRemember)
  }

  async loadCatalog(): Promise<void> {
    const { state } = this.store
    const preset = presetById(state.providerId)
    const baseUrl = currentBaseUrl(state)
    if (preset.id === 'custom' && !baseUrl) {
      this.store.update(d => { d.session.catalogNote = 'Enter the base URL first.' })
      return
    }
    this.store.update(d => { d.session.catalogNote = 'Loading…' })
    try {
      const catalog = await fetchCatalog(preset, baseUrl, this.store.session.apiKey)
      let zdrIds = this.store.session.zdrIds
      if (preset.id === 'openrouter' && state.zdrOnly) zdrIds = await fetchZdrModels(baseUrl).catch(() => zdrIds)
      this.store.update(d => {
        d.session.catalog = catalog
        d.session.catalogKey = catalogKey(preset.id, baseUrl)
        d.session.zdrIds = zdrIds
        d.session.catalogNote = `${catalog.length} models loaded${preset.keyRequired && !d.session.apiKey ? ' — add your API key to run' : ''}`
        // Models the user had selected that this catalog does not list stay
        // selected (typed by id) only for custom endpoints; elsewhere they go.
        d.state.selected = d.state.selected.filter(s => catalog.some(m => m.id === s.id) || preset.id === 'custom')
      })
    } catch (error) {
      this.store.update(d => {
        d.session.catalog = []
        d.session.catalogKey = ''
        d.session.catalogNote = `Load failed: ${(error as Error).message}`
      })
    }
  }

  async toggleZdr(enabled: boolean): Promise<void> {
    this.store.update(d => { d.state.zdrOnly = enabled })
    if (enabled && this.store.state.providerId === 'openrouter') {
      try {
        const zdrIds = await fetchZdrModels(presetById('openrouter').baseUrl)
        this.store.update(d => {
          d.session.zdrIds = zdrIds
          d.state.selected = d.state.selected.filter(s => zdrIds.has(s.id))
        })
      } catch (error) {
        this.store.update(d => { d.state.zdrOnly = false; d.session.catalogNote = `Could not load ZDR routes: ${(error as Error).message}` })
      }
    }
  }

  // --- data ------------------------------------------------------------------------

  async loadSheet(file: File): Promise<void> {
    this.store.update(d => { d.session.loadingSheet = true; d.session.sheetError = null })
    try {
      const buffer = await file.arrayBuffer()
      const parsed = await parseInWorker(buffer, file.name)
      this.store.update(d => {
        d.session.sheet = { name: parsed.name, columns: parsed.columns, rows: parsed.rows }
        d.session.sheetSource = { name: file.name, bytes: parsed.bytes, sha256: parsed.sha256 }
        d.session.partitionOverride = null
        d.session.loadingSheet = false
        // A fresh sheet gets fresh guesses; the user changes them by ticking boxes.
        d.state.roles = guessRoles(parsed.rows, parsed.columns)
        d.state.flow = 'sheet'
        d.state.promptAuto = true
        d.state.contractAuto = true
        applyGuesses(d)
      })
    } catch (error) {
      this.store.update(d => { d.session.loadingSheet = false; d.session.sheetError = `Could not read the file: ${(error as Error).message}` })
    }
  }

  setRole(column: string, role: ColumnRole): void {
    this.store.update(d => {
      d.state.roles[column] = role
      d.session.partitionOverride = null
      applyGuesses(d)
    })
  }

  removeRole(column: string): void {
    this.store.update(d => {
      delete d.state.roles[column]
      d.session.partitionOverride = null
      applyGuesses(d)
    })
  }

  // --- running --------------------------------------------------------------------------

  async freeze(): Promise<FrozenRun> {
    const data = { state: this.store.state, session: this.store.session }
    const { rows, roles, label } = currentRows(data)
    const preset = presetById(data.state.providerId)
    const models = selectedCatalogModels(data).map(model => ({
      model,
      settings: data.state.selected.find(s => s.id === model.id)?.settings ?? { extras: {} },
    }))
    return freezeRun({
      preset,
      baseUrl: currentBaseUrl(data.state),
      source: data.state.flow === 'sheet' && data.session.sheetSource
        ? { ...data.session.sheetSource, rowCount: rows.length, sheet: data.session.sheet?.name }
        : null,
      rows,
      roles,
      partition: currentPartition(data),
      systemTemplate: data.state.system,
      itemTemplate: data.state.prompt,
      contract: data.state.contract,
      parserId: data.state.parserId,
      models,
      shared: data.state.shared,
      repeats: data.state.repeats,
      concurrency: data.state.concurrency,
      retries: data.state.retries,
      timeoutMs: data.state.timeoutMs,
      label,
      countTokens,
    })
  }

  async run(): Promise<void> {
    if (this.store.session.running) return
    const frozen = await this.freeze()
    const runId = newRunId()
    const { rows: sourceRows, columns: sourceColumns } = currentRows({ state: this.store.state, session: this.store.session })
    const isSheet = this.store.state.flow === 'sheet'
    this.store.update(d => {
      d.session.runId = runId
      d.session.frozen = frozen
      d.session.rows = pendingRows(frozen)
      d.session.sourceRows = isSheet ? sourceRows : null
      d.session.sourceColumns = isSheet ? sourceColumns : null
    })
    await saveRun({ id: runId, createdAt: frozen.frozenAt, label: runLabel(frozen), frozen, sourceRows: isSheet ? sourceRows : undefined, sourceColumns: isSheet ? sourceColumns : undefined })
    this.goTo(6)
    await this.execute(frozen, runId)
  }

  private async execute(frozen: FrozenRun, runId: string, indices?: number[]): Promise<void> {
    const total = frozen.cases.length * frozen.models.length * frozen.repeats
    let done = this.store.session.rows.filter(r => r.status !== 'pending').length
    this.controller = new RunController(frozen, this.store.session.apiKey, {
      onStart: index => {
        this.store.update(d => { const row = d.session.rows[index]; if (row) d.session.rows[index] = { ...row, status: 'running', error: undefined } })
      },
      onRow: (index, row) => {
        done++
        this.store.update(d => { d.session.rows[index] = row; d.session.statusLine = `Running ${done}/${total}` })
        void appendRow(runId, index, row)
      },
      onRetry: (index, event) => {
        this.store.update(d => {
          const row = d.session.rows[index]
          if (row) d.session.rows[index] = { ...row, status: 'running', error: `retrying ${event.attempt}/${event.maxRetries}${event.error ? `: ${event.error}` : ''}` }
        })
      },
    })
    // Resume keeps the rows already completed.
    this.controller.seed(this.store.session.rows)
    this.store.update(d => { d.session.running = true; d.session.paused = false; d.session.statusLine = `Running ${done}/${total}`; d.session.runStartedAt = Date.now(); d.session.runDoneAtStart = done })
    const outcome = await this.controller.start(indices)
    this.controller = null
    const ok = outcome.rows.filter(r => r.status === 'ok').length
    const failed = outcome.rows.filter(r => r.status === 'error').length
    const cost = outcome.rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
    this.store.update(d => {
      d.session.running = false
      d.session.paused = false
      d.session.rows = [...outcome.rows]
      d.session.statusLine = `${outcome.aborted ? 'Stopped' : 'Done'}: ${ok} ok · ${failed} failed${cost > 0 ? ` · $${cost.toFixed(4)} actual` : ''} · ${(outcome.elapsedMs / 1000).toFixed(1)}s`
    })
    for (const model of frozen.models) pushRecent({ providerId: model.provider, model: model.id })
  }

  pause(): void {
    this.controller?.pause()
    this.store.update(d => { d.session.paused = true; d.session.statusLine = 'Paused: in-flight calls finish, no new ones start' })
  }

  resume(): void {
    this.controller?.resume()
    this.store.update(d => { d.session.paused = false })
  }

  cancel(): void {
    this.controller?.abort()
  }

  /** Run the coordinates of the current run that are not ok, under the same run id. */
  async rerunMissing(): Promise<void> {
    const { frozen, runId, rows, running } = this.store.session
    if (!frozen || !runId || running) return
    const indices = rows.map((row, index) => (row.status === 'ok' ? -1 : index)).filter(i => i >= 0)
    if (indices.length === 0) return
    this.store.update(d => { for (const i of indices) d.session.rows[i] = { ...d.session.rows[i]!, status: 'pending', error: undefined } })
    await this.execute(frozen, runId, indices)
  }

  // --- stored runs -----------------------------------------------------------------

  listRuns = listRuns

  async openRun(id: string): Promise<void> {
    const stored = await loadRun(id)
    if (!stored) return
    const frozen = stored.run.frozen
    const rows = pendingRows(frozen)
    for (const [index, row] of stored.rows) if (index < rows.length) rows[index] = row
    const done = rows.filter(r => r.status !== 'pending').length
    this.store.update(d => {
      d.session.runId = id
      d.session.frozen = frozen
      d.session.rows = rows
      d.session.sourceRows = stored.run.sourceRows ?? null
      d.session.sourceColumns = stored.run.sourceColumns ?? null
      d.session.statusLine = `Opened saved run: ${done}/${rows.length} calls completed`
    })
    this.goTo(6)
  }

  async deleteStoredRun(id: string): Promise<void> {
    await deleteRun(id)
    if (this.store.session.runId === id) this.store.update(d => { d.session.runId = null })
    else this.store.update(() => {})
  }

  // --- exports -------------------------------------------------------------------------

  exportLong(kind: 'csv' | 'jsonl' | 'xlsx'): void {
    const { frozen, rows } = this.store.session
    if (!frozen) return
    const built = buildRows(frozen, rows)
    const stem = `multiaiball-${fileStamp(frozen.frozenAt)}`
    if (kind === 'csv') download(`${stem}.csv`, toCSV(built.rows, built.columns), 'text/csv;charset=utf-8')
    else if (kind === 'jsonl') download(`${stem}.jsonl`, toJSONL(built.rows, built.columns), 'application/x-ndjson')
    else download(`${stem}.xlsx`, toXLSX([{ name: 'Results', rows: built.rows, columns: built.columns }]), XLSX_MIME)
  }

  exportCompleted(): void {
    const { frozen, rows, sourceRows, sourceColumns } = this.store.session
    if (!frozen || !sourceRows || !sourceColumns) return
    const datasets = buildCompletedDatasets(frozen, rows, sourceRows, sourceColumns)
    download(`multiaiball-completed-${fileStamp(frozen.frozenAt)}.xlsx`, toXLSX(datasets.map(ds => ({ name: ds.name, rows: ds.rows, columns: plainColumns(ds.columns) }))), XLSX_MIME)
  }

  async exportBundle(): Promise<void> {
    const { frozen } = this.store.session
    if (!frozen) return
    const blob = await buildBundleZip(frozen, runLabel(frozen))
    download(`multiaiball-${fileStamp(frozen.frozenAt)}-python.zip`, blob, ZIP_MIME)
  }

  async saveRunFile(): Promise<void> {
    const { frozen, rows, sourceRows, sourceColumns } = this.store.session
    if (!frozen) return
    const zip = new JSZip()
    zip.file('run.json', JSON.stringify({ format: 'multiaiball-run', version: 1, frozen, rows, sourceRows, sourceColumns }))
    download(`multiaiball-run-${fileStamp(frozen.frozenAt)}.zip`, await zip.generateAsync({ type: 'blob' }), ZIP_MIME)
  }

  async openRunFile(file: File): Promise<void> {
    try {
      const zip = await JSZip.loadAsync(await file.arrayBuffer())
      const raw = await zip.file('run.json')?.async('string')
      if (!raw) throw new Error('run.json missing from the archive')
      const saved = JSON.parse(raw) as { frozen: FrozenRun; rows: CallRow[]; sourceRows?: Record<string, unknown>[] | null; sourceColumns?: string[] | null }
      if (!saved.frozen?.models) throw new Error('not a MultAIBall run file')
      const id = newRunId()
      this.store.update(d => {
        d.session.runId = id
        d.session.frozen = saved.frozen
        d.session.rows = saved.rows
        d.session.sourceRows = saved.sourceRows ?? null
        d.session.sourceColumns = saved.sourceColumns ?? null
        d.session.statusLine = `Opened ${file.name}`
      })
      await saveRun({ id, createdAt: saved.frozen.frozenAt, label: runLabel(saved.frozen), frozen: saved.frozen, sourceRows: saved.sourceRows ?? undefined, sourceColumns: saved.sourceColumns ?? undefined })
      for (const [index, row] of saved.rows.entries()) if (row.status !== 'pending') void appendRow(id, index, row)
      this.goTo(6)
    } catch (error) {
      this.store.update(d => { d.session.statusLine = `Could not open: ${(error as Error).message}` })
    }
  }
}

export function runLabel(frozen: FrozenRun): string {
  const what = frozen.source ? frozen.source.name : frozen.cases.length > 1 ? `${frozen.cases.length} cases` : 'one prompt'
  return `${what} × ${frozen.models.map(m => m.id).join(', ')}`
}

/** Parse in the worker when the browser has one; inline otherwise (tests). */
function parseInWorker(buffer: ArrayBuffer, name: string): Promise<SheetWorkerResponse> {
  if (typeof Worker === 'undefined') {
    return sha256Hex(new TextDecoder('latin1').decode(buffer)).then(sha256 => {
      const sheet = parseSheetBytes(buffer, name)
      return { ok: true as const, name: sheet.name, columns: sheet.columns, rows: sheet.rows, sha256, bytes: buffer.byteLength }
    })
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../core/sheet.worker.ts', import.meta.url), { type: 'module' })
    worker.addEventListener('message', (event: MessageEvent<SheetWorkerResponse | SheetWorkerFailure>) => {
      worker.terminate()
      if (event.data.ok) resolve(event.data)
      else reject(new Error(event.data.error))
    })
    worker.addEventListener('error', event => { worker.terminate(); reject(new Error(event.message || 'worker failed')) })
    worker.postMessage({ buffer, name }, [buffer])
  })
}
