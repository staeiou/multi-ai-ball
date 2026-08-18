// Python reproduction export. The generated experiment.py is DATA, not
// logic: model specs (URL, headers, body with {{PROMPT}}/{{SYSTEM_PROMPT}}
// sentinels — bodies built through the app's own builder so the script can
// never diverge from the app), template + bindings (sheet rows embedded,
// since sheets are never persisted), retry policy, parser config, corpus.
// The runtime package (runtime/multiaiball/) ships alongside; it is real
// Python maintained as files, exercised by the test suite.
//
// The script is meant to be edited — that is the power-user escape hatch.

import JSZip from 'jszip'

import corpus from '../fixtures/json-parser-contract.json'
import { buildChatRequestBody, resolvedParams } from './providers'
import type { BuiltinParserDef, ProviderRuntime, RunMeta, RunSpec } from './types'
import { RUNTIME_PACKAGE_FILES, RUNTIME_REQUIREMENTS } from './py/runtime-files'

export interface PyExportInput {
  name: string
  meta: RunMeta
  specs: RunSpec[]
  parser: BuiltinParserDef | null
}

// --- Python literals (walk values; strings never patched) --------------------

const INDENT = '    '

export function toPythonLiteral(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'None'
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const inner = INDENT.repeat(depth + 1)
    const body = value.map(item => `${inner}${toPythonLiteral(item, depth + 1)}`).join(',\n')
    return `[\n${body}\n${INDENT.repeat(depth)}]`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length === 0) return '{}'
    const inner = INDENT.repeat(depth + 1)
    const body = keys.map(key => `${inner}${JSON.stringify(key)}: ${toPythonLiteral(record[key], depth + 1)}`).join(',\n')
    return `{\n${body}\n${INDENT.repeat(depth)}}`
  }
  return JSON.stringify(String(value))
}

function docstringSafe(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// --- model entry (mirrors their resolveModel) --------------------------------

function modelEntry(spec: RunSpec, index: number): Record<string, unknown> {
  const provider: ProviderRuntime = spec.provider
  const headers: Record<string, string> = { ...provider.headers }
  if (provider.auth.type === 'bearer') headers.Authorization = 'Bearer {{API_KEY}}'
  else if (provider.auth.type === 'header' && provider.auth.header) headers[provider.auth.header] = '{{API_KEY}}'

  const transform = provider.responseTransform
  const extractPaths = [
    ...(transform?.contentPath ? [transform.contentPath] : []),
    ...(transform?.fallbackPaths ?? []),
  ]
  const reasoningPaths = [
    ...(transform?.reasoningPath ? [transform.reasoningPath] : []),
    ...(transform?.reasoningFallbackPaths ?? []),
  ]

  return {
    config_index: index,
    name: spec.model,
    display_name: spec.model,
    provider: provider.group,
    api_key_env: provider.auth.type === 'none' ? null : (provider.auth.envVar ?? null),
    url: `${provider.api.baseUrl}${provider.api.endpoint}`,
    headers,
    body: buildChatRequestBody(provider, spec.model, resolvedParams(spec), '{{PROMPT}}', '{{SYSTEM_PROMPT}}', { stream: false, zdr: spec.zdr }),
    parameters: resolvedParams(spec),
    extract_paths: extractPaths.length ? extractPaths : ['response'],
    reasoning_paths: reasoningPaths,
  }
}

// --- parser + corpus ----------------------------------------------------------

function parserLiteral(parser: BuiltinParserDef | null): string {
  if (!parser) return 'None'
  return toPythonLiteral({
    ...parser,
    unstackJson: parser.id === 'json-unstack',
  })
}

// --- generation ----------------------------------------------------------------

export function generateExperimentPy(input: PyExportInput): string {
  const { meta, specs, parser } = input
  const usesJsonParser = parser?.kind === 'json'

  const retryMax = 2
  const rows = specs.map((spec, index) => ({
    ...spec.bindings,
    __case: spec.caseLabel,
    __repeat: spec.repeatIndex + 1,
    __model: spec.model,
    __index: index,
  }))

  const body = [
    '#!/usr/bin/env python3',
    `"""${docstringSafe(input.name)} -- reproduction of a MultAIBall run.`,
    '',
    `Run it:      python experiment.py`,
    `Formats:     --output csv|tsv|json|jsonl|excel|parquet`,
    `Pacing:      --concurrent 10 --rate-limit 5 --timeout 90`,
    `Continue:    --resume --db-file results_<timestamp>.db`,
    `Self-test:   --verify-parsers${usesJsonParser ? ' (checks the JSON parser twin against its corpus)' : ''}`,
    '',
    'Keys are read from the environment; see the api_key_env fields below.',
    'Everything below is data you can edit.',
    '"""',
    'import sys',
    '',
    'from multiaiball import run, RetryPolicy, RowsTasks',
    '',
    '# How hard to try each call. MAX_RETRIES counts retries, so 2 means up to',
    '# three attempts, with jittered exponential backoff between them.',
    `RETRIES = RetryPolicy(max_retries=${retryMax}, backoff_min=1, backoff_max=30)`,
    '',
    `PROMPT_TEMPLATE = ${toPythonLiteral(meta.promptTemplate)}`,
    `SYSTEM_PROMPT = ${toPythonLiteral(meta.systemTemplate || null)}`,
    `REPEATS = ${meta.repeats}`,
    '',
    `ROWS = ${toPythonLiteral(rows)}`,
    '',
    `MODELS = ${toPythonLiteral(specs.map((spec, index) => modelEntry(spec, index)))}`,
    `PARSER = ${parserLiteral(parser)}`,
    ...(usesJsonParser ? [`PARSER_CORPUS = ${toPythonLiteral(corpus.cases)}`] : ['PARSER_CORPUS = None']),
    '',
    'if __name__ == "__main__":',
    '    if "--verify-parsers" in sys.argv and PARSER_CORPUS:',
    '        from multiaiball.parsing import verify_corpus',
    '        verify_corpus(PARSER_CORPUS)',
    '        sys.exit(0)',
    '    run(MODELS, RowsTasks(PROMPT_TEMPLATE, ROWS, system_prompt=SYSTEM_PROMPT, repeats=REPEATS),',
    '        parser=PARSER, policy=RETRIES)',
    '',
  ]
  return body.join('\n')
}

// --- requirements ---------------------------------------------------------------

export function generateRequirements(parser: BuiltinParserDef | null): string {
  const groups: string[] = [
    '# Core dependencies (required)',
    ...RUNTIME_REQUIREMENTS,
    '',
    '# Optional dependencies for export formats',
    'openpyxl>=3.1.0    # For Excel export (.xlsx)',
    'pyarrow>=12.0.0    # For Parquet export (.parquet)',
  ]
  if (parser?.kind === 'json') {
    groups.push('', '# Required by the JSON parser twin (syntactically broken JSON recovery)', 'json-repair>=0.25.0')
  }
  return `# MultAIBall reproduction requirements\n# Install with: pip install -r requirements.txt\n\n${groups.join('\n')}\n`
}

// --- bundle --------------------------------------------------------------------

export async function buildBundleZip(input: PyExportInput): Promise<Blob> {
  const zip = new JSZip()
  zip.file('experiment.py', generateExperimentPy(input))
  zip.file('requirements.txt', generateRequirements(input.parser))
  for (const [path, source] of Object.entries(RUNTIME_PACKAGE_FILES)) {
    zip.file(path, source)
  }
  return zip.generateAsync({ type: 'blob' })
}

export const ZIP_MIME = 'application/zip'