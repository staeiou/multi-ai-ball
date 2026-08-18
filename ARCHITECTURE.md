# MultAIBall Architecture

One prompt (or one spreadsheet × mad-libs template) → many models, one run,
export-centric. No trials, no result persistence, no backend, no framework.

## What this document is for

Built in a workspace containing Auditomatic Lite — a Larger, older product
with the same DNA but an order of magnitude more scope (10k-call bias trials,
pivot tables, parsers, 15 IndexedDB schema versions, 136 releases, Pyodide).
This architecture exists so MultAIBall does not inherit that product's churn
modes. It is the contract: future work follows it, and a change that needs to
break it is a design discussion first.

## The auditomatic autopsy (what not to repeat)

1. **Migration churn is caused by architecture, not tooling.** Auditomatic
   ran a v1→v15 schema chain; each release edited shared tables, forcing the
   next migration. "Copy-then-switch" was an escape hatch, not a fix. The fix:
   **no feature should ever require a cross-cutting edit** — new capability =
   new module behind a narrow interface.
2. **Derived data must not be stored.** The rendered prompt is never
   persisted, edited, or round-tripped — always reconstructed from
   `(template, bindings)` at the wire edge. (Auditomatic needed a migration to
   *decompose* stored rendered prompts back into parts; we get that by
   construction.)
3. **Never define a semantic twice unless one twin is corpus-pinned.** The
   parsers are defined once as data with an executable corpus; TS and Python
   implementations both pass it. Auditomatic's byte-fidelity thrash was
   precisely "the two bundles named the same column three ways" and "the app
   decided what a placeholder was four ways".
4. **Volatile knowledge belongs in data, not code.** Catalogs, prices, and
   per-model parameter support arrive live from provider endpoints. Hardcoded
   lists are a last resort, named, and small.
5. **Never lie with 0.** Missing pricing renders `—`; unknown costs are null,
   not $0.
6. **Don't rebuild what Auditomatic maintains.** The provider parameter
   registry stays theirs. MultAIBall exposes 3 shared sampling params and
   omits unsupported ones per model from the live `supported_parameters`
   (plus a tiny named heuristic for native OpenAI reasoning models).
7. **Response fidelity anchor is the raw bytes.** Never store or re-serialize
   a re-parsed provider JSON; keep the raw text and parse only for columns.
8. **No JS engines in Python, no Pyodide.** Parsers are built-in only; the
   generated script is data you can edit by hand — that is the escape hatch
   for power users.

## Scope

In: providers (OpenAI-compat + Anthropic native; presets OpenRouter/OpenAI/
Anthropic/custom) · live pricing (OpenRouter list, LiteLLM mirror) ·
tokenizer worker + naive fallback · streaming · reasoning capture · ZDR-only
mode · budget/sort-by-cost · shared params with data-driven auto-omit ·
retries with backoff+jitter · prompt sources (single **and** spreadsheet×
template, lean prompts) · built-in parsers (JSON unstack + first/last
number/word/sentence/line + a few freebies) with Python twin · tool-call
parsing · image *responses* (no image *input*) · repeat counts · Python
reproducibility export · export CSV/JSONL/XLSX · thin PWA (manifest+icons,
no service worker).

Out (deliberately): trial/execution engine, result/run-history persistence,
image/vision input, Tauri desktop, Pyodide, user-authored parsers,
environmental costs, batch exports, multi-tab coordination, telemetry,
schema migrations (by construction), PWA service worker.

## Data model (the whole thing)

