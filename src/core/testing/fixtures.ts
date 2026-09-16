// Shared fixtures for the core tests: a small content-analysis sheet with
// coded and blank rows, and catalog models with known guidance.

import type { CatalogModel, ColumnRole, ModelGuidance } from '../types'
import type { Row } from '../partition'

export const ROWS: Row[] = [
  { id: 'A1', text: 'Markets fell sharply on rate fears.', source: 'Reuters', frame: 'economic', score: 4 },
  { id: 'A2', text: 'The council debated the new park.', source: 'Local', frame: 'civic', score: 2 },
  { id: 'A3', text: 'Hospital wait times doubled.', source: 'Herald', frame: '', score: '' },
  { id: 'A4', text: 'Startup raises $50M.', source: 'Wire', frame: '', score: '' },
  { id: 'A5', text: 'Partially coded row.', source: 'Wire', frame: 'economic', score: '' },
]

export const ROLES: Record<string, ColumnRole> = {
  id: 'reference',
  text: 'input',
  source: 'metadata',
  frame: 'output',
  score: 'output',
}

interface GuidanceValues {
  temperature: ModelGuidance['temperature']['value']
  effortValues: ModelGuidance['effortValues']['value']
  structuredOutput: ModelGuidance['structuredOutput']['value']
  jsonObject: ModelGuidance['jsonObject']['value']
  contextLimit: ModelGuidance['contextLimit']['value']
  outputLimit: ModelGuidance['outputLimit']['value']
  pricing: ModelGuidance['pricing']['value']
}

export function guidance(overrides: Partial<GuidanceValues> = {}): ModelGuidance {
  return {
    temperature: { value: overrides.temperature ?? 'unknown', source: 'models-dev' },
    effortValues: { value: overrides.effortValues ?? null, source: 'models-dev' },
    structuredOutput: { value: overrides.structuredOutput ?? 'unknown', source: 'models-dev' },
    jsonObject: { value: overrides.jsonObject ?? 'unknown', source: 'models-dev' },
    contextLimit: { value: overrides.contextLimit ?? null, source: 'models-dev' },
    outputLimit: { value: overrides.outputLimit ?? null, source: 'models-dev' },
    pricing: { value: overrides.pricing ?? null, source: 'models-dev' },
  }
}

export const GPT_LIKE: CatalogModel = {
  id: 'gpt-5',
  guidance: guidance({ temperature: false, effortValues: ['minimal', 'low', 'medium', 'high'], structuredOutput: true, contextLimit: 400000, outputLimit: 128000, pricing: { prompt: 1.25e-6, completion: 1e-5 } }),
}

export const GPT41_LIKE: CatalogModel = {
  id: 'gpt-4.1-mini',
  guidance: guidance({ temperature: true, effortValues: null, structuredOutput: true, contextLimit: 1047576, outputLimit: 32768, pricing: { prompt: 4e-7, completion: 1.6e-6 } }),
}

export const CLAUDE_LIKE: CatalogModel = {
  id: 'claude-sonnet-5',
  guidance: { ...guidance({ temperature: false, effortValues: ['low', 'medium', 'high', 'xhigh', 'max'], structuredOutput: true, contextLimit: 1000000, outputLimit: 128000, pricing: { prompt: 2e-6, completion: 1e-5 } }) },
}

export const UNKNOWN_MODEL: CatalogModel = { id: 'mystery-1', guidance: guidance() }
