// One model's frozen request contract: preset (how to talk to the endpoint)
// + catalog model (what sources say it accepts) + the user's shared values and
// per-model settings + the output contract -> a FrozenModel whose body skeleton
// already carries every effective parameter under the endpoint's spelling.
//
// Guidance never removes anything the user asked for explicitly (an explicit
// 'schema' choice or an extras key is sent as typed); it only decides whether
// the SHARED controls apply to this model. Every decision is a ParamReport
// line so the review screen can show it and the bundle carries it.

import type {
  CatalogModel,
  FrozenModel,
  ModelSettings,
  OutputContractContext,
  ParamReport,
  ProviderPreset,
  SharedParams,
} from '../types'
import { DEFAULT_OUTPUT_LENGTH, outputLengthRequired } from './presets'
import { OWNED_KEYS, jsonObjectParam, schemaParam, skeleton } from './shapes'

type JsonRecord = Record<string, unknown>

export interface BuildInput {
  preset: ProviderPreset
  /** The endpoint's base URL: the preset's, or the user's for custom. */
  baseUrl: string
  model: CatalogModel
  shared: SharedParams
  settings: ModelSettings
  contract: OutputContractContext | null
  /** Whether any call will carry a system channel (template or constant block). */
  hasSystem: boolean
}

export function buildHeaders(preset: ProviderPreset): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...preset.headers }
  if (preset.auth.kind === 'bearer') headers.Authorization = 'Bearer {{API_KEY}}'
  else if (preset.auth.header) headers[preset.auth.header] = '{{API_KEY}}'
  return headers
}

/** Merge a parameter object into the body one level deep, so two params that
 * share a container (Anthropic's output_config.effort and .format) coexist. */
function mergeInto(body: JsonRecord, param: JsonRecord): void {
  for (const [key, value] of Object.entries(param)) {
    const existing = body[key]
    if (existing && typeof existing === 'object' && !Array.isArray(existing) && value && typeof value === 'object' && !Array.isArray(value)) {
      body[key] = { ...(existing as JsonRecord), ...(value as JsonRecord) }
    } else {
      body[key] = value
    }
  }
}

function setPath(target: JsonRecord, path: readonly string[], value: unknown): void {
  let current = target
  for (const key of path.slice(0, -1)) {
    const existing = current[key]
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) current[key] = {}
    current = current[key] as JsonRecord
  }
  current[path[path.length - 1]!] = value
}

