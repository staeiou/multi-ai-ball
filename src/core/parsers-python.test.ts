import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeDir = join(root, 'core', 'py', 'runtime')
const fixture = join(root, 'fixtures', 'json-parser-contract.json')

function hasPython(): boolean {
  try {
    execFileSync('python3', ['-c', 'import sys; sys.exit(0)'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function hasJsonRepair(): boolean {
  try {
    execFileSync('python3', ['-c', 'import json_repair'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const pythonAvailable = hasPython()

// The executable spec for the Python twin: run the runtime's builtin parser
// against the same corpus the TS core passes. Requires python3 (and
// json-repair for the recovery cases); skipped when either is absent.
describe.skipIf(!pythonAvailable)('python twin against the corpus', () => {
  it.runIf(pythonAvailable && hasJsonRepair())('matches the TS extraction half on every agreed case', () => {
    const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('parsing_twin', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
corpus = json.load(open(sys.argv[2]))['cases']
skipped = {'NaN literal','Infinity literal','integer beyond 2^53','python literals'}
fail = []
for c in corpus:
    if c['name'] in skipped: continue
    got = m.apply_builtin({'id':'json-unstack','kind':'json'}, c['response'])
    if got != c['parsed']: fail.append([c['name'], c['parsed'], repr(got)])
print(json.dumps(fail))
`
    const out = execFileSync('python3', ['-c', script, join(runtimeDir, 'multiaiball', 'parsing.py'), fixture], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    })
    expect(JSON.parse(out) as unknown[]).toEqual([])
  })
})