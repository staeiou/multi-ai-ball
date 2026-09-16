// Screen 2: instructions. For a single question the user writes the prompt.
// For a spreadsheet or a sweep the user writes what to do with each case; the
// per-row text is generated from the chosen columns and shown, editable under
// "more options". A preview shows exactly one filled-in case.

import { renderPromptTemplate } from '../../core/template'
import { h } from '../dom'
import { applyGuesses, caseCount, currentPartition, currentRows, instructionProblems } from '../model'
import type { AppData, Store } from '../store'
import type { Screen } from './screen'

export function buildInstructionsScreen(store: Store): Screen {
  const heading = h('p', {})
  const systemLabel = h('span', {}, 'Instructions')
  const system = h('textarea', { class: 'input', rows: '6', placeholder: '', 'data-field': 'system' })
  system.value = store.state.system
  const promptLabel = h('span', {}, 'Prompt')
  const prompt = h('textarea', { class: 'input', rows: '6', placeholder: '', 'data-field': 'prompt' })
  prompt.value = store.state.prompt
  const promptField = h('label', { class: 'field prompt-field' }, promptLabel, prompt)
  const systemField = h('label', { class: 'field' }, systemLabel, system)
  const generatedNote = h('p', { class: 'muted small' })
  const takeOver = h('button', { class: 'minibtn', type: 'button' }, 'Edit how each row is shown to the model')
  const resetAuto = h('button', { class: 'minibtn', type: 'button' }, 'Back to automatic')
  const more = h('details', { class: 'schema-preview more-options' }, h('summary', {}, 'More options'))
  const previewBox = h('div', { class: 'sheet-preview' })
  const problems = h('p', { class: 'wizard-blocker inline-blocker' })
  const controls = h('div', { class: 'row' }, takeOver, resetAuto)

  const el = h('section', { class: 'card stage-card instructions-stage' },
    h('div', { class: 'stage-heading' }, h('h2', {}, 'Instructions'), heading),
    systemField,
    promptField,
    generatedNote,
    controls,
    more,
    problems,
    previewBox,
  )

  let caret = prompt.value.length
  prompt.addEventListener('input', () => { caret = prompt.selectionStart ?? prompt.value.length; store.update(d => { d.state.prompt = prompt.value; d.state.promptAuto = false }) })
  for (const event of ['click', 'keyup', 'select'] as const) prompt.addEventListener(event, () => { caret = prompt.selectionStart ?? prompt.value.length })
  system.addEventListener('input', () => store.update(d => { d.state.system = system.value }))
  takeOver.addEventListener('click', () => store.update(d => { d.state.promptAuto = false }))
  resetAuto.addEventListener('click', () => store.update(d => { d.state.promptAuto = true; applyGuesses(d) }))

  function insertPlaceholder(name: string): void {
    const marker = `{{${name}}}`
    const start = Math.max(0, Math.min(caret, prompt.value.length))
    prompt.value = `${prompt.value.slice(0, start)}${marker}${prompt.value.slice(start)}`
    caret = start + marker.length
    prompt.focus()
    prompt.setSelectionRange(caret, caret)
    store.update(d => { d.state.prompt = prompt.value; d.state.promptAuto = false })
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
      h('div', { class: 'preview-row' }, h('label', { class: 'param-field' }, h('span', {}, `What one of the ${caseCount(data).toLocaleString()} cases looks like to the model`), select)),
      h('div', { class: 'preview-prompt' },
        sys ? h('p', { class: 'preview-system' }, h('span', { class: 'preview-label' }, 'Instructions: '), document.createTextNode(sys)) : null,
        h('p', { class: 'preview-user' }, h('span', { class: 'preview-label' }, 'This case: '), document.createTextNode(user)),
      ),
    )
  }

  function refresh(data: AppData): void {
    const { state } = data
    // One question: the prompt box takes the height the viewport has and
    // scrolls inside itself past that; the other flows size to their content.
    el.classList.toggle('fill', state.flow === 'single')
    // The generated template is shown in the (read-only) textarea.
    if (state.promptAuto && prompt.value !== state.prompt) prompt.value = state.prompt
    const isSheet = state.flow === 'sheet'
    const isSweep = state.flow === 'sweep'
    if (state.flow === 'single') {
      heading.textContent = 'Write what you want to ask. Every model you pick gets exactly this.'
      promptLabel.textContent = 'Your prompt'
      prompt.placeholder = 'e.g. Explain the difference between weather and climate in two sentences.'
      systemLabel.textContent = 'Background instructions (optional)'
      system.placeholder = 'e.g. You are a patient science teacher. Answer for a 12-year-old.'
      promptField.hidden = false
      systemField.hidden = true
      more.replaceChildren(h('summary', {}, 'Optional background instructions (system prompt)'), systemField)
      systemField.hidden = false
      generatedNote.textContent = ''
      takeOver.hidden = true
      resetAuto.hidden = true
    } else {
      heading.textContent = isSheet ? 'Tell the model what to do with each row. Be specific: what to look for, how to decide, what counts.' : 'Optional background instructions the model follows for every combination. The prompt itself is on the previous screen.'
      systemLabel.textContent = isSheet ? 'What should the model do with each row?' : 'Instructions (optional)'
      system.placeholder = isSheet ? 'e.g. Read the article and decide which frame it uses: economic, civic, or human-interest. Give a confidence from 1 to 5.' : 'e.g. Answer as a hiring manager reviewing this resume.'
      systemField.hidden = false
      const { roles } = currentRows(data)
      const inputs = Object.entries(roles).filter(([, r]) => r === 'input').map(([c]) => c)
      promptLabel.textContent = isSheet ? 'How each row is shown to the model' : 'The prompt with its blanks (edit it on "Your data")'
      prompt.placeholder = ''
      if (isSweep && prompt.value !== state.prompt) prompt.value = state.prompt
      prompt.readOnly = (isSheet && state.promptAuto) || isSweep
      prompt.classList.toggle('readonly', prompt.readOnly)
      if (isSheet) {
        generatedNote.textContent = state.promptAuto
          ? `Generated from the column${inputs.length === 1 ? '' : 's'} you chose (${inputs.join(', ') || 'none yet'}). Each row is sent as its value${inputs.length === 1 ? '' : 's'}, then your instructions decide what happens.`
          : 'You are editing how each row is shown. {{column}} is replaced by that row\'s value.'
        takeOver.hidden = !state.promptAuto
        resetAuto.hidden = state.promptAuto
        const chips = inputs.map(c => { const chip = h('button', { class: 'chip', type: 'button', title: 'Insert' }, `{{${c}}}`); chip.addEventListener('click', () => insertPlaceholder(c)); return chip })
        more.replaceChildren(h('summary', {}, 'More options'), h('div', { class: 'chips' }, h('span', { class: 'muted small' }, 'Insert a column into the row text:'), ...chips))
        more.hidden = state.promptAuto
      } else {
        generatedNote.textContent = ''
        takeOver.hidden = true
        resetAuto.hidden = true
        more.hidden = true
      }
      promptField.hidden = false
    }
    if (state.flow !== 'single' && systemField.parentElement !== el) el.insertBefore(systemField, promptField)
    if (state.flow === 'single') more.hidden = false
    renderPreview(data)
    const list = instructionProblems(data)
    problems.hidden = list.length === 0
    problems.textContent = list.join(' · ')
    // Empty elements keep their margins and borders; take them out of the flow.
    generatedNote.hidden = generatedNote.textContent === ''
    controls.hidden = takeOver.hidden && resetAuto.hidden
    previewBox.hidden = !previewBox.hasChildNodes()
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
