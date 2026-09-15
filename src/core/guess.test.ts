import { describe, expect, it } from 'vitest'

import { generatedItemTemplate, guessField, guessRoles } from './guess'
import { ROWS } from './testing/fixtures'

describe('guesses from the sheet', () => {
  it('reads the long text column, fills the partly filled short columns, keeps the rest', () => {
    const rows = [...ROWS, { id: 'A6', text: 'x', source: 'y', frame: '', score: '', notes: 'one stray note' }]
    const roles = guessRoles(rows, ['id', 'text', 'source', 'frame', 'score', 'notes'])
    expect(roles).toEqual({ id: 'metadata', text: 'input', source: 'metadata', frame: 'output', score: 'output', notes: 'metadata' })
  })
  it('guesses field kinds from the filled values', () => {
    expect(guessField(ROWS, 'frame')).toEqual({ name: 'frame', type: 'enum', values: ['economic', 'civic'] })
    expect(guessField(ROWS, 'score')).toEqual({ name: 'score', type: 'integer', min: 2, max: 4 })
    expect(guessField(ROWS, 'text').type).toBe('string')
    expect(guessField(ROWS, 'nope')).toEqual({ name: 'nope', type: 'string' })
  })
  it('generates one line per input column, or the bare value for one', () => {
    expect(generatedItemTemplate(['text'])).toBe('{{text}}')
    expect(generatedItemTemplate(['title', 'body'])).toBe('title: {{title}}\nbody: {{body}}')
  })
})
