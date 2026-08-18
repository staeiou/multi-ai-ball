// One HTTP call: streaming or not, retried per the policy, normalized into a
// CallResult. The only place in the app that talks to a provider. Retry
// semantics match Auditomatic's executor: 429/5xx/no-headers-timeout/network
// are retryable; 401/400 and post-headers (billed) timeouts are terminal;
// backoff is exponential with full jitter, honoring Retry-After.

import {
  buildChatRequest,
  contentParts,
  extractAnswer,
  parseChatError,
  parseUsage,
  streamDelta,
} from './providers'
import { estimateCostUsd } from './pricing'
import type { UnitPrices } from './pricing'
import type { CallResult, ContentPart, RowProgress, RunSpec } from './types'

export interface RetryPolicy {
  maxRetries: number
  backoffMultiplier: number
  baseDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_RETRY: RetryPolicy = { maxRetries: 2, backoffMultiplier: 2, baseDelayMs: 1000, maxDelayMs: 30000 }

/** Emitted just before a retry is attempted, so the UI can surface the fact
 * that a transient failure is being retried instead of silently waiting. */
export interface RetryEvent {
  /** 1-based retry number about to be attempted (1 = first retry). */
  attempt: number
  maxRetries: number
  status?: number
  error?: string
  delayMs: number
}

export interface RunCallOptions {
  retry: RetryPolicy
  timeoutMs: number
  /** Live unit prices for this model, for post-run cost reporting. */
  pricing?: UnitPrices | null
  onProgress?: (progress: RowProgress) => void
  onRetry?: (event: RetryEvent) => void
  signal?: AbortSignal
}

function delayMs(policy: RetryPolicy, attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
    const when = Date.parse(retryAfterHeader)
    if (!Number.isNaN(when)) return Math.max(0, when - Date.now())
  }
  const base = policy.baseDelayMs * Math.pow(policy.backoffMultiplier, attempt)
  const capped = Math.min(base, policy.maxDelayMs)
  // Full jitter: uniform in [0, capped) — prevents retry storms landing
  // together. A small floor also stops a failing endpoint from being hammered
  // with back-to-back retries and keeps the retrying state observable.
  return 250 + Math.floor(Math.random() * Math.max(0, capped - 249))
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

function parseRawResponse(json: unknown, spec: RunSpec): { parts: ContentPart[]; text: string | null; thinking?: string } {
  const provider = spec.provider
  const extracted = extractAnswer(provider.responseTransform, json)
  const parts = contentParts(provider.family, json)
  // The configured extraction path is authoritative for text; parts scanning
  // covers images/tool calls only when no parts already exist from the path.
  const hasTextPart = parts.some(p => p.kind === 'text' && p.text.length > 0)
  if (extracted.text && !hasTextPart) {
    parts.unshift({ kind: 'text', text: extracted.text })
  }
  return { parts, text: extracted.text ?? (parts.find(p => p.kind === 'text')?.text ?? null), thinking: extracted.reasoning }
}

export async function runCall(spec: RunSpec, options: RunCallOptions): Promise<CallResult> {
  const base: CallResult = { model: spec.model, status: 'pending', parts: [] }

  let lastError: string | null = null
  let lastStatus: number | null = null

  for (let attempt = 0; attempt <= options.retry.maxRetries; attempt++) {
    if (options.signal?.aborted) {
      return { ...base, status: 'error', error: 'Aborted.', latencyMs: 0 }
    }

    const t0 = performance.now()
    const attemptController = new AbortController()
    const onOuterAbort = () => attemptController.abort()
    options.signal?.addEventListener('abort', onOuterAbort, { once: true })
    const timeoutTimer = setTimeout(() => attemptController.abort(), options.timeoutMs)

    let response: Response | null = null
    try {
      const request = buildChatRequest(spec)
      response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: attemptController.signal,
      })

      const raw = await response.text()
      let json: unknown = null
      try {
        json = raw ? JSON.parse(raw) : null
      } catch {
        // keep raw text for the error path
      }
      const latencyMs = Math.round(performance.now() - t0)

      if (!response.ok) {
        if (isRetryableStatus(response.status) && attempt < options.retry.maxRetries) {
          lastStatus = response.status
          lastError = parseChatError(response.status, json, spec.provider.responseTransform)
          const delayMsWait = delayMs(options.retry, attempt, response.headers.get('retry-after'))
          options.onRetry?.({ attempt: attempt + 1, maxRetries: options.retry.maxRetries, status: response.status, error: lastError, delayMs: delayMsWait })
          clearTimeout(timeoutTimer)
          options.signal?.removeEventListener('abort', onOuterAbort)
          await sleep(delayMsWait)
          continue
        }
        return {
          ...base,
          status: 'error',
          latencyMs,
          error: parseChatError(response.status, json, spec.provider.responseTransform),
          rawJson: raw,
        }
      }

      const parsed = parseRawResponse(json, spec)
      const usage = parseUsage(spec.provider, json)
      let costUsd: number | null | undefined = usage.costUsd
      if (costUsd === undefined && options.pricing && usage.promptTokens !== undefined && usage.completionTokens !== undefined) {
        costUsd = estimateCostUsd(options.pricing, usage.promptTokens, usage.completionTokens)
      }
      if (parsed.text === null && parsed.parts.length === 0) {
        return { ...base, status: 'error', latencyMs, error: 'Provider returned no content.', rawJson: raw }
      }
      return {
        ...base,
        status: 'ok',
        latencyMs,
        parts: parsed.parts,
        thinking: parsed.thinking,
        ...(usage.promptTokens !== undefined ? { promptTokens: usage.promptTokens } : {}),
        ...(usage.completionTokens !== undefined ? { completionTokens: usage.completionTokens } : {}),
        ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
        ...(costUsd !== null && costUsd !== undefined ? { costUsd } : {}),
        rawJson: raw,
      }
    } catch (error) {
      const err = error as { name?: string; message?: string }
      const latencyMs = Math.round(performance.now() - t0)
      // Timeout: terminal only when the provider was already producing (headers
      // received) — a billed generation must not be re-run. Transport failures
      // before any response are transient.
      const timedOut = err?.name === 'AbortError'
      const headersReceived = response !== null
      // An outer (user) abort is not a transient failure: never retry, never
      // flash a retrying status, and fall through to the Aborted result.
      const aborted = options.signal?.aborted === true
      const retryable = !aborted && (timedOut ? !headersReceived : !response?.ok || response.status >= 500 || response.status === 429)
      lastStatus = response?.status ?? null
      lastError = aborted
        ? 'Aborted.'
        : timedOut
          ? (headersReceived ? 'Timed out mid-generation (not retried — the model was already billed for it).' : `Timed out after ${Math.round(options.timeoutMs / 1000)}s with no response.`)
          : err instanceof TypeError
            ? 'Network or CORS error — is the endpoint reachable from this origin?'
            : String(err?.message ?? error)
      if (retryable && attempt < options.retry.maxRetries) {
        const delayMsWait = delayMs(options.retry, attempt, response?.headers.get('retry-after') ?? null)
        options.onRetry?.({ attempt: attempt + 1, maxRetries: options.retry.maxRetries, status: lastStatus ?? undefined, error: lastError ?? undefined, delayMs: delayMsWait })
        clearTimeout(timeoutTimer)
        options.signal?.removeEventListener('abort', onOuterAbort)
        await sleep(delayMsWait)
        continue
      }
      clearTimeout(timeoutTimer)
      options.signal?.removeEventListener('abort', onOuterAbort)
      return { ...base, status: 'error', latencyMs, error: lastError }
    } finally {
      clearTimeout(timeoutTimer)
      options.signal?.removeEventListener('abort', onOuterAbort)
    }
  }

  return { ...base, status: 'error', error: lastError ?? 'Request failed.', ...(lastStatus !== null ? {} : {}) }
}

