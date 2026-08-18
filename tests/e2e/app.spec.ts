// End-to-end against the local mock provider (dev/stub-server.mjs). This is
// the deterministic flow that must never break — API keys, live costs, and
// real models are NOT involved.
import { expect, test } from '@playwright/test'

const STUB_BASE = 'http://localhost:8787'

async function fillCustomProvider(page: import('@playwright/test').Page): Promise<void> {
  await page.selectOption('.provider-card select', 'custom')
  await page.fill('input[placeholder*="Base URL"]', STUB_BASE)
  await page.click('text=Load models')
  await expect(page.locator('.model-option')).toHaveCount(5)
}

async function advanceToProvider(page: import('@playwright/test').Page, prompt: string): Promise<void> {
  await page.fill('textarea[data-field="prompt"]', prompt)
  await page.click('text=Next →') // output format
  await page.click('text=Next →') // provider
}

async function advanceModelsToReview(page: import('@playwright/test').Page): Promise<void> {
  await page.click('text=Next →') // settings
  await page.click('text=Next →') // review
}

test.describe('mock provider flow', () => {
  test('loads models, runs a prompt across two models, and exports CSV', async ({ page }) => {
    await page.goto('/')
    // This is a true stage wizard, not a long page with all sections stacked.
    await expect(page.locator('.step.active')).toHaveCount(1)
    expect(await page.locator('.step:not(.active)').evaluateAll(steps =>
      steps.every(step => getComputedStyle(step).display === 'none'),
    )).toBe(true)

    await advanceToProvider(page, 'Classify this request: {{topic}}')
    await fillCustomProvider(page)
    await expect(page.locator('.step.active')).toHaveCount(1)

    // Stage 2 is now Provider & models: select first, then advance.
    await page.check(`.model-option:has-text("stub-echo") input`)
    await page.check(`.model-option:has-text("stub-uppercase") input`)

    await advanceModelsToReview(page)
    await expect(page.locator('button.run-button')).toBeEnabled()
    await page.click('button.run-button') // "Run"

    // Run immediately enters the visible Results state, before calls settle.
    await expect(page.locator('.step.active h2')).toHaveText('Results')
    // One prompt × many models is a head-to-head table, not model tabs.
    await expect(page.locator('.result-tab')).toHaveCount(0)
    await expect(page.locator('.final-table thead')).toContainText('Model', { timeout: 20_000 })
    await expect(page.getByText('ok', { exact: true })).toHaveCount(2, { timeout: 20_000 })
    // The uppercase stub's row shows the transformed answer (echo's row keeps the prompt verbatim).
    await expect(page.locator('.response-text', { hasText: /CLASSIFY/ })).toHaveCount(1, { timeout: 10_000 })

    // CSV export downloads and contains the rendered prompt + a row per call.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('text=CSV'),
    ])
    const stream = await download.createReadStream()
    const csv = (await streamToString(stream)).toString('utf8')
    expect(csv).toContain('Classify this request: {{topic}}')
    expect(csv).toContain('CLASSIFY THIS REQUEST:')
    expect(csv.split('\n').length).toBeGreaterThanOrEqual(3) // header + 2 rows
  })

  test('run stays blocked when the model list could not be loaded', async ({ page }) => {
    await page.goto('/')
    await advanceToProvider(page, 'x')
    // Point the custom provider at a dead endpoint so Load models fails.
    await page.selectOption('.provider-card select', 'custom')
    await page.fill('input[placeholder*="Base URL"]', 'http://localhost:59999')
    await page.click('text=Load models')
    await expect(page.getByText('Load failed:', { exact: false }).first()).toBeVisible()
    await page.click('text=Next →')
    await expect(page.locator('.step.active')).toHaveCount(1)
  })

  test('sheet source: upload shows columns, previews rows, and runs a mad-libs expansion', async ({ page }) => {
    await page.goto('/')
    // Sheet authoring belongs on the first stage.
    await page.click('text=Spreadsheet × template')
    await page.fill('textarea[data-field="prompt"]', 'Classify: Type={{type}}; Request={{request}}')
    await page.setInputFiles('input[type=file][accept*=".csv"]', {
      name: 'cases.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('type,request\nVIP,refund\nstandard,complaint\n'),
    })
    await expect(page.locator('.sheet-table th').nth(1)).toHaveText('type')
    await expect(page.locator('.sheet-table th').nth(2)).toHaveText('request')
    await expect(page.locator('.preview-user')).toContainText('Classify: Type=VIP; Request=refund')
    await page.click('text=Next →') // output
    await page.click('text=Next →') // provider & models
    await fillCustomProvider(page)
    await page.check(`.model-option:has-text("stub-echo") input`)
    await advanceModelsToReview(page)
    await expect(page.locator('button.run-button')).toBeEnabled()
    await page.click('button.run-button')

    // 2 rows × 1 model = 2 calls.
    await expect(page.locator('.grid-table tbody tr')).toHaveCount(2)
    await expect(page.getByText('ok', { exact: true })).toHaveCount(2, { timeout: 20_000 })
  })

  test('retries are visible in the table, the cost total updates live, and the final table shows cost without latency', async ({ page }) => {
    await page.goto('/')
    await advanceToProvider(page, 'Flaky hello')
    await fillCustomProvider(page)
    // Already on Provider & models: choose the flaky model right here.
    await page.check(`.model-option:has-text("stub-flaky") input`)
    await page.click('text=Next →') // run settings
    await page.fill('[data-field="retries"]', '2')
    await page.fill('[data-field="concurrency"]', '1')
    await page.click('text=Next →') // review
    await page.click('button.run-button')

    // Live view: reasoning and response are separate columns.
    await expect(page.locator('.live-table thead')).toContainText('Reasoning')
    await expect(page.locator('.live-table thead')).toContainText('Response')

    // A retrying status appears while the 503s are retried.
    await expect(page.locator('.status.retrying')).toHaveCount(1, { timeout: 15_000 })
    // The toolbar total is live, not a snapshot taken at the end.
    await expect(page.getByText('so far', { exact: false })).toBeVisible()
    // The flaky model recovers on its third attempt.
    await expect(page.locator('.status.retrying')).toHaveCount(0, { timeout: 15_000 })

    // Final table: cost and reasoning present, latency and parts absent.
    const finalHead = page.locator('.final-table thead')
    await expect(finalHead).toContainText('Cost')
    await expect(finalHead).toContainText('Reasoning')
    await expect(finalHead).not.toContainText('Latency')
    await expect(finalHead).not.toContainText('Response parts')
    await expect(page.locator('.final-table .raw-coin')).toHaveCount(1)
    await expect(page.getByText('actual', { exact: false })).toBeVisible({ timeout: 10_000 })
  })
})

function streamToString(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', chunk => chunks.push(Buffer.from(chunk)))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}
