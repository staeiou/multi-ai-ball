// Screen 6: results. One row per call, filters, sortable columns, a live
// breakdown of any answer column (core/breakdown.ts) over the rows shown, a
// detail dialog per row (parsed fields, response, reasoning, the exact
// request, raw payload, error), exports, and the saved runs.

import { breakdown, inferKind } from '../../core/breakdown'
import type { FieldKind } from '../../core/breakdown'
import { formatNumber } from '../../core/breakdown'
import { renderMarkdown } from '../markdown'
import { formatUsd } from '../../core/pricing'
import { renderCall } from '../../core/render'
import { responseText } from '../../core/run'
import type { CallRow, FrozenRun } from '../../core/types'
import type { Actions } from '../actions'
import { h } from '../dom'
import type { AppData, Store } from '../store'
import type { Screen } from './screen'

/** Above this many visible rows the table windows itself: only the rows in
 * view (plus a margin) exist in the DOM, on a fixed row height. */
const VIRTUAL_ABOVE = 1000
const ROW_HEIGHT = 40
const OVERSCAN = 20

/** Sorting by status groups finished calls first, like the live order. */
const STATUS_RANK: Record<CallRow['status'], number> = { ok: 0, error: 1, running: 2, pending: 3 }

type SortDir = 'asc' | 'desc'

