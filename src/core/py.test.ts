import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

import { generateExperimentPy, generateRequirements, toPythonLiteral } from './py'
import { presetById } from './providers'
import type { RunMeta, RunSpec } from './types'

const META: RunMeta = {
  ts: '2026-08-17T10:35:00.000Z',
  providerId: 'openrouter',
  providerLabel: 'OpenRouter',
  promptTemplate: 'Classify: {{text}}',
  systemTemplate: 'Be terse.',
  contract: null,
  parserId: 'json-unstack',
  repeats: 2,
}

function specs(): RunSpec[] {
  const openrouter = presetById('openrouter')
  return [{
    provider: openrouter.provider,
    apiKey: '',
    model: 'openai/gpt-4o-mini',
    supportedParams: ['max_tokens', 'temperature'],
    params: { temperature: 0.4, maxTokens: 128 },
    prompt: 'Classify: refund',
    system: 'Be terse.',
    stream: false,
    zdr: false,
    caseLabel: 'Row 1',
    bindings: { text: 'refund' },
    repeatIndex: 0,
  }]
}

describe('toPythonLiteral', () => {
  it('never rewrites strings and emits Python literals', () => {
    expect(toPythonLiteral({ a: 'verified: false', b: [1, 2.5, null, true], c: ': null' })).toBe(
      `{\n    "a": "verified: false",\n    "b": [\n        1,\n        2.5,\n        None,\n        True\n    ],\n    "c": ": null"\n}`,
    )
  })
})

describe('generateExperimentPy', () => {
  it('emits sentinel bodies and embedded rows', () => {
    const py = generateExperimentPy({ name: 'test', meta: META, specs: specs(), parser: null })
    expect(py).toContain('from multiaiball import run, RetryPolicy, RowsTasks')
    expect(py).toContain('"Authorization": "Bearer {{API_KEY}}"')
    expect(py).toContain('{{PROMPT}}')
    expect(py).toContain('{{SYSTEM_PROMPT}}')
    expect(py).toContain('"provider": "openrouter"')
    expect(py).toContain('"text": "refund"')
    expect(py).toContain('max_retries=2')
  })

  it('embeds the parser corpus when a JSON parser is configured', () => {
    const py = generateExperimentPy({ name: 'test', meta: META, specs: specs(), parser: { id: 'json-unstack', name: 'JSON Object (Unstack to Columns)', kind: 'json', outputType: 'json' } })
    expect(py).toContain('PARSER_CORPUS = [')
    expect(py).toContain('--verify-parsers')
  })

  it('produces syntactically valid Python (py_compile)', () => {
    const py = generateExperimentPy({ name: 'test', meta: META, specs: specs(), parser: null })
    execFileSync('python3', ['-c', `import py_compile, sys\nimport tempfile, os\nfd, path = tempfile.mkstemp(suffix='.py')\nos.write(fd, sys.argv[1].encode())\nos.close(fd)\npy_compile.compile(path, doraise=True)\nprint('OK')\n`, py], { stdio: 'pipe' })
  })
})

describe('generateRequirements', () => {
  it('adds json-repair only when the parser needs it', () => {
    expect(generateRequirements({ id: 'json-unstack', name: '', kind: 'json', outputType: 'json' })).toContain('json-repair>=0.25.0')
    expect(generateRequirements({ id: 'first-number', name: '', kind: 'regex', outputType: 'number', pattern: 'x', captureGroup: 1 })).not.toContain('json-repair')
  })
})