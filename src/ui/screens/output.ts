// Screen 3: answer format. In plain words: what should each answer contain?
// For a spreadsheet the fields are pre-filled from the columns the model fills
// in (type guessed from the values already there). For a single question the
// default is the plain answer text. Everything technical lives under "more
// options"; saved templates are here too.

import { TYPE_LABEL, buildContractContext, renderContractProse, resolveContract } from '../../core/contract'
import { BUILTIN_PARSERS } from '../../core/parsers'
import type { ContractField, ContractFieldType } from '../../core/types'
import { loadTemplates, saveTemplates } from '../../state'
import type { SavedTemplate } from '../../state'
import { h } from '../dom'
import { applyGuesses, currentRows } from '../model'
import type { AppData, Store } from '../store'
import type { Screen } from './screen'

const TYPES: ContractFieldType[] = ['enum', 'string', 'integer', 'number', 'boolean', 'multi-enum']
const TYPE_HELP: Record<ContractFieldType, string> = {
  enum: 'the model picks exactly one of the choices you list',
  string: 'free text, as long as the model likes',
  integer: 'a whole number, optionally within a range',
  number: 'a number, optionally within a range',
  boolean: 'yes or no (true / false)',
  'multi-enum': 'any number of the choices you list',
}

export function buildOutputScreen(store: Store, onTemplateLoaded: () => void): Screen {
  const heading = h('p', {})
  const modeBox = h('div', { class: 'chips' })
  const fieldsBox = h('div', { class: 'field-table' })
  const errors = h('div', { class: 'contract-errors' })
  const whatModelSees = h('details', { class: 'schema-preview' }, h('summary', {}, 'What the model is told about the format'), h('pre', {}))
  const rationaleFirst = h('input', { type: 'checkbox' })
  const rationaleSpec = h('input', { class: 'input', placeholder: 'What the reasoning should cover (optional)' })
  const strictJson = h('input', { type: 'checkbox' })
  const parser = h('select', { class: 'input' },
    h('option', { value: '' }, 'Keep the full response text (no parsing)'),
    ...BUILTIN_PARSERS.map(p => h('option', { value: p.id }, p.name)))
  const autoNote = h('p', { class: 'muted small' })
  const backToAuto = h('button', { class: 'minibtn', type: 'button' }, 'Back to the columns\' own format')
  const templateName = h('input', { class: 'input', placeholder: 'Name this setup' })
  const saveTemplate = h('button', { class: 'btn', type: 'button' }, 'Save setup')
  const templateSelect = h('select', { class: 'input', style: 'flex:1' })
  const deleteTemplate = h('button', { class: 'btn ghost', type: 'button' }, 'Delete')
  let templates = loadTemplates()

  const more = h('details', { class: 'schema-preview more-options' }, h('summary', {}, 'More options'),
    h('label', { class: 'checkbox-row' }, rationaleFirst, ' Ask the model to explain its reasoning first (adds a "rationale" field before the others)'),
    h('label', { class: 'param-field' }, h('span', {}, 'The reasoning should cover'), rationaleSpec),
    h('label', { class: 'checkbox-row' }, strictJson, ' Insist on bare JSON with no commentary around it'),
    h('label', { class: 'param-field' }, h('span', {}, 'How each response is read into columns'), parser),
    h('p', { class: 'muted small' }, 'With fields above, "JSON Object (Unstack to Columns)" turns each field into a column. The others pull one value out of plain text (a number, a yes/no, the first line…).'),
    h('div', { class: 'row template-row' }, templateName, saveTemplate, templateSelect, deleteTemplate),
  )

  const el = h('section', { class: 'card stage-card' },
    h('div', { class: 'stage-heading' }, h('h2', {}, 'Answer format'), heading),
    modeBox,
    autoNote,
    fieldsBox,
    errors,
    whatModelSees,
    more,
  )

  rationaleFirst.addEventListener('change', () => store.update(d => { d.state.contract.rationaleFirst = rationaleFirst.checked }))
  rationaleSpec.addEventListener('change', () => store.update(d => { d.state.contract.rationaleSpec = rationaleSpec.value }))
  strictJson.addEventListener('change', () => store.update(d => { d.state.contract.strictJson = strictJson.checked }))
  parser.addEventListener('change', () => store.update(d => { d.state.parserId = parser.value || null; d.state.contractAuto = false }))
  backToAuto.addEventListener('click', () => store.update(d => { d.state.contractAuto = true; applyGuesses(d) }))

  saveTemplate.addEventListener('click', () => {
    const name = templateName.value.trim()
    if (!name) { templateName.focus(); return }
    const { state } = store
    templates = [...templates.filter(t => t.name !== name), {
      id: `${Date.now()}`, name, template: state.prompt, system: state.system,
      contract: JSON.parse(JSON.stringify(state.contract)) as SavedTemplate['contract'], parserId: state.parserId, updated: new Date().toISOString(),
    }]
    saveTemplates(templates)
    templateName.value = ''
    renderTemplates()
  })
  templateSelect.addEventListener('change', () => {
    const t = templates.find(t => t.id === templateSelect.value)
    if (!t) return
    store.update(d => {
      d.state.prompt = t.template
      d.state.system = t.system
      d.state.contract = JSON.parse(JSON.stringify(t.contract)) as SavedTemplate['contract']
      d.state.parserId = t.parserId
      d.state.promptAuto = false
      d.state.contractAuto = false
    })
    onTemplateLoaded()
    templateSelect.value = ''
  })
  deleteTemplate.addEventListener('click', () => {
    templates = templates.filter(t => t.id !== templateSelect.value)
    saveTemplates(templates)
    renderTemplates()
  })

  function renderTemplates(): void {
    templateSelect.replaceChildren(
      h('option', { value: '' }, templates.length ? 'Load a saved setup…' : 'No saved setups yet'),
      ...templates.map(t => h('option', { value: t.id }, t.name)))
  }

  /** Switching between "plain text" and "fields" is the one choice a newcomer makes here. */
  function renderMode(data: AppData): void {
    const hasFields = (data.state.contract.fields ?? []).length > 0
    const plain = h('button', { class: `chip ${hasFields ? '' : 'active'}`, type: 'button' }, 'Just the answer, as text')
    const fields = h('button', { class: `chip ${hasFields ? 'active' : ''}`, type: 'button' }, 'Specific fields')
    plain.addEventListener('click', () => store.update(d => { d.state.contract.fields = []; d.state.parserId = null; d.state.contractAuto = false }))
    fields.addEventListener('click', () => store.update(d => {
      if ((d.state.contract.fields ?? []).length === 0) d.state.contract.fields = [{ name: 'answer', type: 'string' }]
      d.state.parserId = 'json-unstack'
      d.state.contractAuto = false
    }))
    modeBox.replaceChildren(plain, fields)
  }

  function renderFields(data: AppData): void {
    fieldsBox.replaceChildren()
    const fields = data.state.contract.fields ?? []
    if (fields.length === 0) {
      fieldsBox.append(h('p', { class: 'muted' }, 'The model answers in its own words and the whole text is kept.' + (data.state.flow === 'sheet' ? ' For a spreadsheet you usually want specific fields so each one becomes a column.' : '')))
      return
    }
    fieldsBox.append(h('div', { class: 'field-table-head' }, h('span', {}, 'Field'), h('span', {}, 'Kind of answer'), h('span', {}, 'Details')))
    fields.forEach((field, index) => {
      const name = h('input', { class: 'input', placeholder: 'e.g. sentiment' })
      name.value = field.name
      const type = h('select', { class: 'input' }, ...TYPES.map(t => h('option', { value: t }, TYPE_LABEL[t])))
      type.value = field.type
      const remove = h('button', { class: 'minibtn danger', type: 'button', title: 'Remove this field' }, '×')
      remove.addEventListener('click', () => store.update(d => { d.state.contract.fields = fields.filter((_, i) => i !== index); d.state.contractAuto = false }))
      name.addEventListener('change', () => store.update(d => { d.state.contract.fields![index]!.name = name.value.trim(); d.state.contractAuto = false }))
      type.addEventListener('change', () => store.update(d => {
        const f = d.state.contract.fields![index]!
        f.type = type.value as ContractFieldType
        if (f.type !== 'enum' && f.type !== 'multi-enum') { delete f.values; delete f.valueNotes }
        if (f.type !== 'number' && f.type !== 'integer') { delete f.min; delete f.max }
        d.state.contractAuto = false
      }))
      const detail = h('div', { class: 'field-detail' }, h('p', { class: 'muted small type-help' }, TYPE_HELP[field.type]))
      if (field.type === 'number' || field.type === 'integer') {
        const min = h('input', { class: 'input', type: 'number', placeholder: 'lowest' })
        min.value = field.min === undefined ? '' : String(field.min)
        const max = h('input', { class: 'input', type: 'number', placeholder: 'highest' })
        max.value = field.max === undefined ? '' : String(field.max)
        const apply = () => store.update(d => {
          const f = d.state.contract.fields![index]!
          f.min = min.value === '' ? undefined : Number(min.value)
          f.max = max.value === '' ? undefined : Number(max.value)
          d.state.contractAuto = false
        })
        min.addEventListener('change', apply)
        max.addEventListener('change', apply)
        detail.append(h('div', { class: 'row' }, h('label', { class: 'param-field' }, h('span', {}, 'From'), min), h('label', { class: 'param-field' }, h('span', {}, 'to'), max)))
      } else if (field.type === 'enum' || field.type === 'multi-enum') {
        detail.append(choiceEditor(field, index))
      }
      const description = h('input', { class: 'input', placeholder: 'Explain this field to the model (optional)' })
      description.value = field.description ?? ''
      description.addEventListener('change', () => store.update(d => { d.state.contract.fields![index]!.description = description.value || undefined; d.state.contractAuto = false }))
      fieldsBox.append(h('div', { class: 'field-entry' },
        h('label', { class: 'param-field' }, h('span', {}, 'Field'), name),
        h('label', { class: 'param-field' }, h('span', {}, 'Kind of answer'), type),
        remove,
        detail,
        h('label', { class: 'param-field' }, h('span', {}, 'Meaning'), description),
      ))
    })
    const add = h('button', { class: 'btn', type: 'button' }, '+ Add a field')
    add.addEventListener('click', () => store.update(d => { d.state.contract.fields = [...(d.state.contract.fields ?? []), { name: '', type: 'enum', values: [] }]; d.state.contractAuto = false }))
    fieldsBox.append(add)
  }

  /** Choices and what each means, as one list that always ends in a blank row. */
  function choiceEditor(field: ContractField, index: number): HTMLElement {
    const values = [...(field.values ?? []), '']
    const list = h('div', { class: 'choice-editor' })
    values.forEach((choice, ci) => {
      const value = h('input', { class: 'input', placeholder: ci === values.length - 1 ? 'add a choice…' : 'choice' })
      value.value = choice
      const note = h('input', { class: 'input', placeholder: 'when to pick it (optional)' })
      note.value = field.valueNotes?.[choice] ?? ''
      const commit = () => store.update(d => {
        const f = d.state.contract.fields![index]!
        const current = [...(f.values ?? [])]
        const next = value.value.trim()
        const notes = { ...(f.valueNotes ?? {}) }
        delete notes[choice]
        if (ci < current.length) {
          if (next) current[ci] = next
          else current.splice(ci, 1)
        } else if (next) current.push(next)
        if (next && note.value.trim()) notes[next] = note.value.trim()
        f.values = current
        f.valueNotes = Object.keys(notes).length ? notes : undefined
        d.state.contractAuto = false
      })
      value.addEventListener('change', commit)
      note.addEventListener('change', commit)
      list.append(h('div', { class: 'choice-row' }, value, note))
    })
    return h('div', { class: 'choice-detail' }, h('strong', {}, 'Choices'), list)
  }

  function refresh(data: AppData): void {
    const { state } = data
    const isSheet = state.flow === 'sheet'
    heading.textContent = isSheet
      ? 'What should the model put in each column it fills in? This is pre-filled from the values already in those columns.'
      : 'Should the answer be plain text, or specific fields you can sort and count?'
    renderMode(data)
    renderFields(data)
    const outputs = isSheet ? Object.entries(currentRows(data).roles).filter(([, r]) => r === 'output').map(([c]) => c) : []
    if (isSheet && outputs.length && state.contractAuto) {
      autoNote.replaceChildren(document.createTextNode(`Following the column${outputs.length === 1 ? '' : 's'} ${outputs.join(', ')}: one field each, kind guessed from what is already filled in. Change anything and the columns stop driving it.`))
    } else if (isSheet && outputs.length) {
      autoNote.replaceChildren(document.createTextNode('You have taken over the fields. '), backToAuto)
    } else autoNote.replaceChildren()
    const { errors: list } = resolveContract(state.contract)
    errors.replaceChildren(...list.map(e => h('p', { class: 'contract-error' }, e.message)))
    const ctx = buildContractContext(state.contract)
    const prose = renderContractProse(state.contract)
    whatModelSees.hidden = !prose
    whatModelSees.querySelector('pre')!.textContent = prose ? `${prose}\n\n(Where the model supports it, this JSON schema is also enforced:)\n${JSON.stringify(ctx?.schema ?? null, null, 2)}` : ''
  }

  renderTemplates()
  return {
    el,
    refresh,
    restore(data) {
      rationaleFirst.checked = data.state.contract.rationaleFirst ?? false
      rationaleSpec.value = data.state.contract.rationaleSpec ?? ''
      strictJson.checked = data.state.contract.strictJson !== false
      parser.value = data.state.parserId ?? ''
    },
  }
}
