// OPT-IN live smoke: one cheap model per provider against the REAL API,
// through the real screens. Skipped unless the matching key is set:
//
//   source ../auditomatic-lite/keys.secret; \
//   E2E_OPENROUTER_API_KEY=$OPENROUTER_API_KEY E2E_OPENAI_API_KEY=$OPENAI_API_KEY \
//   E2E_ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY npx playwright test tests/e2e/live.spec.ts
//
// Each case loads the provider's real catalog (the CORS + auth + list-shape
// check), picks a model that models.dev/the catalog reports as refusing
// temperature, sets temperature anyway, and confirms the review screen
// omits it with a reason and the run answers. That is the guidance layer's
// most consequential claim exercised end to end.
import { expect, test } from '@playwright/test'

interface LiveCase {
  preset: string
  envKey: string
  /** A model reported to refuse temperature (only its default). */
  model: string
  expectContains: string
}

const LIVE_CASES: LiveCase[] = [
  { preset: 'openrouter', envKey: 'E2E_OPENROUTER_API_KEY', model: 'openai/gpt-5-nano', expectContains: 'Paris' },
  { preset: 'openai', envKey: 'E2E_OPENAI_API_KEY', model: 'gpt-5-nano', expectContains: 'Paris' },
  { preset: 'anthropic', envKey: 'E2E_ANTHROPIC_API_KEY', model: 'claude-sonnet-5', expectContains: 'Paris' },
]

for (const live of LIVE_CASES) {
  const key = process.env[live.envKey]
  const describe = key ? test.describe : test.describe.skip
  describe(`live: ${live.preset}`, () => {
    test(`runs ${live.model} with temperature set, omitted per guidance`, async ({ page }) => {
      await page.goto('/')
      await page.click('button.wizard-next') // one question: nothing to set up
      await page.fill('textarea[data-field="prompt"]', 'What is the capital of France? Answer in one word.')
      await page.click('button.wizard-next') // answer format: plain text
      await page.click('button.wizard-next') // models
      await page.selectOption('.provider-band select', live.preset)
      await page.fill('input[placeholder*="API key"]', key!)
      await page.click('text=Load models')
      await expect(page.locator('.pick-col .model-row').first()).toBeVisible({ timeout: 30_000 })
      await page.fill('input[placeholder*="Filter the loaded"]', live.model)
      await page.click(`.pick-col .model-row:has(.model-id:text-is("${live.model}"))`)
      await page.click('button.wizard-next') // settings
      await page.selectOption('[data-field="temperatureWords"]', 'focused')
      await page.click('button.wizard-next') // check
      const report = page.locator('.review-model')
      await expect(report).toHaveCount(1, { timeout: 15_000 })
      await report.locator('summary').click()
      await expect(report.locator('.report-table tr.omitted').filter({ hasText: 'temperature' })).toHaveCount(1)
      await expect(page.locator('button.run-button')).toBeEnabled()
      await page.click('button.run-button')
      await expect(page.locator('.status.ok')).toHaveCount(1, { timeout: 120_000 })
      await expect(page.locator('.final-table')).toContainText(live.expectContains)
    })
  })
}
