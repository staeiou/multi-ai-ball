// Screen 1: prompt and data. The three flows are three ways to say where the
// rows come from; the templates are the same. For a spreadsheet the user
// declares column roles, sees the partition the sheet's own sparsity implies,
// and can move rows between examples and targets before anything runs.

import { sweepCaseCount } from '../../core/cases'
import { isBlank } from '../../core/partition'
import { renderPromptTemplate } from '../../core/template'
import type { ColumnRole } from '../../core/types'
import type { Flow } from '../../state'
import { h } from '../dom'
import { SWEEP_MAX, SWEEP_WARN, caseCount, currentPartition, currentRows, previewConstantBlock, promptProblems, sweepVariables } from '../model'
import type { AppData, Store } from '../store'
import type { Actions } from '../actions'
import type { Screen } from './screen'

const ROLE_LABEL: Record<ColumnRole, string> = {
  input: 'Input (sent when the prompt uses it)',
  output: 'Output (the model fills it; filled rows become examples)',
  reference: 'Reference (kept, never sent)',
  metadata: 'Metadata (kept, not sent)',
}

export function buildPromptScreen(store: Store, actions: Actions): Screen {
  const flowTabs = h('div', { class: 'chips flow-tabs' })
  const system = h('textarea', { class: 'input', rows: '3', placeholder: 'System prompt (optional). Placeholders like {{column}} work here too.', 'data-field': 'system' })
  system.value = store.state.system
  const prompt = h('textarea', { class: 'input', rows: '7', placeholder: 'The prompt every model receives. For a sheet or a sweep, use {{column}} where a value goes.', 'data-field': 'prompt' })
  prompt.value = store.state.prompt
  let promptCaret = prompt.value.length

  // --- sweep editor
  const sweepBox = h('div', { class: 'sweep-box' })
  // --- sheet
  const sheetInput = h('input', { type: 'file', accept: '.csv,.tsv,.xlsx,.xls,.json,.jsonl,.ndjson' })
  sheetInput.hidden = true
  const uploadBtn = h('button', { class: 'btn', type: 'button' }, 'Upload spreadsheet…')
  const sheetFacts = h('span', { class: 'muted small' })
  const rolesBox = h('div', { class: 'roles-box' })
  const partitionBox = h('div', { class: 'partition-box' })
  const previewBox = h('div', { class: 'sheet-preview' })
  const problems = h('p', { class: 'wizard-blocker inline-blocker' })
  const constantPreview = h('details', { class: 'schema-preview' }, h('summary', {}, 'What every call will carry in its system prompt (examples + output format)'), h('pre', { class: 'constant-block' }))

  const sheetSection = h('div', { class: 'sheet-section' },
    h('div', { class: 'row' }, uploadBtn, sheetInput, sheetFacts),
    rolesBox,
    partitionBox,
  )

  const el = h('section', { class: 'card stage-card' },
    h('div', { class: 'stage-heading' }, h('h2', {}, 'Prompt & data'), h('p', {}, 'One prompt, a sweep of variables, or a spreadsheet where each row is a case.')),
    flowTabs,
    sheetSection,
    sweepBox,
    h('label', { class: 'field' }, h('span', {}, 'System prompt (optional)'), system),
    h('label', { class: 'field' }, h('span', {}, 'Prompt'), prompt),
    problems,
    previewBox,
    constantPreview,
  )

  // --- listeners
  prompt.addEventListener('input', () => {
    promptCaret = prompt.selectionStart ?? prompt.value.length
    store.update(d => { d.state.prompt = prompt.value })
  })
  for (const event of ['click', 'keyup', 'select'] as const) prompt.addEventListener(event, () => { promptCaret = prompt.selectionStart ?? prompt.value.length })
  system.addEventListener('input', () => store.update(d => { d.state.system = system.value }))
  uploadBtn.addEventListener('click', () => sheetInput.click())
  sheetInput.addEventListener('change', () => {
    const file = sheetInput.files?.[0]
    if (file) void actions.loadSheet(file)
    sheetInput.value = ''
  })

  function insertPlaceholder(name: string): void {
    const marker = `{{${name}}}`
    const start = Math.max(0, Math.min(promptCaret, prompt.value.length))
    prompt.value = `${prompt.value.slice(0, start)}${marker}${prompt.value.slice(start)}`
    promptCaret = start + marker.length
    prompt.focus()
    prompt.setSelectionRange(promptCaret, promptCaret)
    store.update(d => { d.state.prompt = prompt.value })
  }

  function renderFlowTabs(data: AppData): void {
    const flows: Array<[Flow, string]> = [['single', 'Single prompt'], ['sweep', 'Variable sweep'], ['sheet', 'Spreadsheet']]
    flowTabs.replaceChildren(...flows.map(([flow, label]) => {
      const chip = h('button', { class: `chip ${data.state.flow === flow ? 'active' : ''}`, type: 'button', 'data-flow': flow }, label)
      chip.addEventListener('click', () => store.update(d => { d.state.flow = flow }))
      return chip
    }))
    sheetSection.hidden = data.state.flow !== 'sheet'
    sweepBox.hidden = data.state.flow !== 'sweep'
  }

  function renderSweep(data: AppData): void {
    if (data.state.flow !== 'sweep') return
    const variables = data.state.sweep
    const count = sweepCaseCount(sweepVariables(data.state))
    const list = h('div', { class: 'sweep-list' })
    variables.forEach((variable, index) => {
      const name = h('input', { class: 'input', placeholder: 'variable name, e.g. name' })
      name.value = variable.name
      const values = h('textarea', { class: 'input', rows: '4', placeholder: 'one value per line' })
      values.value = variable.values
      const remove = h('button', { class: 'minibtn danger', type: 'button' }, '×')
      name.addEventListener('change', () => store.update(d => { d.state.sweep[index]!.name = name.value }))
      values.addEventListener('change', () => store.update(d => { d.state.sweep[index]!.values = values.value }))
      remove.addEventListener('click', () => store.update(d => { d.state.sweep.splice(index, 1) }))
      const insert = h('button', { class: 'chip', type: 'button', title: 'Insert into the prompt at the cursor' }, `{{${variable.name.trim() || '…'}}}`)
      insert.addEventListener('click', () => variable.name.trim() && insertPlaceholder(variable.name.trim()))
      list.append(h('div', { class: 'sweep-var' }, h('div', { class: 'row' }, name, insert, remove), values))
    })
    const add = h('button', { class: 'btn', type: 'button' }, '+ Add variable')
    add.addEventListener('click', () => store.update(d => { d.state.sweep.push({ name: '', values: '' }) }))
    const facts = count > SWEEP_MAX
      ? h('span', { class: 'preview-warn' }, `${count.toLocaleString()} combinations: above the ${SWEEP_MAX.toLocaleString()} limit`)
      : count > SWEEP_WARN
        ? h('span', { class: 'preview-warn' }, `${count.toLocaleString()} combinations: each becomes one case per model per repeat`)
        : h('span', { class: 'muted small' }, count ? `${count.toLocaleString()} combination${count === 1 ? '' : 's'}` : 'Every combination of the variables becomes a case')
    sweepBox.replaceChildren(h('p', { class: 'muted small' }, 'Hold everything else constant and vary these. Use {{name}} in the prompt.'), list, h('div', { class: 'row' }, add, facts))
  }

  function renderSheet(data: AppData): void {
    if (data.state.flow !== 'sheet') return
    const { sheet, sheetError, loadingSheet } = data.session
    sheetFacts.textContent = loadingSheet ? 'Reading…' : sheetError ?? (sheet ? `${sheet.name}: ${sheet.rows.length.toLocaleString()} rows · ${sheet.columns.length} columns` : 'CSV, TSV, XLSX, JSON or JSONL. First row = column names.')
    rolesBox.replaceChildren()
    partitionBox.replaceChildren()
    if (!sheet) return
    const { roles } = currentRows(data)
    const table = h('table', { class: 'roles-table' })
    table.append(h('thead', {}, h('tr', {}, h('th', {}, 'Column'), h('th', {}, 'Role'), h('th', {}, 'First value'), h('th', {}, ''))))
    const body = h('tbody')
    for (const column of sheet.columns) {
      const select = h('select', { class: 'input role-select', 'data-column': column },
        ...(Object.keys(ROLE_LABEL) as ColumnRole[]).map(role => h('option', { value: role }, ROLE_LABEL[role])))
      select.value = roles[column] ?? 'input'
      select.addEventListener('change', () => store.update(d => { d.state.roles[column] = select.value as ColumnRole; d.session.partitionOverride = null }))
      const insert = h('button', { class: 'chip', type: 'button', title: 'Insert into the prompt at the cursor' }, `{{${column}}}`)
      insert.disabled = (roles[column] ?? 'input') !== 'input'
      insert.addEventListener('click', () => insertPlaceholder(column))
      const first = sheet.rows.find(r => !isBlank(r[column]))?.[column]
      body.append(h('tr', {}, h('td', { class: 'mono' }, column), h('td', {}, select), h('td', { class: 'muted small cell-sample' }, first === undefined ? '' : String(first).slice(0, 80)), h('td', {}, insert)))
    }
    table.append(body)
    rolesBox.append(h('p', { class: 'muted small' }, 'Say what each column is. Inputs can go in the prompt; outputs are what the model produces (rows where they are already filled become worked examples); references are kept in the results but never sent.'), h('div', { class: 'sheet-table-wrap' }, table))

    const partition = currentPartition(data)
    const outputs = Object.entries(roles).filter(([, r]) => r === 'output').map(([c]) => c)
    const summary = h('p', {},
      h('strong', {}, `${partition.targets.length.toLocaleString()} rows to run`),
      outputs.length ? ` · ${partition.examples.length.toLocaleString()} rows already filled become worked examples` : ' · no output columns declared, so every row runs and the model\'s fields are added as new columns',
      partition.ambiguous.length ? h('span', { class: 'preview-warn' }, ` · ${partition.ambiguous.length} rows have some outputs filled and some blank; they are skipped until you decide`) : null,
    )
    const editor = h('details', { class: 'schema-preview partition-editor' }, h('summary', {}, 'Choose which rows are examples, which run, which are skipped'))
    const editorBody = h('div')
    editor.append(editorBody)
    editor.addEventListener('toggle', () => { if (editor.open) renderPartitionEditor(data, editorBody) })
    partitionBox.append(summary, editor)
  }

  function renderPartitionEditor(data: AppData, into: HTMLElement): void {
    const { rows, roles } = currentRows(data)
    const partition = currentPartition(data)
    const role = new Map<number, 'example' | 'target' | 'skip'>()
    partition.examples.forEach(o => role.set(o, 'example'))
    partition.targets.forEach(o => role.set(o, 'target'))
    partition.ambiguous.forEach(o => role.set(o, 'skip'))
    const outputs = Object.entries(roles).filter(([, r]) => r === 'output').map(([c]) => c)
    const inputs = Object.entries(roles).filter(([, r]) => r === 'input').map(([c]) => c).slice(0, 2)
    const PAGE = 100
    let page = 0
    const table = h('table', { class: 'sheet-table partition-table' })
    const pager = h('div', { class: 'row' })
    const draw = (): void => {
      table.replaceChildren(h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Use as'), ...inputs.map(c => h('th', {}, c)), ...outputs.map(c => h('th', {}, c)))))
      const body = h('tbody')
      for (let o = page * PAGE; o < Math.min(rows.length, (page + 1) * PAGE); o++) {
        const row = rows[o]!
        const select = h('select', { class: 'input row-role' }, h('option', { value: 'example' }, 'worked example'), h('option', { value: 'target' }, 'run'), h('option', { value: 'skip' }, 'skip'))
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
    const reset = h('button', { class: 'minibtn', type: 'button' }, 'Back to the sheet\'s own split')
    reset.addEventListener('click', () => store.update(d => { d.session.partitionOverride = null }))
    into.replaceChildren(h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Order of examples in the prompt follows row order.'), reset), h('div', { class: 'sheet-table-wrap' }, table), pager)
  }

  let previewIndex = 0
  function renderPreview(data: AppData): void {
    previewBox.replaceChildren()
    const { rows, label } = currentRows(data)
    const partition = currentPartition(data)
    if (data.state.flow === 'single' || partition.targets.length === 0) return
    previewIndex = Math.min(previewIndex, partition.targets.length - 1)
    const select = h('select', { class: 'input' }, ...partition.targets.slice(0, 500).map((o, i) => h('option', { value: String(i) }, label(o))))
    select.value = String(previewIndex)
    select.addEventListener('change', () => { previewIndex = Number(select.value); renderPreview(data) })
    const ordinal = partition.targets[previewIndex]!
    const bindings = rows[ordinal] ?? {}
    const user = renderPromptTemplate(data.state.prompt, bindings)
    const sys = renderPromptTemplate(data.state.system, bindings)
    previewBox.append(
      h('div', { class: 'preview-row' }, h('label', { class: 'param-field' }, h('span', {}, `Preview one of the ${caseCount(data).toLocaleString()} cases`), select)),
      h('div', { class: 'preview-prompt' },
        sys ? h('p', { class: 'preview-system' }, 'System: ', document.createTextNode(sys)) : null,
        h('p', { class: 'preview-user' }, h('span', { class: 'preview-label' }, 'Prompt → '), document.createTextNode(user)),
      ),
    )
  }

  function refresh(data: AppData): void {
    renderFlowTabs(data)
    renderSweep(data)
    renderSheet(data)
    renderPreview(data)
    const list = promptProblems(data)
    problems.hidden = list.length === 0
    problems.textContent = list.join(' · ')
    const block = previewConstantBlock(data)
    constantPreview.hidden = block.length === 0
    constantPreview.querySelector('pre')!.textContent = block
  }

  return {
    el,
    refresh,
    restore(data) {
      prompt.value = data.state.prompt
      system.value = data.state.system
    },
  }
}
