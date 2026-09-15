# MultAIBall

Run one question, a sweep of variations, or a whole spreadsheet across many language models, from your browser, and get the answers back as a spreadsheet. Made for people who know rows and columns and do not want to learn what an API payload is. Every run also downloads as a small Python project that reproduces it exactly, for the reviewer who does.

There is no server. Your API key goes from your browser straight to the provider you chose and nowhere else. Runs are saved in your browser as they progress, so a closed tab loses nothing; exports are files you keep.

## What you can do

**Ask one question of many models.** Type it, pick models, run, compare the answers side by side.

**Fill in a spreadsheet.** Upload an Excel or CSV file. The app looks at it and proposes which column the model should read and which column it should fill in; you check two boxes and write one instruction ("Decide which frame this article uses and give a confidence from 1 to 5"). Rows you have already filled in are shown to the model as examples of what you want; the blank rows get filled in. Every other column stays untouched and is never sent anywhere. You get your spreadsheet back with the answers in place, one sheet per model.

**Vary a prompt systematically.** Write a prompt with blanks like `{{name}}`, give each blank a list of values, and every combination is asked. Hold a résumé constant and vary the name and hometown.

In every case the app tells you, before you spend anything, exactly how many calls it will make, roughly what they will cost, and what the first request looks like word for word. Afterwards, every answer can be opened to see the exact request that produced it.

## Providers and models

Four ways to reach models, one at a time per run:

- **OpenRouter**, which routes to hundreds of models from many vendors with one key. Its own catalog says what each model accepts, and the app sends `require_parameters` so OpenRouter refuses rather than silently trims a request.
- **OpenAI** directly.
- **Anthropic** directly.
- **Any server that speaks the OpenAI Chat Completions format**: Ollama, vLLM, llama.cpp, LM Studio, a lab proxy. Paste the base URL; a key is optional.

The app never guesses what a model accepts from its name. Whether a model takes a temperature, has a thinking-effort dial, or enforces a JSON schema comes from that provider's own catalog (OpenRouter, Anthropic) or from the open [models.dev](https://models.dev) registry (for OpenAI, whose catalog lists only ids), and the "Check & run" screen shows, per model and per setting, what will be sent and where that decision came from. When the information is missing, the setting is left off and the screen says so. A provider that rejects a request produces a visible error on that row with the provider's own message, never a silent rewrite.

## Settings, in words

Four things about the answers, applied to every model in that model's own terms:

- **Longest answer allowed.** A cap on the answer length. Models that think before answering use it for thinking too.
- **How much variety between answers.** Default (each model's own), Focused, Balanced, Creative, or an exact temperature. Models that only accept their default are left alone automatically.
- **How long models that reason may think.** Let each model decide, less, or more; "less" and "more" mean each model's own lowest and highest setting, so the choice means the same thing everywhere it means anything.
- **Making the model stick to the fields.** The instructions always describe the answer fields; this adds provider-side enforcement where the model supports it.

Plus repeats per case, how many calls run at once, retries, and a timeout. Each chosen model also has a small settings dialog for anything the shared controls do not cover: a response-format override, extra request parameters as JSON, and (on OpenRouter) which sub-providers to use.

## Answer fields

Ask for specific fields and each becomes a column: one choice from a list, free text, a whole number, a number, yes/no, or several choices. For a spreadsheet the fields are pre-filled from the columns you are filling in, with the kind guessed from the values already there. The fields are described to the model in plain instructions on every call and enforced as a JSON schema where the provider supports it. Answers that come back as slightly broken JSON are repaired and marked as repaired; answers that cannot be read are marked as such, never silently dropped.

## The Python bundle

Every run can be downloaded as a zip: `experiment.json` (the frozen run: templates, the compiled examples and format instructions, every model's request body with its parameters already placed, retries), `cases.csv` (the rows that were run, with only the columns the templates use), `experiment.py` (ten lines), and a small runtime. `pip install -r requirements.txt && python experiment.py` sends the same request bodies the browser sent, substituting each row into the same skeleton, with API keys read from the environment. The app's test suite checks that the Python bundle builds byte-for-byte the same request bodies as the browser for every case of a run. What is reproduced is the requests; models are not deterministic, so the answers may differ.

## Privacy

- Keys are sent only to the provider you selected, from your browser. They are kept in this browser's session storage by default; tick "remember" to keep one in local storage on a trusted machine.
- Spreadsheets are read in your browser and never uploaded anywhere but to the model, and only the columns you chose, only for the rows being filled in.
- Runs (the frozen configuration and every completed answer) are saved in your browser's IndexedDB so a reload does not lose paid-for results. Delete them from the results screen.
- Columns you mark as kept are never sent. The test suite enforces this: no value from a kept column appears in any request body.

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # static files in dist/; serve them from any static host
```

Requires Node 18 or newer. The build is a static site with no backend. Serve `dist/` from the same origin as the page; nothing is fetched at runtime except the providers you call and OpenRouter's public model list.

`npm run sync:models-dev` refreshes the vendored models.dev data (`src/data/models-dev.json`) that describes OpenAI and Anthropic models.

## Development

```bash
npm run typecheck    # strict TypeScript
npm test             # unit and integration tests (vitest), including the Python parity check
npm run test:e2e     # browser flows against the local stub and mocked providers (Playwright)
npm run check        # all three
npm run stub         # the local mock provider on :8787, for manual use
npm run probe        # opt-in: sends the app's own requests to real providers; needs keys in the environment
```

The end-to-end suite runs the seven screens the way a user would: single question, spreadsheet with guessed roles and worked examples, variations, pause/resume/cancel and rerun, exports and run files, filters, dark mode, and the three real providers mocked at the network edge with their real catalog shapes so the guidance layer is exercised without keys.

`ARCHITECTURE.md` is the short map of the code. `WORKLOG.md` records every design decision with the options that were considered and the reason for the pick. The one promise the architecture is built around: once a run is frozen, every request body is exactly what the frozen run says, in the browser now and in the Python bundle later.

## Not yet decided

The license is not yet chosen; this repository is not yet published.
