import { describe, expect, it } from 'vitest'

import { breakdown, inferKind, MAX_CATEGORIES } from './breakdown'

const MODELS = ['a', 'b']

describe('breakdown', () => {
  it('categorical: counts distinct values, most common first, per model aligned; blanks are unanswered', () => {
    const items = [
      { model: 'a', value: 'civic' }, { model: 'a', value: 'economic' }, { model: 'a', value: '' },
      { model: 'b', value: 'civic' }, { model: 'b', value: 'civic' }, { model: 'b', value: null },
    ]
    const b = breakdown(items, 'categorical', MODELS)
    expect(b.total).toBe(6)
    expect(b.answered).toBe(4)
    expect(b.values).toEqual([{ value: 'civic', count: 3 }, { value: 'economic', count: 1 }])
    expect(b.byModel).toEqual([{ model: 'a', answered: 2, counts: [1, 1] }, { model: 'b', answered: 2, counts: [2, 0] }])
  })

  it('categorical: booleans and multi-choice arrays count per choice; more than the cap folds into other', () => {
    const b = breakdown([{ model: 'a', value: true }, { model: 'a', value: ['x', 'y'] }, { model: 'b', value: false }], 'categorical', MODELS)
    expect(b.answered).toBe(3)
    expect(b.values.map(v => v.value).sort()).toEqual(['false', 'true', 'x', 'y'])
    const many = breakdown(Array.from({ length: 20 }, (_, i) => ({ model: 'a', value: `v${i}` })).concat([{ model: 'a', value: 'v0' }]), 'categorical', ['a'])
    expect(many.values).toHaveLength(MAX_CATEGORIES + 1)
    expect(many.values[0]).toEqual({ value: 'v0', count: 2 })
    expect(many.values[MAX_CATEGORIES]!.value).toMatch(/^other \(8 values\)$/)
    expect(many.values.reduce((s, v) => s + v.count, 0)).toBe(21)
  })

  it('numeric: few distinct values become buckets in numeric order with stats per model', () => {
    const items = [{ model: 'a', value: 3 }, { model: 'a', value: '5' }, { model: 'b', value: 1 }, { model: 'b', value: 3 }, { model: 'b', value: 'n/a' }]
    expect(inferKind(items)).toBe('categorical')
    const b = breakdown(items, 'numeric', MODELS)
    expect(b.answered).toBe(4)
    expect(b.values).toEqual([{ value: '1', count: 1 }, { value: '3', count: 2 }, { value: '5', count: 1 }])
    expect(b.stats).toEqual({ min: 1, max: 5, mean: 3, median: 3 })
    expect(b.byModel[0]).toEqual({ model: 'a', answered: 2, counts: [0, 1, 1], mean: 4, median: 4 })
    expect(b.byModel[1]).toEqual({ model: 'b', answered: 2, counts: [1, 1, 0], mean: 2, median: 2 })
  })

  it('numeric: many distinct values fall into ten equal bins that cover min to max', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ model: 'a', value: i }))
    expect(inferKind(items)).toBe('numeric')
    const b = breakdown(items, 'numeric', ['a'])
    expect(b.values).toHaveLength(10)
    expect(b.values[0]!.value).toBe('0–9.9')
    expect(b.values[9]!.value).toBe('89.1–99')
    expect(b.values.reduce((s, v) => s + v.count, 0)).toBe(100)
    expect(b.values.map(v => v.count)).toEqual([10, 10, 10, 10, 10, 10, 10, 10, 10, 10])
  })

  it('nothing answered yet: empty buckets, zero counts, no stats', () => {
    const b = breakdown([{ model: 'a', value: null }], 'numeric', ['a'])
    expect(b.answered).toBe(0)
    expect(b.values).toEqual([])
    expect(b.stats).toBeUndefined()
  })
})
