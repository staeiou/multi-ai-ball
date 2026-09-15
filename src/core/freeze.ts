// Freezing a run: everything the browser needs to execute and everything the
// Python bundle needs to rerun, in one object, before expansion. The runner
// and the bundle generator both consume this and nothing else; neither ever
// sees an expanded task list.

import { buildContractContext } from './contract'
import { compileConstantBlock } from './examples'
import { columnsWithRole } from './partition'
import type { Row } from './partition'
import { buildFrozenModel } from './providers/build'
import { normalizeBindingValue, promptPlaceholderNames } from './template'
import { naiveTokenCount } from './tokenizer'
import type {
  CatalogModel,
  ColumnRole,
  ContractAuthoring,
  FrozenRun,
  ModelSettings,
  Partition,
  ProviderPreset,
  SharedParams,
} from './types'

export interface FreezeInput {
  preset: ProviderPreset
  baseUrl: string
  source: FrozenRun['source']
  /** Every row of the source, in source order. Single-prompt: one empty row. */
  rows: readonly Row[]
  roles: Record<string, ColumnRole>
  partition: Partition
  systemTemplate: string
  itemTemplate: string
  contract: ContractAuthoring | null
  parserId: string | null
  models: Array<{ model: CatalogModel; settings: ModelSettings }>
  shared: SharedParams
  repeats: number
  concurrency: number
  retries: number
  timeoutMs: number
  /** Label for a case, by source ordinal. */
  label?: (ordinal: number) => string
  /** Token counter for the constant block; naive chars/4 when absent. */
  countTokens?: (text: string) => Promise<number>
}

export interface TemplateProblem {
  placeholder: string
  message: string
}

/** Blocking problems with the templates against the declared roles: a
 * placeholder naming a reference, metadata, or output column (which must
 * never be sent), or a column that does not exist. */
export function templateProblems(itemTemplate: string, systemTemplate: string, roles: Record<string, ColumnRole>, hasSheet: boolean): TemplateProblem[] {
  const problems: TemplateProblem[] = []
  for (const name of promptPlaceholderNames(itemTemplate, systemTemplate)) {
    const role = roles[name]
    if (!hasSheet) continue
    if (role === undefined) problems.push({ placeholder: name, message: `{{${name}}} is not a column of the loaded sheet` })
    else if (role === 'reference') problems.push({ placeholder: name, message: `{{${name}}} is a reference column and must not be sent to the model` })
    else if (role === 'metadata') problems.push({ placeholder: name, message: `{{${name}}} is a metadata column and is not sent to the model` })
    else if (role === 'output') problems.push({ placeholder: name, message: `{{${name}}} is an output column; the model produces it` })
  }
  return problems
}

export async function freezeRun(input: FreezeInput): Promise<FrozenRun> {
  const problems = templateProblems(input.itemTemplate, input.systemTemplate, input.roles, input.source !== null)
  if (problems.length) throw new Error(problems.map(p => p.message).join('; '))

  const referenced = promptPlaceholderNames(input.itemTemplate, input.systemTemplate)
  const inputColumns = new Set(columnsWithRole(input.roles, 'input'))
  const carried = input.source === null ? referenced : referenced.filter(name => inputColumns.has(name))

  const cases = input.partition.targets.map(ordinal => {
    const row = input.rows[ordinal] ?? {}
    const bindings: Record<string, string> = {}
    for (const name of carried) {
      if (Object.prototype.hasOwnProperty.call(row, name)) bindings[name] = normalizeBindingValue(row[name])
    }
    return { ordinal, label: input.label ? input.label(ordinal) : input.source ? `Row ${ordinal + 1}` : 'Input', bindings }
  })

  const constantBlock = compileConstantBlock({
    rows: input.rows,
    roles: input.roles,
    exampleOrdinals: input.partition.examples,
    itemTemplate: input.itemTemplate,
    contract: input.contract,
  })
  const constantBlockTokens = constantBlock
    ? await (input.countTokens ?? (async (text: string) => naiveTokenCount(text)))(constantBlock)
    : 0

  const contractCtx = buildContractContext(input.contract)
  const hasSystem = input.systemTemplate.trim().length > 0 || constantBlock.length > 0
  const models = input.models.map(({ model, settings }) => buildFrozenModel({
    preset: input.preset,
    baseUrl: input.baseUrl,
    model,
    shared: input.shared,
    settings,
    contract: contractCtx,
    hasSystem,
  }))

  return {
    version: 1,
    frozenAt: new Date().toISOString(),
    source: input.source,
    roles: input.roles,
    partition: input.partition,
    cases,
    systemTemplate: input.systemTemplate,
    itemTemplate: input.itemTemplate,
    constantBlock,
    constantBlockTokens,
    contract: contractCtx?.contract ?? null,
    parserId: input.parserId,
    models,
    repeats: Math.max(1, input.repeats),
    concurrency: Math.max(1, input.concurrency),
    retries: Math.max(0, input.retries),
    timeoutMs: input.timeoutMs,
  }
}

export function totalCalls(run: Pick<FrozenRun, 'cases' | 'models' | 'repeats'>): number {
  return run.cases.length * run.models.length * run.repeats
}
