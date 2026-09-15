// The Python reproduction bundle: the frozen run as data, the projected cases
// as CSV, a ten-line experiment.py, and the runtime package. Python never
// re-derives anything the browser decided: the constant block, the partition,
// the body skeletons and the effective parameters arrive verbatim, and the
// runtime substitutes the two sentinels exactly as render.ts does.

import JSZip from 'jszip'

import corpus from '../fixtures/json-parser-contract.json'
import { builtinParserById } from './parsers'
import { PRESETS } from './providers/presets'
import { toDelimited } from './export'
import type { ExportRow } from './export'
import { RUNTIME_PACKAGE_FILES, RUNTIME_REQUIREMENTS } from './py/runtime-files'
import type { FrozenRun } from './types'

export interface ExperimentJson {
  format: 'multiaiball-experiment'
  version: 1
  name: string
  run: Omit<FrozenRun, 'cases'> & { casesFile: string; caseCount: number }
  /** provider id -> environment variable holding its key. */
  apiKeyEnv: Record<string, string>
  parser: ReturnType<typeof builtinParserById> | null
  parserCorpus: typeof corpus.cases | null
}

export function generateExperimentJson(run: FrozenRun, name: string): ExperimentJson {
  const { cases, ...rest } = run
  const parser = run.parserId ? builtinParserById(run.parserId) ?? null : null
  return {
    format: 'multiaiball-experiment',
    version: 1,
    name,
    run: { ...rest, casesFile: 'cases.csv', caseCount: cases.length },
    apiKeyEnv: Object.fromEntries(PRESETS.map(p => [p.id, p.auth.envVar])),
    parser: parser ? { ...parser, unstackJson: parser.id === 'json-unstack' } as typeof parser : null,
    parserCorpus: parser?.kind === 'json' ? corpus.cases : null,
  }
}

/** ordinal, label, then every binding column in first-seen order. */
export function generateCasesCsv(run: FrozenRun): string {
  const bindingColumns: string[] = []
  for (const c of run.cases) for (const key of Object.keys(c.bindings)) if (!bindingColumns.includes(key)) bindingColumns.push(key)
  const columns = [{ key: 'ordinal', label: 'ordinal' }, { key: 'label', label: 'label' }, ...bindingColumns.map(name => ({ key: `b:${name}`, label: name }))]
  const rows: ExportRow[] = run.cases.map(c => {
    const row: ExportRow = { ordinal: c.ordinal, label: c.label }
    for (const name of bindingColumns) row[`b:${name}`] = Object.prototype.hasOwnProperty.call(c.bindings, name) ? c.bindings[name]! : null
    return row
  })
  return toDelimited(rows, columns, ',')
}

export function generateExperimentPy(name: string): string {
  return [
    '#!/usr/bin/env python3',
    `"""${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')} -- reproduction of a MultAIBall run.`,
    '',
    'experiment.json holds the frozen run: templates, the compiled examples and',
    'output-format block, every model with its request body already carrying the',
    'effective parameters, repeats and retries. cases.csv holds the rows that were',
    'run, with only the columns the templates use. Nothing is recomputed here;',
    'this script substitutes each row into the same body the browser sent.',
    '',
    'Run:          python experiment.py',
    'Formats:      --output csv|tsv|json|jsonl|excel|parquet',
    'Pacing:       --concurrent 10 --rate-limit 5 --timeout 90',
    'Continue:     --resume --db-file results_<timestamp>.db',
    'Self-test:    --verify-parsers',
    '',
    'API keys come from the environment (see apiKeyEnv in experiment.json).',
    '"""',
    'from multiaiball.frozen import main',
    '',
    'if __name__ == "__main__":',
    '    main("experiment.json", "cases.csv")',
    '',
  ].join('\n')
}

export function generateRequirements(parserKind: string | null): string {
  const lines = [
    '# MultAIBall reproduction requirements',
    '# Install with: pip install -r requirements.txt',
    '',
    '# Core dependencies (required)',
    ...RUNTIME_REQUIREMENTS,
    '',
    '# Optional dependencies for export formats',
    'openpyxl>=3.1.0    # For Excel export (.xlsx)',
    'pyarrow>=12.0.0    # For Parquet export (.parquet)',
  ]
  if (parserKind === 'json') lines.push('', '# Required by the JSON parser twin (syntactically broken JSON recovery)', 'json-repair>=0.25.0')
  return `${lines.join('\n')}\n`
}

export function generateReadme(run: FrozenRun, name: string): string {
  const calls = run.cases.length * run.models.length * run.repeats
  return [
    `# ${name}`,
    '',
    `Frozen ${run.frozenAt}. ${run.cases.length} cases × ${run.models.length} models × ${run.repeats} repeat(s) = ${calls} calls.`,
    '',
    '## Files',
    '',
    '- `experiment.json`: the frozen run. `run.models[i].body` is the exact request body sent for model i, with `{{SYSTEM}}` and `{{PROMPT}}` where the rendered channels go; `run.models[i].report` says, per parameter, what was sent and why.',
    '- `cases.csv`: the rows that were run (`ordinal` is the 0-based row in the original sheet), with only the columns the templates reference.',
    '- `experiment.py`: runs it. `multiaiball/`: the runtime.',
    '',
    '## How a call is built',
    '',
    'For case c and model m: prompt = `run.itemTemplate` with `{{column}}` placeholders filled from the case; system = `run.systemTemplate` filled the same way, then a blank line, then `run.constantBlock` (the worked examples and output-format instructions, identical for every call). The two strings replace the sentinels in `run.models[m].body`. That body is sent to `run.models[m].url` with `run.models[m].headers` (`{{API_KEY}}` from the environment).',
    '',
    `Source: ${run.source ? `${run.source.name} (${run.source.rowCount} rows, sha256 ${run.source.sha256})` : 'a single prompt or a variable sweep'}.`,
    '',
  ].join('\n')
}

export async function buildBundleZip(run: FrozenRun, name = 'MultAIBall run'): Promise<Blob> {
  const zip = new JSZip()
  const experiment = generateExperimentJson(run, name)
  zip.file('experiment.json', JSON.stringify(experiment, null, 2))
  zip.file('cases.csv', generateCasesCsv(run))
  zip.file('experiment.py', generateExperimentPy(name))
  zip.file('requirements.txt', generateRequirements(experiment.parser?.kind ?? null))
  zip.file('README.md', generateReadme(run, name))
  for (const [path, source] of Object.entries(RUNTIME_PACKAGE_FILES)) zip.file(path, source)
  return zip.generateAsync({ type: 'blob' })
}

export const ZIP_MIME = 'application/zip'
