// The run lifecycle: expand specs (models × cases × repeats), dispatch with a
// concurrency cap, stream progress through callbacks, support abort, and
// produce the run snapshot for display/export. Grid and exporter are pure
// consumers of the snapshot — nothing here touches the DOM.

import { runCall, runCallStream } from './api'
import type { RetryEvent, RetryPolicy } from './api'
import { buildContractContext, compileContractChannels } from './contract'
import { estimateCostUsd } from './pricing'
import type { UnitPrices } from './pricing'
import { buildContractParams } from './providers'
import { renderPromptTemplate } from './template'
import { countTokens, naiveTokenCount } from './tokenizer'
import type {
  CaseSourcePlan,
  CallResult,
  ContractAuthoring,
  ContractPlacement,
  ModelCatalogEntry,
  ParamOverrides,
  ProviderRuntime,
  RowProgress,
  RunSpec,
} from './types'

export interface RunOptions {
  concurrency: number
  retry: RetryPolicy
  timeoutMs: number
  /** Auto-off for streaming when the run is large enough that per-token
   * updates are noise (progress counters instead). */
  streamThreshold: number
  /** Estimated input tokens per spec (case-dependent; counts once per case). */
  inputTokens: number[]
  pricing: Array<UnitPrices | null>
  /** Assumed output tokens for pre-run cost estimation. */
  assumedOutputTokens: number
}

export interface RunOutcome {
  results: CallResult[]
  elapsedMs: number
  aborted: boolean
}

/** Everything needed to expand the case matrix into wire-ready RunSpecs. */
export interface RunSpecOptions {
  provider: ProviderRuntime
  apiKey: string
  /** Full loaded catalogue; drives supported-parameter propagation. */
  models: ModelCatalogEntry[]
  /** Model ids to run, in run order. */
  selected: string[]
  repeats: number
  params: ParamOverrides
  zdr: boolean
  /** Whether streaming is enabled at all (user preference). */
  stream: boolean
  /** Runs larger than this never stream (per-token updates are noise). */
  streamThreshold: number
  plan: CaseSourcePlan
  contractAuthoring: ContractAuthoring | null
  contractPlacement: ContractPlacement
  strictJson: boolean
}

export interface RunPlan {
  specs: RunSpec[]
  /** Per-spec estimated input-token counts, aligned by index. */
  inputTokens: number[]
}

const TOKEN_WORKER_CASE_LIMIT = 200

/** Expand models × cases × repeats into the spec matrix, rendering templates
 * and compiling the output contract at the only place a rendered prompt is
 * allowed to exist (the wire edge). Pure: no DOM, unit-testable. */
export async function buildRunSpecs(options: RunSpecOptions): Promise<RunPlan> {
  const ctx = buildContractContext(options.contractAuthoring)
  const renderedCases = options.plan.cases.map(c => {
    const userPrompt = renderPromptTemplate(options.plan.template, c.bindings)
    const systemPrompt = renderPromptTemplate(options.plan.systemTemplate, c.bindings)
    return ctx
      ? compileContractChannels(options.contractAuthoring, options.contractPlacement, userPrompt, systemPrompt)
      : { userPrompt, systemPrompt }
  })
  const caseTokens = await tokenCountsPerCase(renderedCases)
  const modelById = new Map(options.models.map(model => [model.id, model]))
  const totalCalls = options.plan.cases.length * options.selected.length * options.repeats

  const specs: RunSpec[] = []
  const inputTokens: number[] = []
  options.plan.cases.forEach((c, caseIndex) => {
    const rendered = renderedCases[caseIndex]!
    for (const modelId of options.selected) {
      const model = modelById.get(modelId)
      for (let repeat = 0; repeat < options.repeats; repeat++) {
        specs.push({
          provider: options.provider,
          apiKey: options.apiKey,
          model: modelId,
          supportedParams: model?.supportedParams,
          params: options.params,
          extraParams: ctx ? buildContractParams(options.provider, modelId, ctx, options.strictJson) : undefined,
          prompt: rendered.userPrompt,
          system: rendered.systemPrompt,
          stream: options.stream && totalCalls <= options.streamThreshold,
          zdr: options.zdr,
          caseLabel: c.label,
          bindings: c.bindings,
          repeatIndex: repeat,
        })
        inputTokens.push(caseTokens[caseIndex] ?? 0)
      }
    }
  })
  return { specs, inputTokens }
}

/** Token counts per case through the worker; naive byte-count beyond the
 * worker budget, and as the worker's own failure fallback. */
async function tokenCountsPerCase(cases: Array<{ userPrompt: string; systemPrompt: string }>): Promise<number[]> {
  const perCase = await Promise.all(cases.slice(0, TOKEN_WORKER_CASE_LIMIT).map(async c =>
    countTokens(`${c.systemPrompt}\n${c.userPrompt}`),
  ))
  while (perCase.length < cases.length) {
    const c = cases[perCase.length]!
    perCase.push(naiveTokenCount(`${c.systemPrompt}\n${c.userPrompt}`))
  }
  return perCase
}

export class RunController {
  private results: CallResult[] = []
  private abortController: AbortController | null = null

  constructor(private options: RunOptions) {}

  async start(
    specs: RunSpec[],
    onUpdate: (index: number, result: CallResult) => void,
    onProgress: (index: number, progress: RowProgress) => void,
    onRetry?: (index: number, event: RetryEvent) => void,
  ): Promise<RunOutcome> {
    const { concurrency, inputTokens, pricing, assumedOutputTokens } = this.options
    this.results = specs.map((spec, index) => {
      const estimated = estimateCostUsd(pricing[index] ?? null, inputTokens[index] ?? 0, assumedOutputTokens)
      return {
        model: spec.model,
        status: 'pending' as const,
        parts: [],
        ...(estimated !== null ? { estimatedCostUsd: estimated } : {}),
      }
    })
    this.abortController = new AbortController()

    const t0 = performance.now()
    const streamThreshold = this.options.streamThreshold
    const controller = this.abortController
    if (!controller) return { results: this.results, elapsedMs: 0, aborted: true }
    let cursor = 0
    let aborted = false

    const worker = async (): Promise<void> => {
      while (true) {
        const index = cursor++
        if (index >= specs.length || controller.signal.aborted) break
        const spec = specs[index]!
        const stream = spec.stream && specs.length <= streamThreshold
        const runOptions = {
          retry: this.options.retry,
          timeoutMs: this.options.timeoutMs,
          pricing: pricing[index] ?? null,
          signal: controller.signal,
          onProgress: (progress: RowProgress) => onProgress(index, progress),
          onRetry: (event: RetryEvent) => onRetry?.(index, event),
        }
        const result = stream
          ? await runCallStream({ ...spec, stream: true }, runOptions)
          : await runCall({ ...spec, stream: false }, runOptions)
        this.results[index] = result
        onUpdate(index, result)
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, specs.length) }, () => worker())
    await Promise.all(workers)
    aborted = controller.signal.aborted

    return {
      results: this.results,
      elapsedMs: Math.round(performance.now() - t0),
      aborted,
    }
  }

  abort(): void {
    this.abortController?.abort()
  }

  snapshot(): CallResult[] {
    return this.results
  }
}

/** Whether a run should stream at all: only when total calls are small. */
export function shouldStream(totalCalls: number, threshold: number): boolean {
  return totalCalls <= threshold
}