| Shape | Notes |
|---|---|
| `ProviderSpec` | family + preset + baseUrl + key. A new preset is a table row. |
| `ModelCatalogEntry` | id, name, context, `pricing`, `supportedParams`, tags. Volatile parts live. |
| `ParamOverrides` | temperature / maxTokens / topP. Shared; omission decided per model at request build. |
| `PromptTemplate` | authored text with `{{name}}` placeholders — never the rendered form. |
| `PromptBindings` | placeholder → value (spreadsheet row, or manual). |
| `CaseInput` | `{ id, label, bindings }` — one concrete input from a source. |
| `CaseSource` | produces `CaseInput[]`: `single` or `sheet`. |
| `OutputContract` | structured-output authoring → fields + schema + prose. |
| `BuiltinParser` | data: `{ id, kind: 'regex'|'json'|'text', pattern?, outputType }` + corpus id. |
| `RunSpec` | immutable snapshot of one HTTP call (incl. retry meter). |
| `CallResult` | neutral outcome: `parts` (text/image/toolCall), `thinking`, tokens, usage, cost, error, latency, rawJson. |
| `RunSnapshot` | the run for display/export: meta + specs + results. Memory-only. |

**Lean-prompt invariant** (load-bearing): nothing stores or carries a
rendered prompt. `renderPromptTemplate(template, bindings)` is pure, called at
RunSpec construction and at export only. Single-prompt mode is the same path
with zero placeholders.

## Module map

```
core/                 pure, no DOM, unit-testable in node, no cycles
  types.ts            shapes above
  template.ts         mad-libs renderer (auditomatic semantics)
  cases.ts            CaseSource → CaseInput[]; sheet parsing (CSV/XLSX via
                      SheetJS in-memory); placeholder lint
  providers.ts        FAMILY REGISTRY + presets; request build (sentinel
                      placeholders), part/stream parse, model-list parse
  contract.ts         OutputContract → fields/schema/prose; extract columns
  parsers.ts          built-in parser definitions as data + TS implementations
                      (algorithms: scanner, strict+repair, regex set)
  pricing.ts          live price resolution; cost math; formatting
  tokenizer.ts(.worker.ts)  gpt-tokenizer in a worker; naive fallback
  api.ts              runCall(spec, onProgress, signal): streaming, retry
                      policy (classify → backoff+jitter), cost from response
  run.ts              RunController: specs matrix (models × cases × repeats),
                      concurrency cap, abort, snapshot()
  py.ts               Python reproduction generator: data-script (spec
                      literals, sentinel bodies) + embedded stdlib runtime +
                      requirements.txt; PARSER twin + CORPUS embedded
  export.ts           RunSnapshot → CSV/JSONL/XLSX (app-side), shared COLUMNS
                      contract + whole-column typing (TS twin of runtime)
ui/
  dom.ts              h() only (all untrusted text as text nodes)
  grid.ts             per-call rows; live updates; markdown, thinking,
                      images, tool-call rendering
  panels.ts           static shell + region renderers (inputs own text)
  app.ts              composition root; tiny store (AppState + reducers);
                      RunController lifetime
state.ts              persistence ONLY: tolerant versioned envelope;
                      templates + settings only, never sheets/results
fixtures/
  json-parser-contract.json   the executable corpus (port of auditomatic's,
                              re-validated against BOTH implementations)
```

Dependency direction: `ui → core + state`; `core` imports stdlib only.

## Built-in parsers (no Pyodide, no user code)

Two halves, like auditomatic, but both implemented in TS for the app and
twinned in the generated Python script:

- **Extraction half** (response → object): string-aware balanced-brace
  scanner that yields only complete candidates; strict `JSON.parse` first,
  `jsonrepair` (npm) second; never completes a truncated object; NaN/Infinity
  rejected after repair; `PARSER_ERROR` sentinel when a brace-shaped candidate
  could not be parsed (distinct from `null` = no JSON present).
  - `json-unstack`: largest object by key count, ties take the later one;
    arrays not unstackable.
  - regex set: first/last number, first/last word, first/last sentence,
    first/last line, yes/no, true/false, percentage — semantics from
    auditomatic's built-ins (ported test cases).
- **Column half** (object → columns/cells): sorted dotted keys, `parsed_`
  prefix, depth cap 4, every node a column (subtree = compact JSON), array
  leaves = compact JSON, missing key = null cell. `JSON.stringify` matches
  `json.dumps(separators=(',',':'))` for these cases.
