// The one store. Persisted settings (state.ts) and session-only data live
// side by side; every mutation goes through `update`, which notifies every
// subscriber, so a screen cannot forget to re-render and the app cannot forget
// to save. Inputs own their text: screens render structure once and refresh
// derived regions on notify; they write input values back only on restore.

import type { SheetData } from '../core/cases'
import type { CallRow, CatalogModel, FrozenRun, Partition } from '../core/types'
import { loadKey, loadState, saveState } from '../state'
import type { PersistedState } from '../state'

export interface Session {
  apiKey: string
  /** Loaded models for `catalogKey` (provider|base URL). */
  catalog: CatalogModel[]
  catalogKey: string
  catalogNote: string
  zdrIds: Set<string>
  sheet: SheetData | null
  sheetSource: { name: string; bytes: number; sha256: string } | null
  sheetError: string | null
  loadingSheet: boolean
  /** An authored draft was recovered when this browser session opened. */
  restoredDraft: boolean
  /** True only when the sheet was brought back from a prior browser visit. */
  restoredSheet: boolean
  /** User edits to the inferred partition; null = inferred from the sheet. */
  partitionOverride: Partition | null
  /** The run in progress or last completed. */
  runId: string | null
  frozen: FrozenRun | null
  rows: CallRow[]
  running: boolean
  paused: boolean
  statusLine: string
  /** When the current execution started and how many rows were already done then. */
  runStartedAt: number | null
  runDoneAtStart: number
  /** Rows of the source the current `frozen` came from, for completed datasets. */
  sourceRows: Record<string, unknown>[] | null
  sourceColumns: string[] | null
}

export interface AppData {
  state: PersistedState
  session: Session
}

export function defaultSession(state: PersistedState): Session {
  return {
    apiKey: loadKey(state.keyRemember),
    catalog: [],
    catalogKey: '',
    catalogNote: '',
    zdrIds: new Set(),
    sheet: null,
    sheetSource: null,
    sheetError: null,
    loadingSheet: false,
    restoredDraft: Boolean(state.prompt.trim() || state.system.trim() || state.sweep.length || Object.keys(state.roles).length || state.contract.fields?.length || state.selected.length),
    restoredSheet: false,
    partitionOverride: null,
    runId: null,
    frozen: null,
    rows: [],
    running: false,
    paused: false,
    statusLine: '',
    runStartedAt: null,
    runDoneAtStart: 0,
    sourceRows: null,
    sourceColumns: null,
  }
}

export type Listener = (data: AppData) => void

export class Store {
  private data: AppData
  private listeners = new Set<Listener>()
  private scheduled = false

  constructor(state = loadState()) {
    this.data = { state, session: defaultSession(state) }
  }

  get state(): PersistedState { return this.data.state }
  get session(): Session { return this.data.session }

  /** Mutate in place, then notify (coalesced to one notification per tick). */
  update(fn: (data: AppData) => void): void {
    fn(this.data)
    saveState(this.data.state)
    this.notify()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      for (const listener of this.listeners) listener(this.data)
    })
  }

  /** Immediate notify for callers that need the DOM updated now (tests, run start). */
  flush(): void {
    this.scheduled = false
    for (const listener of this.listeners) listener(this.data)
  }
}
