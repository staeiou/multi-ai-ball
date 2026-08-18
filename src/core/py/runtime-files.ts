// The Python runner package shipped inside every generated reproduction
// bundle. Real .py files under runtime/multiaiball/, checked by Python's own
// tooling and exercised by the test suite — the exporter generates
// configuration, never runtime code, so a bug here is fixed in Python and
// cannot be introduced by string assembly.

import initSource from './runtime/multiaiball/__init__.py?raw'
import httpSource from './runtime/multiaiball/http.py?raw'
import outputSource from './runtime/multiaiball/output.py?raw'
import parsingSource from './runtime/multiaiball/parsing.py?raw'
import runnerSource from './runtime/multiaiball/runner.py?raw'
import storeSource from './runtime/multiaiball/store.py?raw'
import tasksSource from './runtime/multiaiball/tasks.py?raw'

/** Bundle-relative path to file contents. */
export const RUNTIME_PACKAGE_FILES: Readonly<Record<string, string>> = Object.freeze({
  'multiaiball/__init__.py': initSource,
  'multiaiball/http.py': httpSource,
  'multiaiball/store.py': storeSource,
  'multiaiball/tasks.py': tasksSource,
  'multiaiball/parsing.py': parsingSource,
  'multiaiball/output.py': outputSource,
  'multiaiball/runner.py': runnerSource,
})

/**
 * Everything the runner imports, kept beside the package it describes so a
 * new import cannot be added without the requirement landing in the same
 * change. Same set as the upstream runner we forked.
 */
export const RUNTIME_REQUIREMENTS: readonly string[] = Object.freeze([
  'httpx>=0.27.0',
  'aiometer>=0.5.0',
  'aiolimiter>=1.1.0',
  'aiosqlite>=0.19.0',
  'tenacity>=8.2.0',
  'tqdm>=4.66.0',
  'pandas>=2.0.0',
])