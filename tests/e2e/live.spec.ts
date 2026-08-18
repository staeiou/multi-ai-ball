// OPT-IN live smoke: runs one cheap model per provider against the REAL API.
// Skipped unless the matching E2E_<PROVIDER>_API_KEY variable is set:
//
//   E2E_OPENROUTER_API_KEY=sk-or-... E2E_OPENAI_API_KEY=sk-... \
//   E2E_ANTHROPIC_API_KEY=sk-ant-... npx playwright test live.spec.ts
//
// Each case walks the actual wizard (Prompt → Output format → Provider →
// Models → Run settings → Review & run), configures that provider, loads its
// real model list (the critical CORS + auth + catalog-path check), selects
// one cheap model, and runs a tiny prompt — asserting a real, non-degenerate
// answer.
import { expect, test } from '@playwright/test'

interface LiveCase {
  preset: string
  envKey: string
  model: string
  expectContains: string
}

const LIVE_CASES: LiveCase[] = [
  { preset: 'openrouter', envKey: 'E2E_OPENROUTER_API_KEY', model: 'openai/gpt-4o-mini', expectContains: 'Paris' },
  { preset: 'openai-chat', envKey: 'E2E_OPENAI_API_KEY', model: 'gpt-4o-mini', expectContains: 'Paris' },
  { preset: 'anthropic', envKey: 'E2E_ANTHROPIC_API_KEY', model: 'claude-haiku-4-5-20251001', expectContains: 'Paris' },
]

for (const live of LIVE_CASES) {
  const key = process.env[live.envKey]
  const describe = key ? test.describe : test.describe.skip
  describe(`live: ${live.preset} (${live.envKey})`, () => {
    test(`runs ${live.model} against the real API`, async ({ page }) => {
      await page.goto('/')

      // Step 1: prompt.
      await page.fill('textarea[data-field="prompt"]', 'What is the capital of France? Answer in one word.')
      await page.click('text=Next →') // output format
      await page.click('text=Next →') // provider

      // Step 3: provider + key, then load the real catalog.
      await page.selectOption('.provider-band select', live.preset)
      const keyInput = page.locator('input[placeholder*="API key"]')
      await keyInput.fill(key!)
      await page.click('text=Load models')
      await expect(page.locator('.model-option')).toHaveCountGreaterThan(0, { timeout: 30_000 })
      await expect(page.locator('span', { hasText: /models loaded/ })).toBeVisible()
      await page.click('text=Next →') // models

      // Step 4: select the cheap model, exact id (variant suffixes excluded).
      await page.check(`.model-option:has(.model-id:text-is("${live.model}")) input`)
      await page.click('text=Next →') // run settings
      await page.click('text=Next →') // review & run

      // The review stage owns the only Run action.
      await expect(page.locator('button.run-button')).toBeEnabled()
      await page.click('button.run-button')

      await expect(page.locator('.grid-table .status.ok')).toHaveCount(1, { timeout: 120_000 })
      const text = (await page.locator('.grid-table .response-text').textContent()) ?? ''
      expect(text).toContain(live.expectContains)
    })
  })
}