export function buildFrozenModel(input: BuildInput): FrozenModel {
  const { preset, model, shared, settings, contract } = input
  const g = model.guidance
  const body = skeleton(preset.shape, model.id, input.hasSystem)
  const report: ParamReport[] = []

  // Output length: always Basic. The spelling is the endpoint's, or the one
  // the model lists on OpenRouter. Clamped to a reported ceiling.
  const lengthName = g.outputLengthName ?? preset.outputLengthName
  let length = shared.outputLength
  if (length === null && outputLengthRequired(preset)) length = DEFAULT_OUTPUT_LENGTH
  if (length !== null && g.outputLimit.value !== null && length > g.outputLimit.value) {
    report.push({ param: lengthName, sent: true, value: g.outputLimit.value, reason: `clamped from ${length} to the model's reported output ceiling`, source: g.outputLimit.source })
    length = g.outputLimit.value
  } else if (length !== null) {
    report.push({ param: lengthName, sent: true, value: length, reason: shared.outputLength === null ? 'required by this endpoint; default used' : 'set', source: g.outputLengthName ? 'openrouter-live' : 'assumed' })
  } else {
    report.push({ param: lengthName, sent: false, reason: 'not set; the endpoint default applies', source: 'user' })
  }
  if (length !== null) body[lengthName] = length

  // Temperature: sent only where a source says this model accepts it.
  if (shared.temperature === null) {
    report.push({ param: 'temperature', sent: false, reason: 'not set', source: g.temperature.source })
  } else if (g.temperature.value === true) {
    body.temperature = shared.temperature
    report.push({ param: 'temperature', sent: true, value: shared.temperature, reason: 'model reported to accept it', source: g.temperature.source })
  } else if (g.temperature.value === false) {
    report.push({ param: 'temperature', sent: false, reason: 'model reported to accept only its default', source: g.temperature.source })
  } else {
    report.push({ param: 'temperature', sent: false, reason: 'nothing known about this model; not sent', source: g.temperature.source })
  }

  // Reasoning effort. The shared control is relative ("less" / "more") and is
  // mapped to each model's own list (lowest / highest); an exact level is sent
  // where the model lists it. Default sends nothing.
  const efforts = g.effortValues.value
  if (shared.effort === null) {
    report.push({ param: 'effort', sent: false, reason: 'not set; the model decides how long to think', source: g.effortValues.source })
  } else if (!preset.effortPath) {
    report.push({ param: 'effort', sent: false, reason: 'this endpoint has no effort control', source: 'assumed' })
  } else if (!efforts || efforts.length === 0) {
    report.push({ param: preset.effortPath.join('.'), sent: false, reason: 'this model is not reported to have a thinking-effort control', source: g.effortValues.source })
  } else {
    const level = shared.effort === 'less' ? efforts[0]! : shared.effort === 'more' ? efforts[efforts.length - 1]! : efforts.includes(shared.effort) ? shared.effort : null
    if (level === null) {
      report.push({ param: preset.effortPath.join('.'), sent: false, reason: `model lists ${efforts.join('/')}, not ${shared.effort}`, source: g.effortValues.source })
    } else {
      setPath(body, preset.effortPath, level)
      const why = shared.effort === 'less' ? `"less thinking" = this model's lowest level (${efforts.join('/')})` : shared.effort === 'more' ? `"more thinking" = this model's highest level (${efforts.join('/')})` : 'listed among the model\'s effort values'
      report.push({ param: preset.effortPath.join('.'), sent: true, value: level, reason: why, source: g.effortValues.source })
    }
  }

  // Response format: the one control that stands in for a parameter whose
  // spelling differs per endpoint. Prose instructions are in the constant
  // block regardless; this decides whether the schema parameter also goes.
  const choice = settings.responseFormat ?? shared.responseFormat
  const formatParam = preset.structuredOutput ? `${preset.structuredOutput} (JSON schema)` : 'response format'
  if (choice === 'none') {
    report.push({ param: formatParam, sent: false, reason: 'not requested', source: 'user' })
  } else if (choice === 'json_object') {
    const param = jsonObjectParam(preset.shape)
    if (param) {
      mergeInto(body, param)
      report.push({ param: 'response_format (JSON object)', sent: true, value: 'json_object', reason: 'requested', source: 'user' })
    } else {
      report.push({ param: 'response_format (JSON object)', sent: false, reason: 'this endpoint has no JSON-object mode; prose instructions still sent', source: 'assumed' })
    }
  } else if (!contract) {
    report.push({ param: formatParam, sent: false, reason: 'no output fields defined', source: 'user' })
  } else if (!preset.structuredOutput) {
    report.push({ param: formatParam, sent: false, reason: 'this endpoint has no schema mode; prose instructions still sent', source: 'assumed' })
  } else if (choice === 'schema') {
    mergeInto(body, schemaParam(preset.shape, contract.name, contract.schema))
    report.push({ param: formatParam, sent: true, reason: 'requested for this model', source: 'user' })
  } else if (g.structuredOutput.value === true) {
    mergeInto(body, schemaParam(preset.shape, contract.name, contract.schema))
    report.push({ param: formatParam, sent: true, reason: 'model reported to support JSON schema', source: g.structuredOutput.source })
  } else if (g.structuredOutput.value === false) {
    report.push({ param: formatParam, sent: false, reason: 'model reported not to support JSON schema; prose instructions still sent', source: g.structuredOutput.source })
  } else {
    report.push({ param: formatParam, sent: false, reason: 'nothing known about this model; prose instructions still sent (choose "JSON schema" per model to force it)', source: g.structuredOutput.source })
  }

  // OpenRouter routing block. require_parameters on by default: the router
  // then refuses (404) instead of forwarding a request it would otherwise trim.
  if (preset.routing) {
    const routing = settings.routing ?? { requireParameters: true, zdr: false }
    const block: JsonRecord = { require_parameters: routing.requireParameters }
    if (routing.zdr) block.zdr = true
    if (routing.order?.length) block.order = routing.order
    if (routing.only?.length) block.only = routing.only
    if (routing.ignore?.length) block.ignore = routing.ignore
    if (routing.allowFallbacks !== undefined) block.allow_fallbacks = routing.allowFallbacks
    body.provider = block
    report.push({ param: 'provider', sent: true, value: block, reason: routing.requireParameters ? 'OpenRouter routes only to sub-providers accepting every parameter' : 'OpenRouter may drop parameters a sub-provider lacks', source: 'user' })
  }

  // Extras: merged last, literally. Structural keys are refused.
  const owned = OWNED_KEYS[preset.shape]
  for (const [key, value] of Object.entries(settings.extras ?? {})) {
    if (owned.includes(key)) {
      report.push({ param: key, sent: false, reason: 'structural key owned by the app; not sent', source: 'user' })
      continue
    }
    const overrode = key in body
    body[key] = value
    report.push({ param: key, sent: true, value, reason: overrode ? 'your extra overrides the shared control' : 'your extra, sent as typed', source: 'user' })
  }

  return {
    provider: preset.id,
    id: model.id,
    url: `${input.baseUrl}${preset.chatPath}`,
    headers: buildHeaders(preset),
    body,
    report,
    guidance: g,
  }
}
