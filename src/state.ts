// Persistence boundary: settings + saved templates only. Every persisted
// object is a tolerant envelope — readers ignore unknown fields and default
// missing ones, so adding a field is never a migration. Sheets and results are
// never persisted (export is the save).

import type { CaseSource, ContractAuthoring, ContractPlacement, ParamOverrides } from './core/types'

export const STATE_KEY = 'multiaiball:state:v2'
export const KEY_SESSION_KEY = 'multiaiball:key:session:v2'
export const KEY_LOCAL_KEY = 'multiaiball:key:remembered:v2'
export const RECENT_KEY = 'multiaiball:recent:v2'
export const TEMPLATES_KEY = 'multiaiball:templates:v2'

export interface PersistedState {
  version: number
  presetId: string
  customBase: string
  prompt: string
  system: string
  source: CaseSource
  selected: string[]
  params: ParamOverrides
  stream: boolean
  /** Runs with more calls than this never stream (progress counters instead). */
  streamThreshold: number
  zdr: boolean
  retries: number
  concurrency: number
  budget: number
  /** OpenRouter's `:free` routes trade money for provider data use. Hidden by default. */
  hideFreeModels: boolean
  contract: ContractAuthoring
  placement: ContractPlacement
  parserId: string | null
  repeats: number
  dark: boolean
  keyRemember: boolean
}

export function defaultState(): PersistedState {
  return {
    version: 1,
    presetId: 'openrouter',
    customBase: '',
    prompt: '',
    system: '',
    source: { kind: 'single' },
    selected: [],
    params: { temperature: 0.7, maxTokens: 1024, topP: undefined },
    stream: true,
    streamThreshold: 100,
    zdr: false,
    retries: 2,
    concurrency: 6,
    budget: 0.005,
    hideFreeModels: true,
    contract: { fields: [], rationaleFirst: false, rationaleSpec: '', strictJson: true },
    placement: 'system-after',
    parserId: null,
    repeats: 1,
    dark: false,
    keyRemember: false,
  }
}

export function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STATE_KEY)
    if (!raw) return defaultState()
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    const migrated: PersistedState = { ...defaultState(), ...parsed }
    // Tolerant envelope: a persisted source may be a legacy string tag.
    if (typeof (parsed as { source?: unknown }).source === 'string') {
      migrated.source = { kind: 'single' }
    }
    return migrated
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

// --- recent models (quick add) -----------------------------------------------

export interface RecentItem {
  presetId: string
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
    const rest = loadRecent().filter(r => !(r.presetId === item.presetId && r.model === item.model))
    localStorage.setItem(RECENT_KEY, JSON.stringify([item, ...rest].slice(0, limit)))
  } catch {
    // quick-add recents just do not persist
  }
}

// --- saved templates (prompt + optional contract/parser; sheets never) -------

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
