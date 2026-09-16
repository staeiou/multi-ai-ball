// Persistence boundary: settings and saved templates only. Every persisted
// object is a tolerant envelope: readers ignore unknown fields and default
// missing ones, so adding a field is never a migration. Sheets and results are
// never persisted here (results go to runstore.ts, per call, as they finish).

import type { ColumnRole, ContractAuthoring, ModelSettings, ProviderId, SharedParams } from './core/types'

export const STATE_KEY = 'multiaiball:state:v3'
export const KEY_SESSION_KEY = 'multiaiball:key:session:v3'
export const KEY_LOCAL_KEY = 'multiaiball:key:remembered:v3'
export const RECENT_KEY = 'multiaiball:recent:v3'
export const TEMPLATES_KEY = 'multiaiball:templates:v3'

export type Flow = 'single' | 'sweep' | 'sheet'

export interface SelectedModel {
  id: string
  settings: ModelSettings
}

export interface PersistedState {
  version: number
  providerId: ProviderId
  customBase: string
  flow: Flow
  /** The item template (user channel). */
  prompt: string
  /** The system template. */
  system: string
  /** Sweep variables: name -> one value per line. */
  sweep: Array<{ name: string; values: string }>
  /** Sheet column roles by column name; the sheet itself is never persisted.
   * May name output columns that do not exist in the sheet (new columns). */
  roles: Record<string, ColumnRole>
  /** The item template was generated from the input columns and follows them. */
  promptAuto: boolean
  /** The answer fields were generated from the output columns and follow them. */
  contractAuto: boolean
  selected: SelectedModel[]
  shared: SharedParams
  repeats: number
  concurrency: number
  retries: number
  timeoutMs: number
  hideFreeModels: boolean
  zdrOnly: boolean
  splitRatio: number
  contract: ContractAuthoring
  parserId: string | null
  dark: boolean
  keyRemember: boolean
  /** The run shown on the results screen, reopened after a refresh. */
  lastRunId: string | null
}

export function defaultShared(): SharedParams {
  return { outputLength: 2048, temperature: null, effort: null, responseFormat: 'auto' }
}

export function defaultState(): PersistedState {
  return {
    version: 3,
    providerId: 'openrouter',
    customBase: '',
    flow: 'single',
    prompt: '',
    system: '',
    sweep: [],
    roles: {},
    promptAuto: true,
    contractAuto: true,
    selected: [],
    shared: defaultShared(),
    repeats: 1,
    concurrency: 6,
    retries: 2,
    timeoutMs: 120000,
    hideFreeModels: true,
    zdrOnly: false,
    splitRatio: 0.5,
    // A new one-question draft is plain text. Sheet guesses turn on JSON and
    // the column parser only after the user has chosen output columns.
    contract: { fields: [], rationaleFirst: false, rationaleSpec: '', strictJson: false },
    parserId: null,
    dark: false,
    keyRemember: false,
    lastRunId: null,
  }
}

export function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STATE_KEY)
    if (!raw) return defaultState()
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    const merged: PersistedState = { ...defaultState(), ...parsed, shared: { ...defaultShared(), ...(parsed.shared ?? {}) } }
    if (!Array.isArray(merged.selected)) merged.selected = []
    merged.selected = merged.selected
      .filter(s => s && typeof s === 'object' && typeof (s as SelectedModel).id === 'string')
      .map(s => ({ id: s.id, settings: { ...(s.settings ?? {}), extras: s.settings?.extras ?? {} } }))
    return merged
  } catch {
    return defaultState()
  }
}

export function saveState(state: PersistedState): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state))
  } catch {
    // storage unavailable: composition loss on refresh is the cost
  }
}

export function loadKey(remember: boolean): string {
  try {
    if (remember) return localStorage.getItem(KEY_LOCAL_KEY) ?? sessionStorage.getItem(KEY_SESSION_KEY) ?? ''
    return sessionStorage.getItem(KEY_SESSION_KEY) ?? ''
  } catch {
    return ''
  }
}

export function saveKey(key: string, remember: boolean): void {
  try {
    if (remember && key) {
      localStorage.setItem(KEY_LOCAL_KEY, key)
      sessionStorage.setItem(KEY_SESSION_KEY, key)
    } else if (key) {
      sessionStorage.setItem(KEY_SESSION_KEY, key)
      localStorage.removeItem(KEY_LOCAL_KEY)
    } else {
      sessionStorage.removeItem(KEY_SESSION_KEY)
      localStorage.removeItem(KEY_LOCAL_KEY)
    }
  } catch {
    // key falls back to in-memory only this session
  }
}

// --- recent models -----------------------------------------------------------------

export interface RecentItem {
  providerId: string
  model: string
}

export function loadRecent(): RecentItem[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed as RecentItem[] : []
  } catch {
    return []
  }
}

export function pushRecent(item: RecentItem, limit = 8): void {
  try {
    const rest = loadRecent().filter(r => !(r.providerId === item.providerId && r.model === item.model))
    localStorage.setItem(RECENT_KEY, JSON.stringify([item, ...rest].slice(0, limit)))
  } catch {
    // recents just do not persist
  }
}

// --- saved templates -----------------------------------------------------------------

export interface SavedTemplate {
  id: string
  name: string
  template: string
  system: string
  contract: ContractAuthoring
  parserId: string | null
  updated: string
}

export function loadTemplates(): SavedTemplate[] {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed as SavedTemplate[] : []
  } catch {
    return []
  }
}

export function saveTemplates(templates: SavedTemplate[]): void {
  try {
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templates))
  } catch {
    // templates do not persist when storage is unavailable
  }
}
