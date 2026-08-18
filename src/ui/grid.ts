// The results surface, in one place: it serves the live streaming run AND the
// completed run from the same call model so a column that exists live keeps
// existing when the run finishes. Reasoning and response are always separate
// columns; the final view adds parsed fields and a raw-payload inspector but
// never buries one model inside another on a single-probe run.
//
// Consumes CallResult/RunSpec only — no run logic here.

import { formatUsd } from '../core/pricing'
import { buildRows } from '../core/export'
import type { ExportRow } from '../core/export'
import type { CallResult, ContentPart, RunMeta, RunSpec } from '../core/types'
import { h } from './dom'
import { renderMarkdown } from './markdown'

interface RowCells {
  tr: HTMLTableRowElement
  caseLabel: string
  latest: CallResult
  status: HTMLTableCellElement
  cost: HTMLTableCellElement
  tokens: HTMLTableCellElement
  latency: HTMLTableCellElement
  reasoning: HTMLTableCellElement
  body: HTMLTableCellElement
}

interface FinalColumn {
  key: string
  label: string
}

/** The final table is a comparison, not a raw dump. Parsed fields come from
 * buildRows; helpers render derived cells the export row does not carry. */
const FINAL_COLUMNS: FinalColumn[] = [
  { key: 'case', label: 'Row' },
  { key: 'model', label: 'Model' },
  { key: 'status', label: 'Status' },
  { key: 'parsed_', label: '' }, // placeholder, replaced by parsed columns
  { key: 'cost', label: 'Cost' },
  { key: 'totalTokens', label: 'Tokens' },
  { key: 'thinking', label: 'Reasoning' },
  { key: 'response', label: 'Response' },
  { key: 'raw', label: 'Raw' },
]

function partText(parts: ContentPart[]): string {
  return parts.filter(part => part.kind === 'text').map(part => part.text).join('\n')
}

function partNodes(parts: ContentPart[], container: HTMLElement): void {
  for (const part of parts) {
    if (part.kind === 'text') {
      const textBox = h('div', { class: 'response-text' })
      renderMarkdown(textBox, part.text)
      container.append(textBox)
    } else if (part.kind === 'image') {
      if (part.dataUrl || part.url) {
        const img = h('img', { class: 'response-image', alt: 'model output image' })
        img.src = part.dataUrl ?? part.url!
        container.append(img)
      }
    } else if (part.kind === 'toolCall') {
      container.append(h('div', { class: 'tool-call' },
        h('span', { class: 'tool-name' }, `tool: ${part.name}`),
        h('pre', {}, JSON.stringify(part.args, null, 2)),
      ))
    }
  }
}

export class ResultsGrid {
  private tbody: HTMLTableSectionElement
  private cells: RowCells[] = []
  private finalData: { meta: RunMeta; specs: readonly RunSpec[]; results: readonly CallResult[]; parserId: string | null } | null = null
  private finalQuery = ''
  private finalStatus = 'all'
  private activeModel = ''

  constructor(private container: HTMLElement) {
    this.tbody = this.buildTable()
  }

  private buildTable(): HTMLTableSectionElement {
    const table = h('table', { class: 'grid-table live-table' })
    const head = h('thead')
    head.append(h('tr', {},
      h('th', {}, 'Case'),
      h('th', {}, 'Model'),
      h('th', { class: 'center' }, 'Status'),
      h('th', { class: 'center' }, 'Cost'),
      h('th', { class: 'center' }, 'Tokens'),
      h('th', { class: 'center' }, 'Latency'),
      h('th', {}, 'Reasoning'),
      h('th', {}, 'Response'),
    ))
    const tbody = h('tbody')
    table.append(head, tbody)
    this.container.replaceChildren(table)
    return tbody
  }

  reset(results: readonly CallResult[], caseLabels?: readonly string[]): void {
    this.finalData = null
    this.tbody = this.buildTable()
    this.cells = results.map((r, index) => this.addRow(r, caseLabels?.[index] ?? String(index + 1)))
  }

  clear(): void {
    this.tbody.replaceChildren()
    this.cells = []
  }

  /** Keep the table readable as a run grows. Filtering only changes row
   * visibility; live updates and export order remain untouched. */
  setFilter(query: string, status: string): void {
    if (this.finalData) {
      this.finalQuery = query
      this.finalStatus = status
      this.renderFinal()
      return
    }
    const needle = query.trim().toLowerCase()
    for (const row of this.cells) {
      const response = partText(row.latest.parts)
      const haystack = `${row.caseLabel} ${row.latest.model} ${row.latest.error ?? ''} ${response} ${row.latest.thinking ?? ''}`.toLowerCase()
      row.tr.hidden = (status !== 'all' && row.latest.status !== status) || (!!needle && !haystack.includes(needle))
    }
  }

