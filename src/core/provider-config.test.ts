import { describe, expect, it } from 'vitest'

import { getAllProviders, getProvider, matchingRule, outputLengthParamName, supportsStructuredOutput, systemPromptConfigFor } from './provider-config'

describe('vendored provider configs', () => {
  it('loads the maintained presets from the vendored tree', () => {
    const ids = getAllProviders().map(p => p.id)
    expect(ids).toContain('openrouter')
    expect(ids).toContain('openai-chat')
    expect(ids).toContain('anthropic')
    // Unsupported families are excluded by design.
    expect(ids).not.toContain('ollama-chat')
    expect(ids).not.toContain('deterministic')
  })

  it('merges group auth/env + endpoint path into the resolved config', () => {
    const anthropic = getProvider('anthropic')!
    expect(anthropic.api).toEqual({ baseUrl: 'https://api.anthropic.com', endpoint: '/v1/messages' })
    expect(anthropic.auth).toEqual({ type: 'header', header: 'x-api-key', envVar: 'ANTHROPIC_API_KEY' })
    expect(anthropic.family).toBe('anthropic')
    expect(anthropic.headers['anthropic-version']).toBe('2023-06-01')
  })

  it('carries the CORS-enabling browser header only for anthropic', () => {
    const anthropic = getProvider('anthropic')!
    expect(anthropic.headers['anthropic-dangerous-direct-browser-access']).toBe('true')
    expect(getProvider('openai-chat')!.headers['anthropic-dangerous-direct-browser-access']).toBeUndefined()
  })

  it('exposes extraction paths and structured-output config', () => {
    const openai = getProvider('openai-chat')!
    expect(openai.responseTransform!.contentPath).toBeTruthy()
    expect(openai.structuredOutput!.requiresParameter).toBe('response_format')
    expect(openai.usageExtraction!.promptTokensPath).toBe('usage.prompt_tokens')
    const openrouter = getProvider('openrouter')!
    expect(openrouter.usageExtraction!.costPath).toBe('usage.cost')
  })
})

describe('matchingRule', () => {
  it('applies the first matching rule and removes forbidden parameters', () => {
    const openai = getProvider('openai-chat')!
    const gpt5 = matchingRule(openai, 'gpt-5.1')
    expect(gpt5).toBeDefined()
    expect(gpt5!.params.temperature).toBeUndefined()

    const mini = matchingRule(openai, 'gpt-4o-mini')
    expect(mini!.params.temperature).toBeDefined()
  })

  it('falls back to the endpoint systemPromptConfig then ignore', () => {
    const anthropic = getProvider('anthropic')!
    expect(systemPromptConfigFor(anthropic, 'claude-sonnet-4-20250514')).toEqual(expect.objectContaining({ mode: 'field', fieldName: 'system' }))
    const openai = getProvider('openai-chat')!
    expect(systemPromptConfigFor(openai, 'gpt-4o')).toEqual(expect.objectContaining({ mode: 'message' }))
  })

  it('resolves the output-length parameter from is_output_length', () => {
    expect(outputLengthParamName(getProvider('openai-chat')!, 'gpt-4o')).toBe('max_completion_tokens')
    expect(outputLengthParamName(getProvider('openai-chat')!, 'gpt-5.1')).toBe('max_completion_tokens')
    expect(outputLengthParamName(getProvider('anthropic')!, 'claude-sonnet-4')).toBe('max_tokens')
  })

  it('gates structured output on the rule defining the root parameter', () => {
    expect(supportsStructuredOutput(getProvider('openai-chat')!, 'gpt-4o')).toBe(true)
    expect(supportsStructuredOutput(getProvider('anthropic')!, 'claude-sonnet-4-20250514')).toBe(false)
  })
})