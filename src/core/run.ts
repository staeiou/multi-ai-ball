// The run: iterate coordinates over the frozen run with a bounded pool,
// render each body at dispatch, send it, parse the response, hand the row
// back. Pause stops admission; cancel aborts in-flight calls. Nothing here
// touches the DOM and nothing holds a rendered request after its response.

import { runCall } from './api'
import type { RetryEvent } from './api'
import { parseResponse } from './parsers'
import { estimateCostUsd } from './pricing'
import { coordinateAt, renderCall } from './render'
import { naiveTokenCount } from './tokenizer'
import { totalCalls } from './freeze'
import type { CallRow, FrozenRun } from './types'

export interface RunHooks {
  onRow?: (index: number, row: CallRow) => void
  onRetry?: (index: number, event: RetryEvent) => void
}

export interface RunOutcome {
  rows: CallRow[]
  elapsedMs: number
  aborted: boolean
}

export function responseText(row: Pick<CallRow, 'parts'>): string {
  return row.parts.filter(part => part.kind === 'text').map(part => (part as { text: string }).text).join('\n')
}

/** Pre-run cost estimate per coordinate: constant block + this case's item,
 * against the model's price, assuming the output limit is used in full. */
export function estimateRow(run: FrozenRun, index: number, assumedOutputTokens: number): number | null {
  const coord = coordinateAt(run, index)
  const model = run.models[coord.modelIndex]!
  const c = run.cases[coord.caseIndex]!
  const itemTokens = naiveTokenCount(run.itemTemplate + Object.values(c.bindings).join(' ') + run.systemTemplate)
  const lengthName = model.guidance.outputLengthName ?? 'max_tokens'
  const cap = typeof model.body[lengthName] === 'number' ? (model.body[lengthName] as number)
    : typeof model.body.max_completion_tokens === 'number' ? (model.body.max_completion_tokens as number)
      : assumedOutputTokens
  return estimateCostUsd(model.guidance.pricing.value, run.constantBlockTokens + itemTokens, Math.min(cap, assumedOutputTokens))
}

export function pendingRows(run: FrozenRun, assumedOutputTokens = 512): CallRow[] {
  const total = totalCalls(run)
  const rows: CallRow[] = []
  for (let index = 0; index < total; index++) {
    const estimated = estimateRow(run, index, assumedOutputTokens)
    rows.push({ coord: coordinateAt(run, index), status: 'pending', parts: [], parsed: null, parseStatus: 'none', ...(estimated !== null ? { estimatedCostUsd: estimated } : {}) })
  }
  return rows
}

export class RunController {
  private rows: CallRow[] = []
  private abortController = new AbortController()
  private paused = false
  private resumeWaiters: Array<() => void> = []

  constructor(private run: FrozenRun, private apiKey: string, private hooks: RunHooks = {}) {}

  /** Rows to execute; by default every coordinate, or a subset (rerun failed). */
  async start(indices?: number[]): Promise<RunOutcome> {
    const run = this.run
    const total = totalCalls(run)
    const queue = indices ?? Array.from({ length: total }, (_, i) => i)
    if (this.rows.length !== total) this.rows = pendingRows(run)
    const t0 = performance.now()
    let cursor = 0
    const controller = this.abortController

    const worker = async (): Promise<void> => {
      while (true) {
        if (controller.signal.aborted) break
        if (this.paused) await new Promise<void>(resolve => this.resumeWaiters.push(resolve))
        if (controller.signal.aborted) break
        const position = cursor++
        if (position >= queue.length) break
        const index = queue[position]!
        const coord = coordinateAt(run, index)
        const model = run.models[coord.modelIndex]!
        const rendered = renderCall(run, coord)
        const outcome = await runCall(rendered, model, {
          apiKey: this.apiKey,
          retry: { maxRetries: run.retries, backoffMultiplier: 2, baseDelayMs: 1000, maxDelayMs: 30000 },
          timeoutMs: run.timeoutMs,
          signal: controller.signal,
          onRetry: event => this.hooks.onRetry?.(index, event),
        })
        const text = responseText(outcome)
        const { parsed, status } = outcome.status === 'ok' ? parseResponse(run.parserId, text) : { parsed: null, status: 'none' as const }
        const row: CallRow = { ...outcome, coord, parsed, parseStatus: status, estimatedCostUsd: this.rows[index]?.estimatedCostUsd }
        this.rows[index] = row
        this.hooks.onRow?.(index, row)
      }
    }

    await Promise.all(Array.from({ length: Math.min(run.concurrency, queue.length) }, () => worker()))
    return { rows: this.rows, elapsedMs: Math.round(performance.now() - t0), aborted: controller.signal.aborted }
  }

  pause(): void { this.paused = true }

  resume(): void {
    this.paused = false
    const waiters = this.resumeWaiters
    this.resumeWaiters = []
    for (const wake of waiters) wake()
  }

  abort(): void {
    this.abortController.abort()
    this.resume()
  }

  snapshot(): CallRow[] { return this.rows }
}