- **Fidelity**: the corpus fixture is the executable spec. The test suite
  runs the TS implementations against it in-process AND the embedded Python
  twin through `python3` (skipped if absent), so drift on either side fails
  CI. The generated script embeds the corpus and offers `--verify-parsers`
  as a self-test.
- Repair library divergence (jsonrepair vs json_repair) beyond the corpus is
  documented as the honesty boundary; the corpus is re-validated against both
  and disagreements are recorded deliberately in the fixture.

## Whole-column typing (identical both sides)

Parser results carry faithful values; whether a column is numeric/boolean is
a whole-column export decision: canonical decimal only (identifiers like
`07030` stay text), bool sets `{true,yes,1}/{false,no,0}`, `json` for
object columns, ambiguous cells → `null`. Implemented once as a spec,
twinned in `export.ts` and the Python runtime, corpus-pinned in tests.

## Python reproduction export

Pattern stolen from auditomatic, scaled down to "runs anywhere":

- **`experiment.py` is data, not logic**: Python literals for model specs
  (URL, headers, body with `{{PROMPT}}`/`{{SYSTEM_PROMPT}}`/`{{BINDINGS}}`
  sentinels — bodies constructed through the app's own `buildChatRequest`,
  so the script can never diverge from the app), template + bindings (sheet
  rows embedded, since sheets are never persisted), params, retry policy,
  contract, parser config, column contract.
- **Small stdlib runtime** embedded as a module in the generated bundle:
  `urllib` calls (non-streaming — final output identical), retries with
  jitter honoring `Retry-After`, mad-libs `fill()`, parser twin, column
  typing, CSV/JSONL writers. `requirements.txt`: `json_repair` (+`openpyxl`
  only for XLSX).
- **Byte-identical**: same request payloads (sentinel bodies), same rows,
  same ordering and escaping for CSV/JSONL (byte-identical outputs);
  XLSX cells identical by construction across writers. The fidelity test
  generates the script from a snapshot, runs it against the stub server,
  and byte-compares CSV with the app's export.
- API keys: never embedded; `--api-key` via env vars named by provider.
- The script is meant to be edited — that is the power-user escape hatch.

## Retry policy (configurable)

429 / 5xx / no-headers timeout / network-no-response → retryable; 401/400
and post-headers (billed) timeouts → terminal. Backoff: base × multiplier^
attempt, capped ~30s, full jitter, honors `Retry-After`. Attempts +
multiplier configurable in the UI; mirrored in the generated script's policy.

## Feature seams (additive by construction)

| New thing | Where it lands | Why no churn |
|---|---|---|
| New provider preset | one `ProviderSpec` row | preset table |
| New wire family (Ollama, Gemini…) | one family adapter in `providers.ts` | registry, not if-chains |
| New case source | a `CaseSource` module | contract is `CaseInput[]` |
| New content kind | a `ContentPart` variant + its cell renderer | neutral `parts` |
| New parser | data row + corpus cases + twin impl | parsers are data |
| New output field type | `contract.ts` authoring + extractor | fields are data |
| New cost source | `pricing.ts` resolver chain | one seam |
| New export format | `export.ts` renders the same rows | snapshot is the contract |
| New persistence need | a new tolerant envelope | additive fields, no migration |
| Dark mode / theming | CSS vars + one toggle | view layer only |

## Rules for future edits

- A change touching N existing modules to add one feature is a design smell —
  stop and re-seam.
- Never store/derive-from a rendered prompt; template+bindings only.
- Never add a hardcoded price/model list without a comment naming why live
  data cannot cover it.
- Never add a user-authored parser or a JS engine in generated Python; the
  script is the escape hatch, parsers stay built-in and corpus-pinned.
- Never persist sheets or results; templates and settings only.
- Never `git add -A`; stage exactly the files you changed.