export function buildResultsScreen(store: Store, actions: Actions): Screen {
  const status = h('span', { class: 'muted small status-line' })
  const tally = h('div', { class: 'run-tally' })
  const progress = h('div', { class: 'progress' }, h('div', { class: 'progress-ok' }), h('div', { class: 'progress-err' }), h('div', { class: 'progress-running' }))
  const pause = h('button', { class: 'btn', type: 'button' }, 'Pause')
  const resume = h('button', { class: 'btn', type: 'button' }, 'Resume')
  const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel')
  const rerun = h('button', { class: 'btn', type: 'button', title: 'Run again only the calls that did not succeed' }, 'Run the missing calls')
  const exportXlsx = h('button', { class: 'btn', type: 'button' }, 'Results (XLSX)')
  const exportCsv = h('button', { class: 'btn', type: 'button' }, 'CSV')
  const exportJsonl = h('button', { class: 'btn', type: 'button' }, 'JSONL')
  const exportCompleted = h('button', { class: 'btn', type: 'button', title: 'Your spreadsheet with the model\'s answers filled in, one sheet per model' }, 'Completed spreadsheet')
  const exportPy = h('button', { class: 'btn', type: 'button' }, 'Python bundle')
  const saveRun = h('button', { class: 'btn ghost', type: 'button' }, 'Save run file')
  const openRunInput = h('input', { type: 'file', accept: '.zip' })
  openRunInput.hidden = true
  const openRun = h('button', { class: 'btn ghost', type: 'button' }, 'Open run file…')
  const search = h('input', { class: 'input result-search', type: 'search', placeholder: 'Filter by case, model, or text…' })
  const statusFilter = h('select', { class: 'input result-status' }, h('option', { value: 'all' }, 'All'), h('option', { value: 'ok' }, 'Succeeded'), h('option', { value: 'error' }, 'Failed'), h('option', { value: 'running' }, 'In flight'), h('option', { value: 'pending' }, 'Waiting'), h('option', { value: 'parse-failed' }, 'Could not parse'))
  const modelFilter = h('select', { class: 'input result-model' })
  const breakdownBox = h('div', { class: 'breakdown-box' })
  breakdownBox.hidden = true
  const tableWrap = h('div', { class: 'final-table-wrap' })
  const saved = h('div', { class: 'saved-runs' })

  const el = h('section', { class: 'card stage-card results-stage' },
    h('div', { class: 'stage-heading' }, h('h2', {}, 'Results')),
    tally,
    progress,
    h('div', { class: 'results-toolbar' }, status, pause, resume, cancel, rerun),
    h('div', { class: 'results-toolbar' }, exportXlsx, exportCsv, exportJsonl, exportCompleted, exportPy, saveRun, openRun, openRunInput),
    h('div', { class: 'result-filters' }, search, statusFilter, modelFilter),
    breakdownBox,
    tableWrap,
    h('details', { class: 'schema-preview saved-runs-box' }, h('summary', {}, 'Saved runs on this device'), saved),
  )

  setInterval(() => { if (store.session.running) renderTally(current()) }, 1000)
  pause.addEventListener('click', () => actions.pause())
  resume.addEventListener('click', () => actions.resume())
  cancel.addEventListener('click', () => actions.cancel())
  rerun.addEventListener('click', () => void actions.rerunMissing())
  exportXlsx.addEventListener('click', () => actions.exportLong('xlsx'))
  exportCsv.addEventListener('click', () => actions.exportLong('csv'))
  exportJsonl.addEventListener('click', () => actions.exportLong('jsonl'))
  exportCompleted.addEventListener('click', () => actions.exportCompleted())
  exportPy.addEventListener('click', () => void actions.exportBundle())
  saveRun.addEventListener('click', () => void actions.saveRunFile())
  openRun.addEventListener('click', () => openRunInput.click())
  openRunInput.addEventListener('change', () => { const f = openRunInput.files?.[0]; if (f) void actions.openRunFile(f); openRunInput.value = '' })
  search.addEventListener('input', () => renderTable(current()))
  statusFilter.addEventListener('change', () => renderTable(current()))
  modelFilter.addEventListener('change', () => renderTable(current()))
  tableWrap.addEventListener('scroll', () => {
    if (virtual) scheduleWindow()
    if (!programmedScroll && store.session.running) followLive = Math.abs(tableWrap.scrollTop - liveBoundary) < ROW_HEIGHT * 3
  })
  el.querySelector('.saved-runs-box')!.addEventListener('toggle', ev => { if ((ev.target as HTMLDetailsElement).open) void renderSaved() })

  function current(): AppData { return { state: store.state, session: store.session } }

  function parsedColumns(frozen: FrozenRun, rows: CallRow[]): string[] {
    if (frozen.parserId !== 'json-unstack') return frozen.parserId ? ['parsed'] : []
    if (frozen.contract) return frozen.contract.fields.map(f => f.name)
    const keys = new Set<string>()
    for (const row of rows) if (row.parsed && typeof row.parsed === 'object') for (const k of Object.keys(row.parsed as object)) keys.add(k)
    return [...keys].sort().slice(0, 12)
  }

  /** The parsed value behind one answer column, or null when there is none. */
  function parsedValue(row: CallRow, key: string): unknown {
    if (row.parsed === null || row.parsed === 'PARSER_ERROR') return null
    if (key === 'parsed') return row.parsed
    if (typeof row.parsed !== 'object') return null
    const v = (row.parsed as Record<string, unknown>)[key]
    return v === undefined ? null : v
  }

  function cell(row: CallRow, key: string): string {
    const v = parsedValue(row, key)
    return v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  }

  function statusLabel(row: CallRow): string {
    return row.status === 'running' ? 'running' : row.status === 'pending' ? 'waiting' : row.status === 'ok' && row.parseStatus === 'failed' ? 'ok, unparsed' : row.status
  }

  // --- sorting: a column key and a direction; null is the default order ---------

  let sort: { key: string; dir: SortDir } | null = null
  let breakdownKey: string | null = null

  function sortValue(frozen: FrozenRun, row: CallRow, key: string): number | string | null {
    if (key === 'case') return row.coord.caseIndex
    if (key === 'model') return frozen.models[row.coord.modelIndex]!.id
    if (key === 'repeat') return row.coord.repeat
    if (key === 'status') return STATUS_RANK[row.status] + (row.parseStatus === 'failed' ? 0.5 : 0)
    if (key === 'response') return row.status === 'error' ? (row.error ?? '') : responseText(row)
    if (key === 'cost') return row.costUsd ?? row.estimatedCostUsd ?? null
    if (key.startsWith('parsed:')) {
      const v = parsedValue(row, key.slice('parsed:'.length))
      if (v === null || v === '') return null
      if (typeof v === 'number') return v
      if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v)
      return typeof v === 'object' ? JSON.stringify(v) : String(v)
    }
    return null
  }

  /** Empty cells last whichever way; numbers numerically; else as text. */
  function compare(frozen: FrozenRun, key: string, dir: SortDir): (a: Visible, b: Visible) => number {
    const sign = dir === 'asc' ? 1 : -1
    return (a, b) => {
      const va = sortValue(frozen, a.row, key)
      const vb = sortValue(frozen, b.row, key)
      if (va === null && vb === null) return a.index - b.index
      if (va === null) return 1
      if (vb === null) return -1
      const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))
      return c * sign || a.index - b.index
    }
  }

  /** A header cell: the label sorts (asc, desc, off); answer columns and the
   * status column also get a button that opens the breakdown. */
  function th(key: string, text: string, opts: { center?: boolean; breakdown?: boolean } = {}): HTMLElement {
    const active = sort?.key === key
    const sortBtn = h('button', { class: `th-sort${active ? ' active' : ''}`, type: 'button', title: 'Sort by this column (again to flip, a third time to clear)' }, text, active ? (sort!.dir === 'asc' ? ' ▲' : ' ▼') : '')
    sortBtn.addEventListener('click', () => { sort = !active ? { key, dir: 'asc' } : sort!.dir === 'asc' ? { key, dir: 'desc' } : null; renderTable(current()) })
    const cellEl = h('th', { class: opts.center ? 'center' : '' }, sortBtn)
    if (opts.breakdown) {
      const btn = h('button', { class: `th-breakdown${breakdownKey === key ? ' active' : ''}`, type: 'button', title: 'How the answers in this column are distributed, over the rows shown' }, '▤')
      btn.addEventListener('click', () => { breakdownKey = breakdownKey === key ? null : key; renderTable(current()) })
      cellEl.append(btn)
    }
    return cellEl
  }

  interface Visible { row: CallRow; index: number }
  let virtual = false
  let visibleRows: Visible[] = []
  let visibleFrozen: FrozenRun | null = null
  let visibleColumns: string[] = []
  let tbody: HTMLTableSectionElement | null = null
  let windowStart = -1
  let windowScheduled = false
  let followLive = true
  let programmedScroll = false
  let liveBoundary = 0

  function renderTable(data: AppData): void {
    const { frozen, rows } = data.session
    const scrollTop = tableWrap.scrollTop
    tableWrap.replaceChildren()
    tbody = null
    if (!frozen) { tableWrap.append(h('p', { class: 'muted' }, 'Run something to see results here, or open a saved run below.')); return }
    const q = search.value.trim().toLowerCase()
    const sf = statusFilter.value
    const mf = modelFilter.value
    visibleFrozen = frozen
    visibleRows = rows.map((row, index) => ({ row, index })).filter(({ row }) => {
      const model = frozen.models[row.coord.modelIndex]!
      if (mf && model.id !== mf) return false
      if (sf === 'parse-failed' ? row.parseStatus !== 'failed' : sf !== 'all' && row.status !== sf) return false
      if (!q) return true
      const c = frozen.cases[row.coord.caseIndex]!
      return `${c.label} ${model.id} ${responseText(row)} ${row.error ?? ''} ${JSON.stringify(row.parsed ?? '')}`.toLowerCase().includes(q)
    })
    // A chosen sort replaces the live order (finished first) until cleared.
    const liveOrder = !sort && data.session.running && !q && sf === 'all' && !mf
    if (sort) visibleRows.sort(compare(frozen, sort.key, sort.dir))
    else if (liveOrder) {
      const rank = (row: CallRow): number => row.status === 'ok' || row.status === 'error' ? 0 : row.status === 'running' ? 1 : 2
      visibleRows.sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
    }
    visibleColumns = parsedColumns(frozen, rows)
    renderBreakdown(frozen, rows.length)
    virtual = visibleRows.length > VIRTUAL_ABOVE
    const multi = frozen.models.length > 1
    const table = h('table', { class: `grid-table final-table ${virtual ? 'virtual' : ''}` })
    table.append(h('thead', {}, h('tr', {}, th('case', 'Case'), multi ? th('model', 'Model') : null, frozen.repeats > 1 ? th('repeat', 'Rep', { center: true }) : null, th('status', 'Status', { center: true, breakdown: true }),
      ...visibleColumns.map(c => th(`parsed:${c}`, c, { breakdown: true })), th('response', 'Response'), th('cost', 'Cost', { center: true }))))
    tbody = h('tbody')
    table.append(tbody)
    tableWrap.append(table)
    if (visibleRows.length !== rows.length) tableWrap.append(h('p', { class: 'muted small table-facts' }, `${visibleRows.length.toLocaleString()} of ${rows.length.toLocaleString()} calls match`))
    windowStart = -1
    if (virtual) { tableWrap.scrollTop = scrollTop; renderWindow() }
    else for (const v of visibleRows) tbody.append(rowElement(frozen, v))
    if (liveOrder && followLive) {
      const complete = visibleRows.filter(v => v.row.status === 'ok' || v.row.status === 'error').length
      requestAnimationFrame(() => {
        liveBoundary = Math.max(0, complete * ROW_HEIGHT - ROW_HEIGHT * 3)
        programmedScroll = true
        tableWrap.scrollTop = liveBoundary
        programmedScroll = false
      })
    }
  }

  function scheduleWindow(): void {
    if (windowScheduled) return
    windowScheduled = true
    requestAnimationFrame(() => { windowScheduled = false; renderWindow() })
  }

  /** Windowed body: a spacer row above, the rows in view plus a margin, a
   * spacer row below. The spacers give the scrollbar its true length. */
  function renderWindow(): void {
    if (!tbody || !visibleFrozen) return
    const total = visibleRows.length
    const viewport = tableWrap.clientHeight || 600
    const first = Math.max(0, Math.floor(tableWrap.scrollTop / ROW_HEIGHT) - OVERSCAN)
    if (first === windowStart) return
    windowStart = first
    const last = Math.min(total, first + Math.ceil(viewport / ROW_HEIGHT) + OVERSCAN * 2)
    const columnCount = tbody.parentElement!.querySelectorAll('thead th').length
    const spacer = (height: number): HTMLElement => { const tr = h('tr', { class: 'spacer' }); const td = h('td', { colspan: String(columnCount) }); td.style.height = `${height}px`; td.style.padding = '0'; td.style.border = '0'; tr.append(td); return tr }
    const frozen = visibleFrozen
    tbody.replaceChildren(spacer(first * ROW_HEIGHT), ...visibleRows.slice(first, last).map(v => rowElement(frozen, v)), spacer(Math.max(0, total - last) * ROW_HEIGHT))
  }

  function rowElement(frozen: FrozenRun, { row, index }: Visible): HTMLTableRowElement {
    const multi = frozen.models.length > 1
    const c = frozen.cases[row.coord.caseIndex]!
    const model = frozen.models[row.coord.modelIndex]!
    const text = row.status === 'error' ? (row.error ?? 'error') : responseText(row)
    const tr = h('tr', { class: 'result-row' },
      h('td', { class: 'mono' }, c.label),
      multi ? h('td', { class: 'mono' }, model.id) : null,
      frozen.repeats > 1 ? h('td', { class: 'center' }, String(row.coord.repeat + 1)) : null,
      h('td', { class: 'center' }, h('span', { class: `status ${row.status}${row.parseStatus === 'failed' ? ' parse-failed' : ''}` }, row.status === 'running' && row.error ? row.error.slice(0, 24) : statusLabel(row))),
      ...visibleColumns.map(k => h('td', { class: 'parsed-cell' }, cell(row, k).slice(0, 80))),
      h('td', { class: `result-long ${row.status === 'error' ? 'err-text' : ''}` }, text.length > 240 ? `${text.slice(0, 240)}…` : text),
      h('td', { class: 'center' }, formatUsd(row.costUsd ?? row.estimatedCostUsd)),
    )
    tr.addEventListener('click', () => openDetail(frozen, row, index))
    return tr
  }

  /** The breakdown of the chosen column over the rows currently shown: counts
   * as bars, and a per-model table when the run has more than one model.
   * Rendered on every refresh, so it follows a run live. */
  function renderBreakdown(frozen: FrozenRun, allRows: number): void {
    breakdownBox.replaceChildren()
    breakdownBox.hidden = breakdownKey === null
    if (breakdownKey === null) return
    const key = breakdownKey
    const isStatus = key === 'status'
    const name = isStatus ? 'Status' : key.slice('parsed:'.length)
    const models = frozen.models.map(m => m.id)
    const items = visibleRows.map(({ row }) => ({ model: models[row.coord.modelIndex]!, value: isStatus ? statusLabel(row) : row.status === 'ok' ? parsedValue(row, name) : null }))
    const field = frozen.contract?.fields.find(f => f.name === name)
    const kind: FieldKind = isStatus ? 'categorical' : field ? (field.type === 'number' || field.type === 'integer' ? 'numeric' : 'categorical') : inferKind(items)
    const b = breakdown(items, kind, models)
    const close = h('button', { class: 'minibtn', type: 'button' }, 'Close')
    close.addEventListener('click', () => { breakdownKey = null; renderTable(current()) })
    const filtered = visibleRows.length !== allRows
    breakdownBox.append(h('div', { class: 'breakdown-head' }, h('strong', {}, name),
      h('span', { class: 'muted small' }, `${b.answered.toLocaleString()} of ${b.total.toLocaleString()} calls${filtered ? ' shown (filters apply)' : ''} have an answer`), close))
    if (b.stats) breakdownBox.append(h('p', { class: 'breakdown-stats' }, `min ${formatNumber(b.stats.min)} · median ${formatNumber(b.stats.median)} · mean ${formatNumber(b.stats.mean)} · max ${formatNumber(b.stats.max)}`))
    if (b.answered === 0) { breakdownBox.append(h('p', { class: 'muted small' }, 'Nothing has come back yet.')); return }
    const most = Math.max(1, ...b.values.map(v => v.count))
    const denominator = b.values.reduce((s, v) => s + v.count, 0) || 1
    const list = h('div', { class: 'bar-list' })
    for (const v of b.values) {
      const fill = h('div')
      fill.style.width = `${(v.count / most) * 100}%`
      list.append(h('span', { class: 'bar-label', title: v.value }, v.value), h('span', { class: 'bar-count' }, v.count.toLocaleString()), h('span', { class: 'bar-pct' }, `${Math.round((v.count / denominator) * 100)}%`), h('div', { class: 'bar' }, fill))
    }
    breakdownBox.append(list)
    if (models.length > 1) {
      const numeric = b.kind === 'numeric'
      const table = h('table', { class: 'grid-table breakdown-matrix' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Model'), h('th', { class: 'center' }, 'n'), ...(numeric ? [h('th', { class: 'center' }, 'median'), h('th', { class: 'center' }, 'mean')] : []), ...b.values.map(v => h('th', { class: 'center', title: v.value }, v.value.length > 18 ? `${v.value.slice(0, 17)}…` : v.value)))),
        h('tbody', {}, ...b.byModel.map(m => h('tr', {}, h('td', { class: 'mono' }, m.model), h('td', { class: 'center' }, String(m.answered)),
          ...(numeric ? [h('td', { class: 'center' }, m.median === undefined ? '' : formatNumber(m.median)), h('td', { class: 'center' }, m.mean === undefined ? '' : formatNumber(m.mean))] : []),
          ...m.counts.map(c => h('td', { class: 'center' }, c ? String(c) : ''))))))
      breakdownBox.append(table)
    }
  }

  function openDetail(frozen: FrozenRun, row: CallRow, index: number): void {
    const c = frozen.cases[row.coord.caseIndex]!
    const model = frozen.models[row.coord.modelIndex]!
    const call = renderCall(frozen, row.coord)
    const dialog = h('dialog', { class: 'payload-dialog detail-dialog', 'aria-label': `Call ${index + 1}` })
    const close = h('button', { class: 'minibtn', type: 'button' }, 'Close')
    close.addEventListener('click', () => dialog.close())
    dialog.addEventListener('close', () => dialog.remove())
    dialog.addEventListener('click', ev => { if (ev.target === dialog) dialog.close() })
    const section = (title: string, node: Node | null): HTMLElement | null => node ? h('section', { class: 'detail-section' }, h('h3', {}, title), node) : null
    const md = (text: string | undefined): HTMLElement | null => { if (!text) return null; const box = h('div', { class: 'response-text' }); renderMarkdown(box, text); return box }
    const nodes: Array<HTMLElement | null> = [
      h('div', { class: 'payload-dialog-head' }, h('strong', {}, `${c.label} · ${model.id}${frozen.repeats > 1 ? ` · repeat ${row.coord.repeat + 1}` : ''}`), close),
      h('p', { class: 'muted small' }, `${row.status}${row.httpStatus ? ` · HTTP ${row.httpStatus}` : ''}${row.latencyMs != null ? ` · ${row.latencyMs} ms` : ''}${row.totalTokens != null ? ` · ${row.totalTokens} tokens` : ''}${row.costUsd != null ? ` · ${formatUsd(row.costUsd)}` : ''}${row.upstream ? ` · via ${row.upstream}` : ''} · parse: ${row.parseStatus}`),
      row.error ? section('Error', h('pre', { class: 'payload-code err-text' }, row.error)) : null,
      row.parsed !== null ? section('Parsed fields', h('pre', { class: 'payload-code' }, typeof row.parsed === 'object' ? JSON.stringify(row.parsed, null, 2) : String(row.parsed))) : null,
      section('Response', md(responseText(row))),
      section('Reasoning', md(row.thinking)),
      section('Request that was sent', h('div', {}, h('p', { class: 'muted small' }, `${call.url}${row.bodyHash ? ` · body SHA-256 ${row.bodyHash.slice(0, 16)}…` : ''}`), h('pre', { class: 'payload-code' }, JSON.stringify(call.body, null, 2)))),
      section('Raw provider payload', row.raw ? h('pre', { class: 'payload-code' }, pretty(row.raw)) : null),
    ]
    dialog.append(...nodes.filter((n): n is HTMLElement => n !== null))
    document.body.append(dialog)
    dialog.showModal()
  }

  async function renderSaved(): Promise<void> {
    const runs = await actions.listRuns()
    saved.replaceChildren(...(runs.length ? runs.map(r => {
      const open = h('button', { class: 'minibtn', type: 'button' }, 'Open')
      const del = h('button', { class: 'minibtn danger', type: 'button' }, 'Delete')
      open.addEventListener('click', () => void actions.openRun(r.id))
      del.addEventListener('click', () => void actions.deleteStoredRun(r.id).then(renderSaved))
      return h('div', { class: 'saved-run' }, h('span', { class: 'mono small' }, new Date(r.createdAt).toLocaleString()), h('span', {}, r.label), h('span', { class: 'muted small' }, `${r.calls} calls`), open, del)
    }) : [h('p', { class: 'muted small' }, 'No saved runs yet. Every run is saved here as it progresses, so a closed tab loses nothing.')]))
  }

  function renderTally(data: AppData): void {
    const { frozen, rows } = data.session
    if (!frozen || rows.length === 0) { tally.replaceChildren(); progress.hidden = true; return }
    let ok = 0, failed = 0, inFlight = 0, waiting = 0, spent = 0, unpriced = 0, remaining = 0
    for (const row of rows) {
      if (row.status === 'ok') { ok++; if (row.costUsd != null) spent += row.costUsd; else if (row.estimatedCostUsd != null) spent += row.estimatedCostUsd; else unpriced++ }
      else if (row.status === 'error') failed++
      else { if (row.status === 'running') inFlight++; else waiting++; if (row.estimatedCostUsd != null) remaining += row.estimatedCostUsd }
    }
    const total = rows.length
    const done = ok + failed
    const left = inFlight + waiting
    // Projection from what has actually come back: average real cost per
    // finished priced call times the calls left; before anything is back, the
    // pre-run estimate. Time from the completion rate of this execution.
    const priced = rows.filter(r => r.status === 'ok' && r.costUsd != null)
    const avgCost = priced.length ? priced.reduce((s, r) => s + (r.costUsd ?? 0), 0) / priced.length : null
    const projectedTotal = avgCost !== null ? spent + avgCost * left : spent + remaining
    const startedAt = data.session.runStartedAt
    const doneThisRun = done - data.session.runDoneAtStart
    const elapsedMs = startedAt ? Date.now() - startedAt : 0
    const rate = elapsedMs > 0 && doneThisRun > 0 ? doneThisRun / elapsedMs : null
    const leftMs = rate && left > 0 ? left / rate : null
    const clock = (ms: number): string => { const s = Math.round(ms / 1000); return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s` }
    const stat = (n: number, label: string, cls = ''): HTMLElement => h('span', { class: `tally-item ${cls}` }, h('strong', {}, String(n)), ` ${label}`)
    const items: Array<HTMLElement | null> = [
      stat(done, `of ${total} done`),
      stat(ok, 'succeeded', 'ok-text'),
      stat(failed, 'failed', failed ? 'err-text' : ''),
      stat(inFlight, 'running', inFlight ? 'running-text' : ''),
      stat(waiting, 'waiting'),
      h('span', { class: 'tally-item tally-cost' },
        h('strong', {}, formatUsd(spent)), ` spent so far${unpriced ? ` (${unpriced} calls without a price)` : ''}`,
        left > 0 ? h('span', { class: 'muted' }, ` · about ${formatUsd(projectedTotal)} expected in total${avgCost !== null ? ', from the calls back so far' : ', from the pre-run estimate'}`) : null),
      data.session.running && startedAt ? h('span', { class: 'tally-item muted' }, `${clock(elapsedMs)} elapsed${leftMs !== null ? ` · about ${clock(leftMs)} left` : ''}`) : null,
    ]
    tally.replaceChildren(...items.filter((n): n is HTMLElement => n !== null))
    progress.hidden = false
    ;(progress.children[0] as HTMLElement).style.width = `${(ok / total) * 100}%`
    ;(progress.children[1] as HTMLElement).style.width = `${(failed / total) * 100}%`
    ;(progress.children[2] as HTMLElement).style.width = `${(inFlight / total) * 100}%`
    progress.title = `${done} of ${total} done`
  }

  function refresh(data: AppData): void {
    const { frozen, running, paused, rows, statusLine, sourceRows } = data.session
    if (!running) followLive = true
    renderTally(data)
    status.textContent = statusLine
    pause.hidden = !running || paused
    resume.hidden = !running || !paused
    cancel.hidden = !running
    const missing = frozen ? rows.some(r => r.status !== 'ok') : false
    rerun.hidden = !frozen || running || !missing
    for (const b of [exportXlsx, exportCsv, exportJsonl, exportPy, saveRun]) b.disabled = !frozen
    exportCompleted.disabled = !frozen || !sourceRows
    exportCompleted.hidden = !frozen?.source
    if (frozen) {
      const ids = frozen.models.map(m => m.id)
      if (modelFilter.options.length !== ids.length + 1 || [...modelFilter.options].slice(1).some((o, i) => o.value !== ids[i])) {
        modelFilter.replaceChildren(h('option', { value: '' }, 'All models'), ...ids.map(id => h('option', { value: id }, id)))
      }
      modelFilter.hidden = ids.length < 2
    }
    renderTable(data)
  }

  return { el, refresh }
}

function pretty(source: string): string {
  try { return JSON.stringify(JSON.parse(source), null, 2) } catch { return source }
}
