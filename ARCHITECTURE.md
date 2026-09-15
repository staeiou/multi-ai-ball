# MultAIBall architecture

Short map, kept accurate. Why things are the way they are is in
`FULL-CONTEXT-20260913.md` (the product, users, promise, measurements) and
`WORKLOG.md` (every decision since, with the options that were on the table).
Nothing in a comment is evidence; the tests named below are.

## The one promise

Once a run is frozen, every call's request body is exactly what the frozen run
says, whether the browser sends it now or the Python bundle sends it later,
and responses are processed the same way. Not promised: identical stochastic
outputs, what a provider does behind its own edge, export bytes.

## Data flow

```
rows + roles  ──partition──▶  examples / targets / ambiguous
                                     │
templates + contract + examples ──freeze──▶  FrozenRun
                                                │  cases (targets, referenced input columns only)
                                                │  constantBlock (examples + output-format prose, once)
                                                │  models[i].body (skeleton with {{SYSTEM}}/{{PROMPT}},
                                                │                  every effective parameter placed)
                                                ▼
                    coordinate (case, model, repeat) ──render──▶ body string ──fetch──▶ CallRow
                                                                      │                    │
                                                                      └── same in Python ──┘  (frozen.py)
```

`src/core/`:

| file | owns |
|---|---|
| `types.ts` | every shape; `FrozenRun`, `CallRow`, `ModelGuidance` |
| `partition.ts` | roles, sparsity partition |
| `examples.ts` | the constant block (fixed layout) |
| `freeze.ts` | `freezeRun`, `templateProblems`, `totalCalls` |
| `render.ts` | `renderCall`, `coordinateAt`, `canonicalJson`, `sha256Hex` |
| `providers/presets.ts` | the four endpoint contracts (URL, auth, spellings); never per model |
| `providers/shapes.ts` | the two wire shapes: skeleton, sentinel substitution, response reading |
| `providers/guidance.ts` | per-model advice from each provider's own authority; `exceptions.json` above it |
| `providers/build.ts` | preset + model + shared values + settings → `FrozenModel` with a `ParamReport` |
| `catalog.ts` | one fetch per provider → `CatalogModel[]` |
| `api.ts` | one call: send the rendered string, retry, read through the shape |
| `run.ts` | bounded pool over coordinates; pause, cancel, subset (rerun) |
| `parsers.ts` | built-in parsers, corpus-pinned twin with `parsing.py` |
| `export.ts` | long table, completed datasets, CSV/JSONL/XLSX |
| `py.ts` + `py/runtime/` | the bundle: experiment.json + cases.csv + runtime |
| `runstore.ts` | IndexedDB: frozen run at freeze, one row per completed call |
| `cases.ts` | sheet parsing (in `sheet.worker.ts`), Cartesian sweep |

`src/ui/`: `store.ts` (one store, `update()` saves and notifies), `model.ts`
(derived state and gates), `actions.ts` (everything a screen may ask for),
`screens/*` (six screens), `app.ts` (composition, 80 lines).

## Providers, in one paragraph

Two wire shapes (Chat Completions, Anthropic Messages), four presets (OpenAI,
Anthropic, OpenRouter, custom). Four shared controls: output length,
temperature, reasoning effort, response format, plus a per-model key/value
box. Whether a shared control applies to a model is *guidance*: OpenRouter's
catalog for OpenRouter's models, Anthropic's `/v1/models` capability tree for
Anthropic (models.dev for temperature, which the tree lacks), models.dev for
OpenAI (whose list is ids only), assumed for custom. Guidance decides what the
shared controls do; it never removes anything the user asked for explicitly,
and a provider 400 is a result, kept raw. `exceptions.json` is hand-written,
carries a note and an expiry per entry, and starts empty. There are no
per-model rules in code. `scripts/probe/` sends the app's own bodies to real
endpoints to answer questions the catalogs cannot.

## Executable invariants

- `freeze.test.ts` INVARIANT 1: no reference-column value in any rendered body.
- `run.test.ts` INVARIANT 2: the string `fetch` receives is `renderCall(...).bodyString`; its SHA-256 is on the row.
- `py.test.ts` INVARIANT 3: Python's `body_for(index)` equals the browser's body after canonical JSON for every coordinate; task counts match.
- `parsers-python.test.ts`: the Python parser twin passes the same corpus.
- `tests/e2e/app.spec.ts`: seven flows against `dev/stub-server.mjs`.
- `tests/e2e/live.spec.ts` (opt-in, keyed): one refusing model per provider, temperature omitted per guidance, run answers.

## Rules

- Never store a rendered prompt per call; the frozen run plus a coordinate regenerates it.
- Never encode a per-model fact in code. Guidance or `exceptions.json`, with provenance.
- Never rewrite a user's value. Omit and say why, or send and show the 400.
- Python never re-derives what the browser decided.
- Dependencies over rolled-own code; no machinery for a broader product than this one.
- Never `git add -A`; stage exactly the files you changed.
