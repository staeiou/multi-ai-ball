// Screen 1: your data. Three ways to say where the cases come from. For a
// spreadsheet the app looks at the sheet first and proposes answers to the
// only two questions that matter (what the model reads, what it fills in);
// every other column is kept and never sent. Nothing is required of the user
// beyond checking the guesses.

import { parseSweepValues, sweepCaseCount } from '../../core/cases'
import { columnFacts } from '../../core/guess'
import { columnsWithRole, isBlank } from '../../core/partition'
import type { ColumnRole } from '../../core/types'
import type { Flow } from '../../state'
import type { Actions } from '../actions'
import { h } from '../dom'
import { SWEEP_MAX, SWEEP_WARN, currentPartition, currentRows, dataProblems, sweepPlaceholders, sweepVariables } from '../model'
import { renderPromptTemplate } from '../../core/template'
import type { AppData, Store } from '../store'
import type { Screen } from './screen'

export function buildDataScreen(store: Store, actions: Actions): Screen {
  const flowTabs = h('div', { class: 'chips flow-tabs' })
  const intro = h('p', { class: 'muted' })
  const sheetInput = h('input', { type: 'file', accept: '.csv,.tsv,.xlsx,.xls,.json,.jsonl,.ndjson' })
  sheetInput.hidden = true
  const uploadBtn = h('button', { class: 'btn primary', type: 'button' }, 'Upload a spreadsheet…')
  const sheetFacts = h('span', { class: 'muted small' })
  const previewBox = h('div', { class: 'data-preview' })
  const readBox = h('div', { class: 'question-box' })
  const fillBox = h('div', { class: 'question-box' })
  const keptBox = h('p', { class: 'muted small' })
  const partitionBox = h('div', { class: 'partition-box' })
  const sweepBox = h('div', { class: 'sweep-box' })
  const problems = h('p', { class: 'wizard-blocker inline-blocker' })

  const sheetSection = h('div', { class: 'sheet-section' }, h('div', { class: 'row' }, uploadBtn, sheetInput, sheetFacts), previewBox, readBox, fillBox, keptBox, partitionBox)
  const el = h('section', { class: 'card stage-card' },
    h('div', { class: 'stage-heading' }, h('h2', {}, 'Your data'), h('p', {}, 'What are you asking the models about?')),
    flowTabs,
    intro,
    sheetSection,
    sweepBox,
    problems,
  )

  uploadBtn.addEventListener('click', () => sheetInput.click())
  sheetInput.addEventListener('change', () => { const f = sheetInput.files?.[0]; if (f) void actions.loadSheet(f); sheetInput.value = '' })

  const FLOWS: Array<[Flow, string, string]> = [
    ['single', 'One question', 'Ask the same thing of several models and compare their answers side by side.'],
    ['sheet', 'A spreadsheet', 'Each row is one case. Pick the column the model reads and the column it fills in. Rows you already filled in teach the model by example.'],
    ['sweep', 'Variations', 'Write one prompt with blanks like {{name}} and lists of values to try in each blank; every combination is asked.'],
  ]

  function renderFlowTabs(data: AppData): void {
    flowTabs.replaceChildren(...FLOWS.map(([flow, label]) => {
      const chip = h('button', { class: `chip ${data.state.flow === flow ? 'active' : ''}`, type: 'button', 'data-flow': flow }, label)
      chip.addEventListener('click', () => store.update(d => { d.state.flow = flow }))
      return chip
    }))
    intro.textContent = FLOWS.find(([f]) => f === data.state.flow)?.[2] ?? ''
    sheetSection.hidden = data.state.flow !== 'sheet'
    sweepBox.hidden = data.state.flow !== 'sweep'
  }

  let sheetKey = ''
  function renderSheet(data: AppData): void {
    if (data.state.flow !== 'sheet') return
    const { sheet, sheetError, loadingSheet } = data.session
    sheetFacts.textContent = loadingSheet ? 'Reading…' : sheetError ?? (sheet ? `${sheet.name}: ${sheet.rows.length.toLocaleString()} rows, ${sheet.columns.length} columns` : 'Excel or CSV (also TSV, JSON, JSONL). The first row should hold the column names.')
    if (!sheet) { previewBox.replaceChildren(); readBox.replaceChildren(); fillBox.replaceChildren(); keptBox.textContent = ''; partitionBox.replaceChildren(); sheetKey = ''; return }
    const { rows, roles } = currentRows(data)
    const key = JSON.stringify([sheet.name, rows.length, sheet.columns, roles, data.session.partitionOverride])
    if (key === sheetKey) return
    sheetKey = key

    // A glance at the data: the first five rows.
    const table = h('table', { class: 'sheet-table' })
    table.append(h('thead', {}, h('tr', {}, h('th', {}, '#'), ...sheet.columns.map(c => h('th', { title: c }, c)))))
    const body = h('tbody')
    rows.slice(0, 5).forEach((row, i) => body.append(h('tr', {}, h('td', { class: 'sheet-index' }, String(i + 1)), ...sheet.columns.map(c => { const v = isBlank(row[c]) ? '' : String(row[c]); return h('td', { title: v }, v.length > 60 ? `${v.slice(0, 60)}…` : v) }))))
    table.append(body)
    previewBox.replaceChildren(h('p', { class: 'muted small' }, rows.length > 5 ? `The first 5 of ${rows.length.toLocaleString()} rows:` : 'Your rows:'), h('div', { class: 'sheet-table-wrap' }, table))

    const inputs = columnsWithRole(roles, 'input')
    const outputs = columnsWithRole(roles, 'output')
    readBox.replaceChildren(
      h('h3', {}, '1. Which column should the model read?'),
      h('p', { class: 'muted small' }, 'Usually the text you want judged, scored or summarized. Pick more than one if the model needs several.'),
      checklist(data, sheet.columns, 'input', inputs, roles),
    )
    const newColumn = h('input', { class: 'input new-column', placeholder: 'e.g. sentiment' })
    const addNew = h('button', { class: 'btn', type: 'button' }, 'Add a new column')
    const add = (): void => {
      const name = newColumn.value.trim()
      if (!name || sheet.columns.includes(name)) return
      setRole(name, 'output')
      newColumn.value = ''
    }
    addNew.addEventListener('click', add)
    newColumn.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); add() } })
    const newOutputs = outputs.filter(c => !sheet.columns.includes(c))
    const fillChildren: Array<HTMLElement | null> = [
      h('h3', {}, '2. Which column should the model fill in?'),
      h('p', { class: 'muted small' }, 'A column with some rows already filled in works best: those rows show the model what you want, and it fills in the rest. Or add a brand-new column for the answer.'),
      checklist(data, sheet.columns, 'output', outputs, roles),
      newOutputs.length ? h('div', { class: 'chips' }, h('span', { class: 'muted small' }, 'New columns the model will fill:'), ...newOutputs.map(c => { const chip = h('button', { class: 'chip active', type: 'button', title: 'Remove' }, `${c} ×`); chip.addEventListener('click', () => removeRole(c)); return chip })) : null,
      h('div', { class: 'row' }, newColumn, addNew),
    ]
    fillBox.replaceChildren(...fillChildren.filter((n): n is HTMLElement => n !== null))
    const kept = sheet.columns.filter(c => roles[c] === 'metadata' || roles[c] === 'reference')
    keptBox.textContent = kept.length ? `The other ${kept.length} column${kept.length === 1 ? '' : 's'} (${kept.slice(0, 6).join(', ')}${kept.length > 6 ? ', …' : ''}) stay in your spreadsheet untouched and are never sent to a model.` : ''

    const partition = currentPartition(data)
    partitionBox.replaceChildren()
    if (outputs.length === 0) {
      partitionBox.append(h('p', { class: 'preview-warn' }, 'Pick a column to fill in, or add a new one, so the answers have somewhere to go.'))
      return
    }
    const parts: (Node | string)[] = [h('strong', {}, `${partition.targets.length.toLocaleString()} row${partition.targets.length === 1 ? '' : 's'} will be filled in`)]
    if (partition.examples.length) parts.push(`. ${partition.examples.length.toLocaleString()} row${partition.examples.length === 1 ? ' is' : 's are'} already filled in and will be shown to the model as examples of what you want.`)
    else parts.push('. No row is filled in yet, so the model works from your instructions alone.')
    if (partition.ambiguous.length) parts.push(h('span', { class: 'preview-warn' }, ` ${partition.ambiguous.length} row${partition.ambiguous.length === 1 ? ' has' : 's have'} some answers filled in and some blank; ${partition.ambiguous.length === 1 ? 'it is' : 'they are'} skipped unless you decide below.`))
    const editor = h('details', { class: 'schema-preview partition-editor' }, h('summary', {}, 'Change which rows are examples, which get filled in, and which are skipped'))
    const editorBody = h('div')
    editor.append(editorBody)
    editor.addEventListener('toggle', () => { if (editor.open) renderPartitionEditor(data, editorBody) })
    partitionBox.append(h('p', {}, ...parts), editor)
  }

  function checklist(data: AppData, columns: string[], role: ColumnRole, chosen: string[], roles: Record<string, ColumnRole>): HTMLElement {
    const { rows } = currentRows(data)
    const list = h('div', { class: 'column-checklist' })
    for (const column of columns) {
      const facts = columnFacts(rows, column)
      const box = h('input', { type: 'checkbox', 'data-role': role, 'data-column': column })
      box.checked = chosen.includes(column)
      box.addEventListener('change', () => {
        if (box.checked) setRole(column, role)
        else setRole(column, 'metadata')
      })
      const filled = facts.blank === 0 ? 'every row filled' : facts.filled === 0 ? 'empty' : `${facts.filled} of ${rows.length} filled`
      const kind = facts.filled === 0 ? '' : facts.numeric ? 'numbers' : facts.distinct <= 8 && facts.avgLength < 40 ? `${facts.distinct} distinct values: ${facts.sample.slice(0, 4).join(', ')}` : facts.avgLength > 120 ? 'long text' : 'text'
      const otherRole = roles[column] !== role && roles[column] !== 'metadata' && roles[column] !== 'reference' ? ` · currently: ${roles[column] === 'input' ? 'read by the model' : 'filled in by the model'}` : ''
      list.append(h('label', { class: 'column-choice' }, box, h('span', { class: 'column-name' }, column), h('span', { class: 'muted small' }, ` ${filled}${kind ? ` · ${kind}` : ''}${otherRole}`)))
    }
    return list
  }

  function setRole(column: string, role: ColumnRole): void {
    actions.setRole(column, role)
  }
  function removeRole(column: string): void {
    actions.removeRole(column)
  }

  function renderPartitionEditor(data: AppData, into: HTMLElement): void {
    const { rows, roles } = currentRows(data)
    const partition = currentPartition(data)
    const role = new Map<number, 'example' | 'target' | 'skip'>()
    partition.examples.forEach(o => role.set(o, 'example'))
    partition.targets.forEach(o => role.set(o, 'target'))
    partition.ambiguous.forEach(o => role.set(o, 'skip'))
    const outputs = columnsWithRole(roles, 'output')
    const inputs = columnsWithRole(roles, 'input').slice(0, 2)
    const PAGE = 100
    let page = 0
    const table = h('table', { class: 'sheet-table partition-table' })
    const pager = h('div', { class: 'row' })
    const draw = (): void => {
      table.replaceChildren(h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'This row…'), ...inputs.map(c => h('th', {}, c)), ...outputs.map(c => h('th', {}, c)))))
      const body = h('tbody')
      for (let o = page * PAGE; o < Math.min(rows.length, (page + 1) * PAGE); o++) {
        const row = rows[o]!
        const select = h('select', { class: 'input row-role' }, h('option', { value: 'example' }, 'is an example for the model'), h('option', { value: 'target' }, 'gets filled in'), h('option', { value: 'skip' }, 'is skipped'))
        select.value = role.get(o) ?? 'target'
        select.addEventListener('change', () => {
          role.set(o, select.value as 'example' | 'target' | 'skip')
          const next = { examples: [] as number[], targets: [] as number[], ambiguous: [] as number[] }
          for (let i = 0; i < rows.length; i++) {
            const r = role.get(i) ?? 'target'
            if (r === 'example') next.examples.push(i)
            else if (r === 'target') next.targets.push(i)
            else next.ambiguous.push(i)
          }
          store.update(d => { d.session.partitionOverride = next })
        })
        body.append(h('tr', {}, h('td', { class: 'sheet-index' }, String(o + 1)), h('td', {}, select),
          ...inputs.map(c => h('td', { title: String(row[c] ?? '') }, String(row[c] ?? '').slice(0, 60))),
          ...outputs.map(c => h('td', {}, String(row[c] ?? '').slice(0, 40)))))
      }
      table.append(body)
      pager.replaceChildren()
      if (rows.length > PAGE) {
        const prev = h('button', { class: 'minibtn', type: 'button' }, '← previous 100')
        const next = h('button', { class: 'minibtn', type: 'button' }, 'next 100 →')
        prev.disabled = page === 0
        next.disabled = (page + 1) * PAGE >= rows.length
        prev.addEventListener('click', () => { page--; draw() })
        next.addEventListener('click', () => { page++; draw() })
        pager.append(prev, h('span', { class: 'muted small' }, `rows ${page * PAGE + 1}–${Math.min(rows.length, (page + 1) * PAGE)} of ${rows.length}`), next)
      }
    }
    draw()
    const reset = h('button', { class: 'minibtn', type: 'button' }, 'Back to the automatic split')
    reset.addEventListener('click', () => store.update(d => { d.session.partitionOverride = null }))
    into.replaceChildren(h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Examples are shown to the model in row order.'), reset), h('div', { class: 'sheet-table-wrap' }, table), pager)
  }

  // --- variations: the prompt and its blanks on one screen -------------------------
  const sweepPrompt = h('textarea', { class: 'input', rows: '6', placeholder: 'e.g. Evaluate this candidate for the {{role}} position. Name: {{name}}. Hometown: {{city}}.', 'data-field': 'sweep-prompt' })
  sweepPrompt.value = store.state.prompt
  let sweepCaret = sweepPrompt.value.length
  sweepPrompt.addEventListener('input', () => { sweepCaret = sweepPrompt.selectionStart ?? sweepPrompt.value.length; store.update(d => { d.state.prompt = sweepPrompt.value }) })
  for (const event of ['click', 'keyup', 'select'] as const) sweepPrompt.addEventListener(event, () => { sweepCaret = sweepPrompt.selectionStart ?? sweepPrompt.value.length })
  const sweepVars = h('div', { class: 'sweep-list' })
  const sweepFacts = h('p', { class: 'muted small' })
  const sweepPreview = h('div', { class: 'preview-prompt' })
  const addBlank = h('button', { class: 'btn', type: 'button' }, '+ Add a blank at the cursor')
  addBlank.addEventListener('click', () => {
    const used = new Set(sweepPlaceholders(store.state))
    let n = 1
    while (used.has(`blank${n}`)) n++
    const marker = `{{blank${n}}}`
    const start = Math.max(0, Math.min(sweepCaret, sweepPrompt.value.length))
    sweepPrompt.value = `${sweepPrompt.value.slice(0, start)}${marker}${sweepPrompt.value.slice(start)}`
    sweepCaret = start + marker.length
    sweepPrompt.focus()
    sweepPrompt.setSelectionRange(start + 2, start + 2 + `blank${n}`.length)
    store.update(d => { d.state.prompt = sweepPrompt.value })
  })
  sweepBox.append(
    h('p', { class: 'muted small' }, 'Write the prompt once. Wherever a value should vary, put a blank like {{name}}; each blank gets a list of values below, and every combination is asked of every model.'),
    h('label', { class: 'field' }, h('span', {}, 'The prompt, with blanks'), sweepPrompt),
    h('div', { class: 'row' }, addBlank, sweepFacts),
    sweepVars,
    sweepPreview,
  )

  let sweepKey = ''
  function renderSweep(data: AppData): void {
    if (data.state.flow !== 'sweep') return
    if (sweepPrompt.value !== data.state.prompt && document.activeElement !== sweepPrompt) sweepPrompt.value = data.state.prompt
    const names = sweepPlaceholders(data.state)
    const stored = new Map(data.state.sweep.map(v => [v.name.trim(), v.values]))
    const variables = sweepVariables(data.state)
    const count = sweepCaseCount(variables)
    const key = JSON.stringify([names, data.state.sweep])
    if (key !== sweepKey) {
      sweepKey = key
      sweepVars.replaceChildren(...names.map((name, i) => {
        const values = h('textarea', { class: 'input', rows: '4', placeholder: 'one value per line' })
        values.value = stored.get(name) ?? ''
        values.addEventListener('change', () => store.update(d => {
          const entry = d.state.sweep.find(v => v.name.trim() === name)
          if (entry) entry.values = values.value
          else d.state.sweep.push({ name, values: values.value })
        }))
        const n = parseSweepValues(values.value).length
        return h('div', { class: `sweep-var colour-${i % 5}`, 'data-name': name },
          h('div', { class: 'row' }, h('span', { class: 'sweep-name' }, `{{${name}}}`), h('span', { class: 'muted small' }, n ? `${n} value${n === 1 ? '' : 's'}` : 'needs values')),
          values)
      }))
      const orphans = data.state.sweep.filter(v => v.name.trim() && !names.includes(v.name.trim()))
      if (orphans.length) {
        sweepVars.append(h('p', { class: 'muted small' }, `Values kept for blanks no longer in the prompt: ${orphans.map(v => `{{${v.name.trim()}}}`).join(', ')}. Put the blank back to use them.`))
      }
    }
    sweepFacts.textContent = names.length === 0 ? '' : count > SWEEP_MAX
      ? `${count.toLocaleString()} combinations: above the ${SWEEP_MAX.toLocaleString()} limit`
      : count > SWEEP_WARN
        ? `${count.toLocaleString()} combinations: each is one call per model per repeat`
        : count ? `${count.toLocaleString()} combination${count === 1 ? '' : 's'} (${variables.map(v => `${v.values.length} ${v.name}`).join(' × ')})` : ''
    sweepFacts.classList.toggle('preview-warn', count > SWEEP_WARN)
    const { rows } = currentRows(data)
    sweepPreview.replaceChildren()
    if (rows.length) {
      sweepPreview.append(h('p', { class: 'preview-user' }, h('span', { class: 'preview-label' }, `First of ${count.toLocaleString()}: `), document.createTextNode(renderPromptTemplate(data.state.prompt, rows[0]!))))
      if (rows.length > 1) sweepPreview.append(h('p', { class: 'preview-user' }, h('span', { class: 'preview-label' }, 'Last: '), document.createTextNode(renderPromptTemplate(data.state.prompt, rows[rows.length - 1]!))))
    }
  }

  function refresh(data: AppData): void {
    renderFlowTabs(data)
    renderSheet(data)
    renderSweep(data)
    const list = dataProblems(data)
    problems.hidden = list.length === 0 || (data.state.flow === 'sheet' && !data.session.sheet)
    problems.textContent = list.join(' · ')
  }

  return { el, refresh }
}