/** Streaming variant: same retry policy, but tokens stream through
 * onProgress and the final result carries accumulated usage. */
export async function runCallStream(spec: RunSpec, options: RunCallOptions): Promise<CallResult> {
  const base: CallResult = { model: spec.model, status: 'pending', parts: [] }
  const provider = spec.provider

  for (let attempt = 0; attempt <= options.retry.maxRetries; attempt++) {
    if (options.signal?.aborted) {
      return { ...base, status: 'error', error: 'Aborted.', latencyMs: 0 }
    }
    const t0 = performance.now()
    const attemptController = new AbortController()
    const onOuterAbort = () => attemptController.abort()
    options.signal?.addEventListener('abort', onOuterAbort, { once: true })
    const timeoutTimer = setTimeout(() => attemptController.abort(), options.timeoutMs)

    let response: Response | null = null
    try {
      const request = buildChatRequest(spec)
      response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: attemptController.signal,
      })

      if (!response.ok) {
        const raw = await response.text().catch(() => '')
        let json: unknown = null
        try { json = raw ? JSON.parse(raw) : null } catch { /* keep raw */ }
        if (isRetryableStatus(response.status) && attempt < options.retry.maxRetries) {
          const delayMsWait = delayMs(options.retry, attempt, response.headers.get('retry-after'))
          options.onRetry?.({ attempt: attempt + 1, maxRetries: options.retry.maxRetries, status: response.status, error: parseChatError(response.status, json, provider.responseTransform), delayMs: delayMsWait })
          clearTimeout(timeoutTimer)
          options.signal?.removeEventListener('abort', onOuterAbort)
          await sleep(delayMsWait)
          continue
        }
        return {
          ...base,
          status: 'error',
          latencyMs: Math.round(performance.now() - t0),
          error: parseChatError(response.status, json, provider.responseTransform),
          rawJson: raw,
        }
      }

      const reader = response.body?.getReader()
      if (!reader) {
        return { ...base, status: 'error', latencyMs: Math.round(performance.now() - t0), error: 'Streaming unsupported by this endpoint.' }
      }

      const decoder = new TextDecoder()
      let buffer = ''
      let text = ''
      let thinking = ''
      let usage: Record<string, number> | undefined
      const rawLines: string[] = []
      let lastDelta = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newlineIndex: number
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim()
          buffer = buffer.slice(newlineIndex + 1)
          if (!line) continue

          if (provider.family === 'openai-compat') {
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (!data || data === '[DONE]') continue
            rawLines.push(data)
            let json: unknown = null
            try { json = JSON.parse(data) } catch { continue }
            const delta = streamDelta(provider.family, json)
            if (delta.text) text += delta.text
            if (delta.thinking) thinking += delta.thinking
            if (delta.usage) usage = delta.usage
          } else {
            rawLines.push(line)
            let json: unknown = null
            try { json = JSON.parse(line) } catch { continue }
            const delta = streamDelta(provider.family, json)
            if (delta.text) text += delta.text
            if (delta.thinking) thinking += delta.thinking
            if (delta.usage) usage = delta.usage
            if (delta.text && delta.text.startsWith('ERROR:')) {
              return { ...base, status: 'error', latencyMs: Math.round(performance.now() - t0), error: delta.text, parts: [{ kind: 'text', text }], thinking: thinking || undefined }
            }
          }
          const now = performance.now()
          if (options.onProgress && now - lastDelta > 40) {
            lastDelta = now
            options.onProgress({ model: spec.model, text, thinking })
          }
        }
      }

      const latencyMs = Math.round(performance.now() - t0)
      const usageTokens = {
        promptTokens: usage?.input_tokens ?? usage?.prompt_tokens,
        completionTokens: usage?.output_tokens ?? usage?.completion_tokens,
      }
      const totalTokens = usage?.total_tokens ?? (usageTokens.promptTokens !== undefined && usageTokens.completionTokens !== undefined ? usageTokens.promptTokens + usageTokens.completionTokens : undefined)
      let costUsd: number | null | undefined
      if (usage?.cost !== undefined && typeof usage.cost === 'number') costUsd = usage.cost
      else if (options.pricing && usageTokens.promptTokens !== undefined && usageTokens.completionTokens !== undefined) {
        costUsd = estimateCostUsd(options.pricing, usageTokens.promptTokens, usageTokens.completionTokens)
      }

      options.onProgress?.({ model: spec.model, text, thinking })
      if (!text && !thinking) {
        return { ...base, status: 'error', latencyMs, error: 'Stream ended with no content.', rawJson: rawLines.join('\n') }
      }
      return {
        ...base,
        status: 'ok',
        latencyMs,
        parts: text ? [{ kind: 'text', text }] : [],
        thinking: thinking || undefined,
        ...(usageTokens.promptTokens !== undefined ? { promptTokens: usageTokens.promptTokens } : {}),
        ...(usageTokens.completionTokens !== undefined ? { completionTokens: usageTokens.completionTokens } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
        ...(costUsd !== null && costUsd !== undefined ? { costUsd } : {}),
        rawJson: rawLines.join('\n'),
      }
    } catch (error) {
      const err = error as { name?: string; message?: string }
      const latencyMs = Math.round(performance.now() - t0)
      const timedOut = err?.name === 'AbortError'
      const headersReceived = response !== null
      // Ditto the non-stream path: a user abort is terminal, not transient.
      const aborted = options.signal?.aborted === true
      const retryable = !aborted && (timedOut ? !headersReceived : response === null)
      if (retryable && attempt < options.retry.maxRetries) {
        const delayMsWait = delayMs(options.retry, attempt, response?.headers.get('retry-after') ?? null)
        options.onRetry?.({ attempt: attempt + 1, maxRetries: options.retry.maxRetries, delayMs: delayMsWait })
        clearTimeout(timeoutTimer)
        options.signal?.removeEventListener('abort', onOuterAbort)
        await sleep(delayMsWait)
        continue
      }
      const message = aborted
        ? 'Aborted.'
        : timedOut
          ? (headersReceived ? 'Timed out mid-generation (not retried — the model was already billed for it).' : `Timed out after ${Math.round(options.timeoutMs / 1000)}s with no response.`)
          : err instanceof TypeError
            ? 'Network or CORS error — is the endpoint reachable from this origin?'
            : String(err?.message ?? error)
      clearTimeout(timeoutTimer)
      options.signal?.removeEventListener('abort', onOuterAbort)
      return { ...base, status: 'error', latencyMs, error: message }
    } finally {
      clearTimeout(timeoutTimer)
      options.signal?.removeEventListener('abort', onOuterAbort)
    }
  }
  return { ...base, status: 'error', error: 'Retries exhausted.' }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}