# Probe rig

Sends the app's own request bodies (built by `src/core/providers/build.ts`
and rendered by `src/core/render.ts`, the same code the browser runs) to real
endpoints, and records what each answered. It is how a "does model X take
parameter Y" question gets answered here: not from a document, from a 2xx or
a 4xx with the provider's own message.

Never runs in CI. Opt in explicitly:

```bash
source ../auditomatic-lite/keys.secret      # exports OPENAI_API_KEY etc.; never printed
MULTIAIBALL_LIVE_PROBE=1 npx vitest run --config scripts/probe/vitest.config.ts
```

Targets live in `targets.json`: per provider, the model ids to probe (the
catalog is fetched live and ids not present are reported, not guessed). Each
model is sent one tiny call per variant in `VARIANTS` (`probe.test.ts`):
the Basic default, temperature set, effort set, JSON schema forced, and a
deliberately unknown key. Output cap 512 tokens (a 64-token cap starved reasoning models into empty answers on the first run); prompts say "Say hi".

Results go to `tmp/probe/results-<date>.json` (config, denominator, every call
with status, the request body as sent, a response excerpt) and a human table
to stdout. Where guidance said "accepted" and the provider said 4xx naming the
parameter, a candidate for `src/core/providers/exceptions.json` is printed.
**A person promotes candidates**; the rig never writes into `src/`.
