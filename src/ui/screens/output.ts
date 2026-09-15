// Screen 2: output format. Each field becomes a column in the results and a
// property in the JSON schema sent where the model takes one. Types are named
// the way a spreadsheet user thinks of them. Also the parser and saved
// templates (prompt + system + fields + parser).

import { TYPE_LABEL, buildContractContext, renderContractProse, resolveContract } from '../../core/contract'
import { BUILTIN_PARSERS } from '../../core/parsers'
import type { ContractField, ContractFieldType } from '../../core/types'
import { loadTemplates, saveTemplates } from '../../state'
import type { SavedTemplate } from '../../state'
import { h } from '../dom'
import type { AppData, Store } from '../store'
import type { Screen } from './screen'

const TYPES: ContractFieldType[] = ['string', 'number', 'integer', 'boolean', 'enum', 'multi-enum']

export function buildOutputScreen(store: Store, onTemplateLoaded: () => void): Screen {
  const fieldsBox = h('div', { class: 'field-table' })
  const errors = h('div', { class: 'contract-errors' })
  const rationaleFirst = h('input', { type: 'checkbox' })
  const rationaleSpec = h('input', { class: 'input', placeholder: 'What the rationale should cover (optional)' })
  const strictJson = h('input', { type: 'checkbox' })
  const parser = h('select', { class: 'input' },
    h('option', { value: '' }, 'Keep the full response text (no parsing)'),
    ...BUILTIN_PARSERS.map(p => h('option', { value: p.id }, p.name)))
  const schemaPreview = h('details', { class: 'schema-preview' }, h('summary', {}, 'What the model is told (and the JSON schema sent where supported)'), h('pre', {}))
  const templateName = h('input', { class: 'input', placeholder: 'Template name' })
  const saveTemplate = h('button', { class: 'btn', type: 'button' }, 'Save as template')
  const templateSelect = h('select', { class: 'input', style: 'flex:1' })
  const deleteTemplate = h('button', { class: 'btn ghost', type: 'button' }, 'Delete')
  let templates = loadTemplates()

  const el = h('section', { class: 'card stage-card' },
    h('div', { class: 'stage-heading' }, h('h2', {}, 'Output format'), h('p', {}, 'Describe the fields you want back. Each becomes a column. Leave it empty to keep the plain response.')),
    h('div', { class: 'field-table-head' }, h('span', {}, 'Field'), h('span', {}, 'Type'), h('span', {}, 'Details')),
    fieldsBox,
    h('div', { class: 'contract-options' },
      h('label', { class: 'checkbox-row' }, rationaleFirst, ' Ask for a short rationale first (a "rationale" field before the others)'),
      h('label', { class: 'param-field' }, h('span', {}, 'Rationale should cover'), rationaleSpec),
      h('label', { class: 'checkbox-row' }, strictJson, ' Demand bare JSON (no code fences, no commentary)'),
    ),
    errors,
    schemaPreview,
    h('label', { class: 'param-field' }, h('span', {}, 'How to read each response'), parser),
    h('p', { class: 'muted small' }, 'With fields above, "JSON Object (Unstack to Columns)" turns each field into a column. The other readers pull one value out of plain text.'),
    h('div', { class: 'row template-row' }, templateName, saveTemplate, templateSelect, deleteTemplate),
  )

  rationaleFirst.addEventListener('change', () => store.update(d => { d.state.contract.rationaleFirst = rationaleFirst.checked }))
  rationaleSpec.addEventListener('change', () => store.update(d => { d.state.contract.rationaleSpec = rationaleSpec.value }))
  strictJson.addEventListener('change', () => store.update(d => { d.state.contract.strictJson = strictJson.checked }))
  parser.addEventListener('change', () => store.update(d => { d.state.parserId = parser.value || null }))

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
      h('option', { value: '' }, templates.length ? 'Load a saved template…' : 'No saved templates'),
      ...templates.map(t => h('option', { value: t.id }, t.name)))
  }

  function renderFields(data: AppData): void {
    fieldsBox.replaceChildren()
    const fields = data.state.contract.fields ?? []
    fields.forEach((field, index) => {
      const name = h('input', { class: 'input', placeholder: 'field name, e.g. sentiment' })
      name.value = field.name
      const type = h('select', { class: 'input' }, ...TYPES.map(t => h('option', { value: t }, TYPE_LABEL[t])))
      type.value = field.type
      const remove = h('button', { class: 'minibtn danger', type: 'button', title: 'Remove field' }, '×')
      remove.addEventListener('click', () => store.update(d => { d.state.contract.fields = fields.filter((_, i) => i !== index) }))
      name.addEventListener('change', () => store.update(d => { d.state.contract.fields![index]!.name = name.value.trim() }))
      type.addEventListener('change', () => store.update(d => {
        const f = d.state.contract.fields![index]!
        f.type = type.value as ContractFieldType
        if (f.type !== 'enum' && f.type !== 'multi-enum') { delete f.values; delete f.valueNotes }
        if (f.type !== 'number' && f.type !== 'integer') { delete f.min; delete f.max }
      }))
      const detail = h('div', { class: 'field-detail' })
      if (field.type === 'number' || field.type === 'integer') {
        const min = h('input', { class: 'input', type: 'number', placeholder: 'min' })
        min.value = field.min === undefined ? '' : String(field.min)
        const max = h('input', { class: 'input', type: 'number', placeholder: 'max' })
        max.value = field.max === undefined ? '' : String(field.max)
        const apply = () => store.update(d => {
          const f = d.state.contract.fields![index]!
          f.min = min.value === '' ? undefined : Number(min.value)
          f.max = max.value === '' ? undefined : Number(max.value)
        })
        min.addEventListener('change', apply)
        max.addEventListener('change', apply)
        detail.append(h('label', { class: 'param-field' }, h('span', {}, 'Min'), min), h('label', { class: 'param-field' }, h('span', {}, 'Max'), max))
      } else if (field.type === 'enum' || field.type === 'multi-enum') {
        detail.append(choiceEditor(field, index))
      }
      const description = h('input', { class: 'input', placeholder: 'What this field means (shown to the model)' })
      description.value = field.description ?? ''
      description.addEventListener('change', () => store.update(d => { d.state.contract.fields![index]!.description = description.value || undefined }))
      fieldsBox.append(h('div', { class: 'field-entry' },
        h('label', { class: 'param-field' }, h('span', {}, 'Field'), name),
        h('label', { class: 'param-field' }, h('span', {}, 'Type'), type),
        remove,
        detail,
        h('label', { class: 'param-field' }, h('span', {}, 'Description'), description),
      ))
    })
    const add = h('button', { class: 'btn', type: 'button' }, '+ Add field')
    add.addEventListener('click', () => store.update(d => { d.state.contract.fields = [...(d.state.contract.fields ?? []), { name: '', type: 'enum', values: [] }] }))
    fieldsBox.append(add)
  }

  /** Choices and their glosses as one list that always ends in a blank row. */
  function choiceEditor(field: ContractField, index: number): HTMLElement {
    const values = [...(field.values ?? []), '']
    const list = h('div', { class: 'choice-editor' })
    values.forEach((choice, ci) => {
      const value = h('input', { class: 'input', placeholder: ci === values.length - 1 ? 'add a choice…' : 'choice' })
      value.value = choice
      const note = h('input', { class: 'input', placeholder: 'what it means (optional)' })
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
      })
      value.addEventListener('change', commit)
      note.addEventListener('change', commit)
      list.append(h('div', { class: 'choice-row' }, value, note))
    })
    return h('div', { class: 'choice-detail' }, h('strong', {}, field.type === 'enum' ? 'Allowed choices (exactly one)' : 'Allowed choices (one or more)'), list)
  }

  function refresh(data: AppData): void {
    renderFields(data)
    const { errors: list } = resolveContract(data.state.contract)
    const ctx = buildContractContext(data.state.contract)
    const notice = ctx && data.state.parserId && data.state.parserId !== 'json-unstack'
      ? [h('p', { class: 'parser-notice' }, 'With fields defined, choose "JSON Object (Unstack to Columns)" to get each field as a column.')]
      : []
    errors.replaceChildren(...list.map(e => h('p', { class: 'contract-error' }, e.message)), ...notice)
    const prose = renderContractProse(data.state.contract)
    schemaPreview.hidden = !prose
    schemaPreview.querySelector('pre')!.textContent = prose ? `${prose}\n\n— JSON schema —\n${JSON.stringify(ctx?.schema ?? null, null, 2)}` : ''
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
