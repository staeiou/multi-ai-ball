// Frozen run + coordinate -> the exact call. This is the only place a request
// body is produced, in the browser; the Python bundle does the same thing to
// the same skeleton (runtime/multiaiball/runner.py build_request). The body is
// serialized once here and that string is what fetch sends and what is hashed.

import { substitute } from './providers/shapes'
import { renderPromptTemplate } from './template'
import type { Coordinate, FrozenRun } from './types'

export interface RenderedCall {
  coord: Coordinate
  url: string
  /** Still carrying {{API_KEY}}; the runner substitutes at send time. */
  headers: Record<string, string>
  shape: FrozenRun['models'][number]['provider'] extends never ? never : 'openai-chat' | 'anthropic-messages'
  system: string
  prompt: string
  body: unknown
  bodyString: string
}

export function coordinateAt(run: Pick<FrozenRun, 'cases' | 'models' | 'repeats'>, index: number): Coordinate {
  const perCase = run.models.length * run.repeats
  const caseIndex = Math.floor(index / perCase)
  const rest = index % perCase
  return { caseIndex, modelIndex: Math.floor(rest / run.repeats), repeat: rest % run.repeats }
}

export function indexOf(run: Pick<FrozenRun, 'models' | 'repeats'>, coord: Coordinate): number {
  return coord.caseIndex * run.models.length * run.repeats + coord.modelIndex * run.repeats + coord.repeat
}

export function systemChannel(run: Pick<FrozenRun, 'systemTemplate' | 'constantBlock'>, bindings: Record<string, string>): string {
  const rendered = renderPromptTemplate(run.systemTemplate, bindings)
  return [rendered, run.constantBlock].filter(part => part.length > 0).join('\n\n')
}

export function renderCall(run: FrozenRun, coord: Coordinate): RenderedCall {
  const c = run.cases[coord.caseIndex]
  const model = run.models[coord.modelIndex]
  if (!c || !model) throw new Error(`coordinate out of range: ${JSON.stringify(coord)}`)
  const prompt = renderPromptTemplate(run.itemTemplate, c.bindings)
  const system = systemChannel(run, c.bindings)
  const body = substitute(model.body, system, prompt)
  return {
    coord,
    url: model.url,
    headers: model.headers,
    shape: model.provider === 'anthropic' ? 'anthropic-messages' : 'openai-chat',
    system,
    prompt,
    body,
    bodyString: JSON.stringify(body),
  }
}

/** JSON with keys sorted at every level; the cross-language comparison form
 * (Python: json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
