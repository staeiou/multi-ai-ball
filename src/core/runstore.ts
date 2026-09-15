// Paid-for results survive a reload. One IndexedDB database, two stores, no
// indexes beyond the key paths, no versions to migrate: the frozen run is
// written once at freeze, one small row is appended per completed call.
// Execution does not resume; a user reopens the tab, sees the run and its
// completed rows, and exports or reruns the missing coordinates as a new run.
// Any failure here is swallowed: durability is a convenience layered on a
// memory-only app, never a dependency of the run.

import type { CallRow, FrozenRun } from './types'

const DB_NAME = 'multiaiball'
const DB_VERSION = 1
const RUNS = 'runs'
const ROWS = 'rows'

export interface StoredRun {
  id: string
  createdAt: string
  label: string
  frozen: FrozenRun
  /** The source rows, when a sheet was loaded, so completed datasets can be
   * exported after a reload. Bounded by the 50 MB ceiling. */
  sourceRows?: Record<string, unknown>[]
  sourceColumns?: string[]
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise(resolve => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return }
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(RUNS)) db.createObjectStore(RUNS, { keyPath: 'id' })
        if (!db.objectStoreNames.contains(ROWS)) db.createObjectStore(ROWS, { keyPath: ['runId', 'index'] })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function saveRun(run: StoredRun): Promise<void> {
  const db = await open()
  if (!db) return
  try {
    await req(db.transaction(RUNS, 'readwrite').objectStore(RUNS).put(run))
  } catch { /* durability is best effort */ }
}

export async function appendRow(runId: string, index: number, row: CallRow): Promise<void> {
  const db = await open()
  if (!db) return
  try {
    await req(db.transaction(ROWS, 'readwrite').objectStore(ROWS).put({ runId, index, row }))
  } catch { /* best effort */ }
}

export async function listRuns(): Promise<Array<Pick<StoredRun, 'id' | 'createdAt' | 'label'> & { calls: number }>> {
  const db = await open()
  if (!db) return []
  try {
    const runs = await req(db.transaction(RUNS).objectStore(RUNS).getAll()) as StoredRun[]
    return runs
      .filter(r => r && r.frozen && Array.isArray(r.frozen.models))
      .map(r => ({ id: r.id, createdAt: r.createdAt, label: r.label, calls: r.frozen.cases.length * r.frozen.models.length * r.frozen.repeats }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  } catch {
    return []
  }
}

export async function loadRun(id: string): Promise<{ run: StoredRun; rows: Map<number, CallRow> } | null> {
  const db = await open()
  if (!db) return null
  try {
    const run = await req(db.transaction(RUNS).objectStore(RUNS).get(id)) as StoredRun | undefined
    if (!run) return null
    const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])
    const stored = await req(db.transaction(ROWS).objectStore(ROWS).getAll(range)) as Array<{ index: number; row: CallRow }>
    return { run, rows: new Map(stored.map(s => [s.index, s.row])) }
  } catch {
    return null
  }
}

export async function deleteRun(id: string): Promise<void> {
  const db = await open()
  if (!db) return
  try {
    await req(db.transaction(RUNS, 'readwrite').objectStore(RUNS).delete(id))
    const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])
    await req(db.transaction(ROWS, 'readwrite').objectStore(ROWS).delete(range))
  } catch { /* best effort */ }
}

export function newRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
