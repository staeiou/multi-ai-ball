import { describe, expect, it } from 'vitest'

import {
  buildContractSchema,
  compileContractChannels,
  effectiveFields,
  renderContractProse,
  resolveContract,
} from './contract'

describe('resolveContract', () => {
  it('normalizes names and reports duplicate/reserved/empty errors', () => {
    const { contract, errors } = resolveContract({
      fields: [
        { name: 'Score', type: 'number' },
        { name: 'score', type: 'number' },
        { name: 'bad.name', type: 'string' },
        { name: '', type: 'string' },
      ],
    })
    expect(contract.fields.map(f => f.name)).toEqual(['score'])
    expect(errors.some(e => e.code === 'duplicate-name')).toBe(true)
    expect(errors.some(e => e.code === 'reserved-name-character')).toBe(true)
  })

  it('reports enum and number-bound errors', () => {
    const { errors } = resolveContract({
      fields: [
        { name: 'cat', type: 'enum', values: ['a', 'a'] },
        { name: 'n', type: 'number', min: 5, max: 1 },
      ],
    })
    expect(errors.map(e => e.code).sort()).toEqual(['enum-duplicate-choice', 'number-bounds-inverted'])
  })

  it('inserts the rationale field first when enabled', () => {
    const { contract } = resolveContract({
      fields: [{ name: 'answer', type: 'string' }],
      rationaleFirst: true,
      rationaleSpec: 'Explain briefly.',
    })
    expect(contract.fields[0]!.name).toBe('rationale')
    expect(effectiveFields({ fields: [{ name: 'answer', type: 'string' }], rationaleFirst: true })[0]!.name).toBe('rationale')
  })
})

describe('buildContractSchema', () => {
  it('emits an object schema with typed properties and required list', () => {
    const { contract } = resolveContract({
      fields: [
        { name: 'score', type: 'number', min: 0, max: 100 },
        { name: 'grade', type: 'enum', values: ['A', 'B'] },
        { name: 'note', type: 'string' },
      ],
    })
    const schema = buildContractSchema(contract)
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['score', 'grade', 'note'])
    expect((schema.properties as Record<string, { type: string }>).score).toEqual({ type: 'number', minimum: 0, maximum: 100 })
    expect((schema.properties as Record<string, { enum?: string[] }>).grade.enum).toEqual(['A', 'B'])
  })
})

describe('renderContractProse', () => {
  it('compiles a JSON-instruction block when fields exist', () => {
    const prose = renderContractProse({ fields: [{ name: 'score', type: 'number' }, { name: 'grade', type: 'enum', values: ['A', 'B'] }], strictJson: true })
    expect(prose).toContain('single JSON object')
    expect(prose).toContain('score (number)')
    expect(prose).toContain('one of "A", "B"')
  })

  it('is empty when there is nothing structured', () => {
    expect(renderContractProse({ fields: [] })).toBe('')
  })
})

describe('compileContractChannels', () => {
  it('appends the block to the system prompt for system-after', () => {
    const { userPrompt, systemPrompt } = compileContractChannels(
      { fields: [{ name: 'x', type: 'string' }] },
      'system-after',
      'Question?',
      'You are terse.',
    )
    expect(userPrompt).toBe('Question?')
    expect(systemPrompt).toContain('<output-format>')
    expect(systemPrompt.startsWith('You are terse.')).toBe(true)
  })

  it('prepends to the user prompt for user-before, and none does nothing', () => {
    const prepend = compileContractChannels({ fields: [{ name: 'x', type: 'string' }] }, 'user-before', 'Q', 'S')
    expect(prepend.userPrompt.startsWith('<output-format>')).toBe(true)
    const untouched = compileContractChannels({ fields: [{ name: 'x', type: 'string' }] }, 'none', 'Q', 'S')
    expect(untouched.userPrompt).toBe('Q')
    expect(untouched.systemPrompt).toBe('S')
  })
})
