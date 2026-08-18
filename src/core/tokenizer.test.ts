import { describe, expect, it } from 'vitest'

import { countTokens, naiveTokenCount } from './tokenizer'

describe('tokenizer', () => {
  it('falls back to the naive estimate in environments without a worker', async () => {
    // Vitest's node environment has no Worker, so the fallback path runs.
    expect(typeof Worker).toBe('undefined')
    const text = 'Hello, does this count as a paragraph of tokens? Yes it does.'
    expect(await countTokens(text)).toBe(naiveTokenCount(text))
  })

  it('counts empty input as zero without touching the worker', async () => {
    expect(await countTokens('')).toBe(0)
  })

  it('naive estimate is monotonic in length', () => {
    expect(naiveTokenCount('aaaa')).toBe(1)
    expect(naiveTokenCount('aaaaaaaa')).toBe(2)
  })
})