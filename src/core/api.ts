// One HTTP call: send a rendered body, retry per policy, read the response
// through the shape. The only place the app talks to a provider. Retry
// semantics: 429/5xx/no-headers-timeout/network are retryable; 4xx other than
// 429 and post-headers (billed) timeouts are terminal; backoff is exponential
// with full jitter, honoring Retry-After. Non-streaming by design: the payload
// promise is about request bodies, and a progress counter is the UI.

import { errorMessage, hitOutputLimit, readResponse } from './providers/shapes'
import type { RenderedCall } from './render'
import { sha256Hex } from './render'
import type { CallRow, FrozenModel } from './types'
import { estimateCostUsd } from './pricing'

export interface RetryPolicy {
  maxRetries: number
  backoffMultiplier: number
  baseDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_RETRY: RetryPolicy = { maxRetries: 2, backoffMultiplier: 2, baseDelayMs: 1000, maxDelayMs: 30000 }

export interface RetryEvent {
  attempt: number
  maxRetries: number
  status?: number
  error?: string
  delayMs: number
}

export interface CallOptions {
  apiKey: string
  retry: RetryPolicy
  timeoutMs: number
  onRetry?: (event: RetryEvent) => void
  signal?: AbortSignal
}

/** Everything a CallRow carries that the call itself produces. */
export type CallOutcome = Omit<CallRow, 'coord' | 'parsed' | 'parseStatus' | 'estimatedCostUsd'>

function delayMs(policy: RetryPolicy, attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
    const when = Date.parse(retryAfterHeader)
    if (!Number.isNaN(when)) return Math.max(0, when - Date.now())
  }
  const capped = Math.min(policy.baseDelayMs * Math.pow(policy.backoffMultiplier, attempt), policy.maxDelayMs)
  return 250 + Math.floor(Math.random() * Math.max(0, capped - 249))
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

/** The headers actually sent: the frozen headers with the key substituted.
 * An empty key drops the auth header (local servers). */
export function sendHeaders(headers: Record<string, string>, apiKey: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!value.includes('{{API_KEY}}')) out[name] = value
    else if (apiKey) out[name] = value.replace('{{API_KEY}}', apiKey)
  }
  return out
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function runCall(call: RenderedCall, model: FrozenModel, options: CallOptions): Promise<CallOutcome> {
  const bodyHash = await sha256Hex(call.bodyString)
  const base: CallOutcome = { status: 'pending', parts: [], bodyHash }
  const headers = sendHeaders(call.headers, options.apiKey)

  let lastError: string | null = null
  for (let attempt = 0; attempt <= options.retry.maxRetries; attempt++) {
    if (options.signal?.aborted) return { ...base, status: 'error', error: 'Aborted.', latencyMs: 0 }

    const t0 = performance.now()
    const attemptController = new AbortController()
    const onOuterAbort = () => attemptController.abort()
    options.signal?.addEventListener('abort', onOuterAbort, { once: true })
    const timer = setTimeout(() => attemptController.abort(), options.timeoutMs)
    let response: Response | null = null
    try {
      response = await fetch(call.url, { method: 'POST', headers, body: call.bodyString, signal: attemptController.signal })
      const raw = await response.text()
      let json: unknown = null
      try { json = raw ? JSON.parse(raw) : null } catch { /* keep raw for the error path */ }
      const latencyMs = Math.round(performance.now() - t0)

      if (!response.ok) {
        const message = errorMessage(json) ?? (raw ? raw.slice(0, 300) : 'Request failed')
        if (isRetryableStatus(response.status) && attempt < options.retry.maxRetries) {
          lastError = `HTTP ${response.status} — ${message}`
          const wait = delayMs(options.retry, attempt, response.headers.get('retry-after'))
          options.onRetry?.({ attempt: attempt + 1, maxRetries: options.retry.maxRetries, status: response.status, error: lastError, delayMs: wait })
          await sleep(wait)
          continue
        }
        return { ...base, status: 'error', httpStatus: response.status, latencyMs, error: `HTTP ${response.status} — ${message}`, raw }
      }

      const read = readResponse(call.shape, json)
      if (read.error) {
        return { ...base, status: 'error', httpStatus: response.status, latencyMs, error: read.error, raw }
      }
      if (read.text === null && read.parts.length === 0) {
        const message = hitOutputLimit(read.finishReason) || read.thinking
          ? 'No answer: the maximum answer length was used up before the answer (reasoning models think first). Raise the maximum answer length in Run settings.'
          : 'Provider returned no content.'
        return { ...base, status: 'error', httpStatus: response.status, latencyMs, error: message, thinking: read.thinking, raw, ...(read.promptTokens !== undefined ? { promptTokens: read.promptTokens } : {}), ...(read.completionTokens !== undefined ? { completionTokens: read.completionTokens } : {}) }
      }
      const costUsd = read.costUsd ?? (read.promptTokens !== undefined && read.completionTokens !== undefined
        ? estimateCostUsd(model.guidance.pricing.value, read.promptTokens, read.completionTokens) ?? undefined
        : undefined)
      return {
        ...base,
        status: 'ok',
        httpStatus: response.status,
        latencyMs,
        parts: read.parts,
        thinking: read.thinking,
        promptTokens: read.promptTokens,
        completionTokens: read.completionTokens,
        totalTokens: read.totalTokens,
        costUsd,
        upstream: read.upstream,
        raw,
      }
    } catch (error) {
      const err = error as { name?: string; message?: string }
      const latencyMs = Math.round(performance.now() - t0)
      const aborted = options.signal?.aborted === true
      const timedOut = err?.name === 'AbortError'
      const headersReceived = response !== null
      const retryable = !aborted && (timedOut ? !headersReceived : true)
      lastError = aborted
        ? 'Aborted.'
        : timedOut
          ? (headersReceived ? 'Timed out mid-generation (not retried: the model was already billed for it).' : `Timed out after ${Math.round(options.timeoutMs / 1000)}s with no response.`)
          : err instanceof TypeError
            ? 'Network or CORS error: is the endpoint reachable from this origin?'
            : String(err?.message ?? error)
      if (retryable && attempt < options.retry.maxRetries) {
        const wait = delayMs(options.retry, attempt, null)
        options.onRetry?.({ attempt: attempt + 1, maxRetries: options.retry.maxRetries, error: lastError, delayMs: wait })
        await sleep(wait)
        continue
      }
      return { ...base, status: 'error', latencyMs, error: lastError }
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onOuterAbort)
    }
  }
  return { ...base, status: 'error', error: lastError ?? 'Retries exhausted.' }
}