  /** Surface a transient failure being retried: the row stays pending but the
   * status cell reports the retry in flight. */
  markRetrying(index: number, attempt: number, max: number): void {
    const row = this.cells[index]
    if (!row || row.latest.status !== 'pending') return
    row.status.textContent = `retrying ${attempt}/${max}`
    row.status.className = 'status retrying'
  }

  /** Completed runs become a compact comparison table: parsed fields as real
   * columns, multi-model sheet work model-tabbed, single-probe runs as a
   * head-to-head model column. */
  showCompleted(meta: RunMeta, specs: readonly RunSpec[], results: readonly CallResult[], parserId: string | null): void {
    this.finalData = { meta, specs, results, parserId }
    this.activeModel = [...new Set(specs.map(spec => spec.model))][0] ?? ''
    this.renderFinal()
  }

  private renderFinal(): void {
    const data = this.finalData
    if (!data) return
    const models = [...new Set(data.specs.map(spec => spec.model))]
    const { columns, rows } = buildRows(data.meta, [...data.specs], [...data.results], data.parserId)
    const parsed = columns.filter(column => column.key.startsWith('parsed_') || column.key === 'parsed')
    // A single prompt across models is a direct comparison (models as rows);
    // sheets are easier inspected one model at a time across many cases.
    const tabbedModels = models.length > 1 && new Set(data.specs.map(spec => spec.caseLabel)).size > 1
    const includeModel = models.length > 1

    const visible = FINAL_COLUMNS.flatMap(column => {
      if (column.key === 'model') return includeModel ? [column] : []
      if (column.key === 'parsed_') return parsed.map(parsedColumn => ({ key: parsedColumn.key, label: parsedColumn.label }))
      return [column]
    })

    const needle = this.finalQuery.trim().toLowerCase()
    const rowsForModel = rows.filter(row => {
      if (tabbedModels && row.model !== this.activeModel) return false
      if (this.finalStatus !== 'all' && row.status !== this.finalStatus) return false
      return !needle || Object.values(row).some(value => String(value ?? '').toLowerCase().includes(needle))
    })

    const tabs = tabbedModels
      ? h('div', { class: 'result-tabs', role: 'tablist', 'aria-label': 'Models' }, ...models.map(model => {
        const tab = h('button', { class: `result-tab ${model === this.activeModel ? 'active' : ''}`, type: 'button', role: 'tab' }, model)
        tab.addEventListener('click', () => { this.activeModel = model; this.renderFinal() })
        return tab
      }))
      : null
    const table = h('table', { class: 'grid-table final-table' })
    table.append(h('thead', {}, h('tr', {}, ...visible.map(column => h('th', {}, column.label)))))
    const body = h('tbody')
    for (const row of rowsForModel) {
      body.append(this.renderFinalRow(row, visible))
    }
    table.append(body)
    this.container.replaceChildren(...(tabs ? [tabs] : []), h('div', { class: 'final-table-wrap' }, table))
  }

  private renderFinalRow(row: ExportRow, visible: FinalColumn[]): HTMLTableRowElement {
    const tr = h('tr')
    for (const column of visible) {
      const cell = h('td', { class: column.key === 'response' || column.key === 'thinking' ? 'result-long' : column.key === 'raw' ? 'raw-cell' : '' })
      if (column.key === 'response') {
        const response = h('div', { class: 'response-text' })
        renderMarkdown(response, String(row.response ?? ''))
        cell.append(response)
      } else if (column.key === 'thinking') {
        if (row.thinking) {
          const thinkingBox = h('div', { class: 'response-box thinking-text' })
          renderMarkdown(thinkingBox, String(row.thinking))
          cell.append(thinkingBox)
        } else {
          cell.textContent = '—'
        }
      } else if (column.key === 'cost') {
        cell.textContent = formatUsd((row.costUsd ?? row.estimatedCostUsd) as number | null | undefined)
      } else if (column.key === 'raw') {
        this.appendRawInspector(cell, row.response, row.raw)
      } else {
        const value = row[column.key]
        cell.textContent = value == null || value === '' ? '—' : String(value)
      }
      tr.append(cell)
    }
    return tr
  }

