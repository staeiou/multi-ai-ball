import { describe, expect, it } from 'vitest'

import { normalizeBindingValue, promptPlaceholderNames, renderPromptTemplate } from './template'

describe('renderPromptTemplate', () => {
  it('substitutes placeholders left to right', () => {
    expect(renderPromptTemplate('Classify: {{type}}; Request: {{request}}.', {
      type: 'support', request: 'refund',
    })).toBe('Classify: support; Request: refund.')
  })

  it('renders an empty binding as nothing', () => {
    expect(renderPromptTemplate('A{{x}}B', { x: '' })).toBe('AB')
  })

  it('leaves an unbound placeholder literal so a typo stays visible', () => {
    expect(renderPromptTemplate('Hello {{contry}}', {})).toBe('Hello {{contry}}')
  })

  it('never rescans a substituted value (a value is not markup)', () => {
    expect(renderPromptTemplate('{{a}}', { a: 'x {{b}}' })).toBe('x {{b}}')
  })

  it('looks up own properties only', () => {
    expect(renderPromptTemplate('{{toString}}', {})).toBe('{{toString}}')
  })

  it('trims inner whitespace in a placeholder name', () => {
    expect(renderPromptTemplate('{{ name }}', { name: 'Ada' })).toBe('Ada')
  })

  it('renders numbers and booleans in JS spelling', () => {
    expect(renderPromptTemplate('{{n}} {{b}}', { n: 1.5, b: true })).toBe('1.5 true')
  })
})

describe('promptPlaceholderNames', () => {
  it('returns unique names in first appearance order across channels', () => {
    expect(promptPlaceholderNames('{{b}} {{a}}', '{{a}} {{c}}')).toEqual(['b', 'a', 'c'])
  })
})

describe('normalizeBindingValue', () => {
  it('stringifies objects as compact JSON', () => {
    expect(normalizeBindingValue({ a: 1 })).toBe('{"a":1}')
  })
})