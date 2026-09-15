// Screen 6: results. One row per call, fifty to a page, filters, a detail
// dialog per row (parsed fields, response, reasoning, the exact request, raw
// payload, error), exports, and the saved runs with Open / Resume / Delete.

import { renderMarkdown } from '../markdown'
import { formatUsd } from '../../core/pricing'
import { renderCall } from '../../core/render'
import { responseText } from '../../core/run'
import type { CallRow, FrozenRun } from '../../core/types'
import type { Actions } from '../actions'
import { h } from '../dom'
import type { AppData, Store } from '../store'
import type { Screen } from './screen'

const PAGE = 50

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
  const tableWrap = h('div', { class: 'final-table-wrap' })
  const pager = h('div', { class: 'row pager' })
  const saved = h('div', { class: 'saved-runs' })

  const el = h('section', { class: 'card stage-card' },
    h('div', { class: 'stage-heading' }, h('h2', {}, 'Results')),
    tally,
    progress,
    h('div', { class: 'results-toolbar' }, status, pause, resume, cancel, rerun),
    h('div', { class: 'results-toolbar' }, exportXlsx, exportCsv, exportJsonl, exportCompleted, exportPy, saveRun, openRun, openRunInput),
    h('div', { class: 'result-filters' }, search, statusFilter, modelFilter),
    tableWrap,
    pager,
    h('details', { class: 'schema-preview saved-runs-box' }, h('summary', {}, 'Saved runs on this device'), saved),
  )

  let page = 0
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
  search.addEventListener('input', () => { page = 0; renderTable(current()) })
  statusFilter.addEventListener('change', () => { page = 0; renderTable(current()) })
  modelFilter.addEventListener('change', () => { page = 0; renderTable(current()) })
  el.querySelector('.saved-runs-box')!.addEventListener('toggle', ev => { if ((ev.target as HTMLDetailsElement).open) void renderSaved() })

  function current(): AppData { return { state: store.state, session: store.session } }

  function parsedColumns(frozen: FrozenRun, rows: CallRow[]): string[] {
    if (frozen.parserId !== 'json-unstack') return frozen.parserId ? ['parsed'] : []
    if (frozen.contract) return frozen.contract.fields.map(f => f.name)
    const keys = new Set<string>()
    for (const row of rows) if (row.parsed && typeof row.parsed === 'object') for (const k of Object.keys(row.parsed as object)) keys.add(k)
    return [...keys].sort().slice(0, 12)
  }

  function cell(row: CallRow, key: string): string {
    if (key === 'parsed') return row.parsed === null ? '' : typeof row.parsed === 'object' ? JSON.stringify(row.parsed) : String(row.parsed)
    if (!row.parsed || typeof row.parsed !== 'object') return ''
    const v = (row.parsed as Record<string, unknown>)[key]
    return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  }

  function renderTable(data: AppData): void {
    const { frozen, rows } = data.session
    tableWrap.replaceChildren()
    pager.replaceChildren()
    if (!frozen) { tableWrap.append(h('p', { class: 'muted' }, 'Run something to see results here, or open a saved run below.')); return }
    const q = search.value.trim().toLowerCase()
    const sf = statusFilter.value
    const mf = modelFilter.value
    const visible = rows.map((row, index) => ({ row, index })).filter(({ row }) => {
      const model = frozen.models[row.coord.modelIndex]!
      if (mf && model.id !== mf) return false
      if (sf === 'parse-failed' ? row.parseStatus !== 'failed' : sf !== 'all' && row.status !== sf) return false
      if (!q) return true
      const c = frozen.cases[row.coord.caseIndex]!
      return `${c.label} ${model.id} ${responseText(row)} ${row.error ?? ''} ${JSON.stringify(row.parsed ?? '')}`.toLowerCase().includes(q)
    })
    const columns = parsedColumns(frozen, rows)
    const multi = frozen.models.length > 1
    const table = h('table', { class: 'grid-table final-table' })
    table.append(h('thead', {}, h('tr', {}, h('th', {}, 'Case'), multi ? h('th', {}, 'Model') : null, frozen.repeats > 1 ? h('th', {}, 'Rep') : null, h('th', { class: 'center' }, 'Status'),
      ...columns.map(c => h('th', {}, c)), h('th', {}, 'Response'), h('th', { class: 'center' }, 'Cost'))))
    const body = h('tbody')
    const start = page * PAGE
    for (const { row, index } of visible.slice(start, start + PAGE)) {
      const c = frozen.cases[row.coord.caseIndex]!
      const model = frozen.models[row.coord.modelIndex]!
      const text = row.status === 'error' ? (row.error ?? 'error') : responseText(row)
      const tr = h('tr', { class: 'result-row' },
        h('td', { class: 'mono' }, c.label),
        multi ? h('td', { class: 'mono' }, model.id) : null,
        frozen.repeats > 1 ? h('td', { class: 'center' }, String(row.coord.repeat + 1)) : null,
        h('td', { class: 'center' }, h('span', { class: `status ${row.status}${row.parseStatus === 'failed' ? ' parse-failed' : ''}` }, row.status === 'running' && row.error ? row.error.slice(0, 24) : row.status === 'running' ? 'in flight' : row.status === 'pending' ? 'waiting' : row.status === 'ok' && row.parseStatus === 'failed' ? 'ok, unparsed' : row.status)),
        ...columns.map(k => h('td', { class: 'parsed-cell' }, cell(row, k).slice(0, 80))),
        h('td', { class: `result-long ${row.status === 'error' ? 'err-text' : ''}` }, text.length > 240 ? `${text.slice(0, 240)}…` : text),
        h('td', { class: 'center' }, formatUsd(row.costUsd ?? row.estimatedCostUsd)),
      )
      tr.addEventListener('click', () => openDetail(frozen, row, index))
      body.append(tr)
    }
    table.append(body)
    tableWrap.append(table)
    if (visible.length > PAGE) {
      const prev = h('button', { class: 'minibtn', type: 'button' }, '← previous')
      const next = h('button', { class: 'minibtn', type: 'button' }, 'next →')
      prev.disabled = page === 0
      next.disabled = start + PAGE >= visible.length
      prev.addEventListener('click', () => { page--; renderTable(current()) })
      next.addEventListener('click', () => { page++; renderTable(current()) })
      pager.append(prev, h('span', { class: 'muted small' }, `${start + 1}–${Math.min(visible.length, start + PAGE)} of ${visible.length}`), next)
    } else if (visible.length !== rows.length) {
      pager.append(h('span', { class: 'muted small' }, `${visible.length} of ${rows.length} calls`))
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
      stat(inFlight, 'in flight', inFlight ? 'running-text' : ''),
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
