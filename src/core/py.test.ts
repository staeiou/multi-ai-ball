import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { freezeRun, totalCalls } from './freeze'
import { inferPartition } from './partition'
import { presetById } from './providers/presets'
import { generateCasesCsv, generateExperimentJson, generateExperimentPy } from './py'
import { canonicalJson, coordinateAt, renderCall } from './render'
import { CLAUDE_LIKE, GPT_LIKE, ROLES, ROWS } from './testing/fixtures'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const runtimeDir = join(root, 'src', 'core', 'py', 'runtime')
const scratch = join(root, 'tmp', 'py-parity')

function hasPython(): boolean {
  try { execFileSync('python3', ['-c', 'import sys; sys.exit(0)'], { stdio: 'ignore' }); return true } catch { return false }
}

const pythonAvailable = hasPython()

async function frozen(provider: 'openai' | 'anthropic') {
  const rows = [...ROWS, { id: 'A6', text: 'Quotes "inside" and unicode é 日本, braces {{not a placeholder}} and a\nnewline', source: 'x', frame: '', score: '' }]
  return freezeRun({
    preset: presetById(provider),
    baseUrl: presetById(provider).baseUrl,
    source: { name: 'articles.csv', bytes: 1, sha256: 'x', rowCount: rows.length },
    rows,
    roles: ROLES,
    partition: inferPartition(rows, ROLES),
    systemTemplate: 'You code {{text}} frames.',
    itemTemplate: 'Article: {{text}}',
    contract: { fields: [{ name: 'frame', type: 'enum', values: ['economic', 'civic'] }, { name: 'score', type: 'integer' }] },
    parserId: 'json-unstack',
    models: [{ model: provider === 'openai' ? GPT_LIKE : CLAUDE_LIKE, settings: { extras: { top_p: 0.9 } } }],
    shared: { outputLength: 300, temperature: 0.5, effort: 'low', responseFormat: 'auto' },
    repeats: 2,
    concurrency: 3,
    retries: 1,
    timeoutMs: 1000,
  })
}

describe.skipIf(!pythonAvailable)('INVARIANT 3: the Python bundle builds the same bodies as the browser', () => {
  for (const provider of ['openai', 'anthropic'] as const) {
    it(`${provider}: every coordinate's body matches after canonical JSON, and the task count matches`, async () => {
      const run = await frozen(provider)
      const dir = join(scratch, provider)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'experiment.json'), JSON.stringify(generateExperimentJson(run, 'parity')))
      writeFileSync(join(dir, 'cases.csv'), generateCasesCsv(run))
      const total = totalCalls(run)
      const indices = Array.from({ length: total }, (_, i) => String(i))
      const script = `
import sys, json
sys.path.insert(0, sys.argv[1])
from multiaiball import frozen
exp = frozen.load_experiment(sys.argv[2]); cases = frozen.load_cases(sys.argv[3])
tasks = list(frozen.FrozenTasks(exp["run"], cases))
print(len(tasks) * len(exp["run"]["models"]))
for i in sys.argv[4:]:
    print(frozen.canonical(frozen.body_for(exp, cases, int(i))))
`
      const out = execFileSync('python3', ['-c', script, runtimeDir, join(dir, 'experiment.json'), join(dir, 'cases.csv'), ...indices], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }).trim().split('\n')
      expect(Number(out[0])).toBe(total)
      for (let index = 0; index < total; index++) {
        const browser = canonicalJson(renderCall(run, coordinateAt(run, index)).body)
        expect(out[index + 1]).toBe(browser)
      }
    })
  }

  it('experiment.py compiles', () => {
    execFileSync('python3', ['-c', 'import py_compile, sys, tempfile, os\nfd, p = tempfile.mkstemp(suffix=".py"); os.write(fd, sys.argv[1].encode()); os.close(fd); py_compile.compile(p, doraise=True)', generateExperimentPy('x "quoted"')], { stdio: 'pipe' })
  })
})