  private appendRawInspector(cell: HTMLTableCellElement, response: unknown, raw: unknown): void {
    // Prefer the one-byte-fidelity anchor; fall back to the reconstructed text.
    const payload = typeof raw === 'string' && raw.length > 0 ? raw : response
    const button = h('button', { class: 'minibtn raw-coin', type: 'button', title: 'Inspect raw provider payload' }, 'raw')
    button.disabled = payload == null || String(payload) === ''
    button.addEventListener('click', () => this.openInspector('Raw provider payload', String(payload ?? '')))
    cell.append(button)
  }

  update(index: number, result: CallResult): void {
    const row = this.cells[index]
    if (!row) return
    row.latest = result
    row.status.textContent = result.status
    row.status.className = `status ${result.status}`
    row.cost.textContent = formatUsd(result.costUsd ?? result.estimatedCostUsd)
    row.tokens.textContent = formatTokens(result)
    row.latency.textContent = result.latencyMs != null ? `${result.latencyMs} ms` : '—'
    row.reasoning.replaceChildren()
    if (result.thinking) {
      const thinkingBox = h('div', { class: 'response-box thinking-text' })
      renderMarkdown(thinkingBox, result.thinking)
      row.reasoning.append(thinkingBox)
    } else {
      row.reasoning.textContent = '—'
    }
    row.body.replaceChildren()
    row.body.append(bodyFor(result), this.tools(result))
  }

  private tools(result: CallResult): HTMLElement {
    const raw = h('button', { class: 'minibtn', type: 'button' }, 'View raw')
    raw.disabled = result.rawJson == null
    raw.addEventListener('click', () => this.openInspector('Raw provider payload', result.rawJson ?? ''))

    const copy = h('button', { class: 'minibtn', type: 'button' }, 'Copy')
    copy.addEventListener('click', () => {
      const text = partText(result.parts) || result.rawJson || result.error || ''
      void navigator.clipboard.writeText(text).then(() => {
        copy.textContent = 'Copied ✓'
        setTimeout(() => { copy.textContent = 'Copy' }, 1200)
      })
    })
    return h('div', { class: 'row-tools' }, raw, copy)
  }

  /** Provider payloads can be arbitrarily large. They belong in a bounded
   * inspector, never in a table cell whose intrinsic width can wreck results. */
  private openInspector(title: string, source: string): void {
    const dialog = h('dialog', { class: 'payload-dialog', 'aria-label': title })
    const close = h('button', { class: 'minibtn', type: 'button' }, 'Close')
    close.addEventListener('click', () => dialog.close())
    dialog.addEventListener('click', event => {
      if (event.target === dialog) dialog.close()
    })
    dialog.addEventListener('close', () => dialog.remove())
    dialog.append(
      h('div', { class: 'payload-dialog-head' }, h('strong', {}, title), close),
      h('pre', { class: 'payload-code' }, prettyPayload(source)),
    )
    document.body.append(dialog)
    dialog.showModal()
  }

  private addRow(result: CallResult, caseLabel: string): RowCells {
    const tr = h('tr')
    const caseCell = h('td', { class: 'mono' }, caseLabel)
    const model = h('td', { class: 'mono' }, result.model)
    const status = h('td', { class: 'center status pending' }, 'pending')
    const cost = h('td', { class: 'center' }, formatUsd(result.estimatedCostUsd))
    const tokens = h('td', { class: 'center' }, '—')
    const latency = h('td', { class: 'center' }, '—')
    const reasoning = h('td', { class: 'reasoning-cell' }, '—')
    const body = h('td', {}, h('div', { class: 'response-box pending' }, 'waiting…'))
    tr.append(caseCell, model, status, cost, tokens, latency, reasoning, body)
    this.tbody.append(tr)
    return { tr, caseLabel, latest: result, status, cost, tokens, latency, reasoning, body }
  }
}

function formatTokens(r: CallResult): string {
  const parts = [r.promptTokens, r.completionTokens].filter((t): t is number => t != null)
  if (parts.length === 0) return r.totalTokens != null ? `${r.totalTokens} total` : '—'
  const total = r.totalTokens != null ? ` (${r.totalTokens})` : ''
  return `${parts.join(' / ')}${total}`
}

function bodyFor(r: CallResult): HTMLElement {
  if (r.status === 'error') return h('div', { class: 'response-box err' }, r.error ?? 'Unknown error')
  if (r.status === 'pending') return h('div', { class: 'response-box pending' }, 'waiting…')
  const box = h('div', { class: 'response-box' })
  partNodes(r.parts, box)
  return box
}

function prettyPayload(source: string): string {
  try { return JSON.stringify(JSON.parse(source), null, 2) }
  catch { return source }
}