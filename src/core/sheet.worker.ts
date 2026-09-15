// Parses an uploaded file off the main thread. A 50 MB sheet takes SheetJS
// about two seconds and several hundred MB of transient heap (measured
// 2026-09-13, tmp/verify/sheet-mem.mjs); doing that here keeps the page
// responsive and lets the main thread hold only the parsed rows.

import { parseSheetBytes } from './cases'

export interface SheetWorkerRequest {
  buffer: ArrayBuffer
  name: string
}

export interface SheetWorkerResponse {
  ok: true
  name: string
  columns: string[]
  rows: Record<string, unknown>[]
  sha256: string
  bytes: number
}

export interface SheetWorkerFailure {
  ok: false
  error: string
}

self.addEventListener('message', async (event: MessageEvent<SheetWorkerRequest>) => {
  const { buffer, name } = event.data
  try {
    const digest = await crypto.subtle.digest('SHA-256', buffer)
    const sha256 = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
    const sheet = parseSheetBytes(buffer, name)
    const response: SheetWorkerResponse = { ok: true, name: sheet.name, columns: sheet.columns, rows: sheet.rows, sha256, bytes: buffer.byteLength }
    self.postMessage(response)
  } catch (error) {
    const failure: SheetWorkerFailure = { ok: false, error: (error as Error).message }
    self.postMessage(failure)
  }
})
