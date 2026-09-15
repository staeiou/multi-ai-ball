// End-to-end against the local stub provider (dev/stub-server.mjs). No keys,
// no network, no real models. These walk the six screens the way a user does.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const STUB_BASE = 'http://localhost:8787'
const STUB_MODELS = 6

async function connectStub(page: Page): Promise<void> {
  await page.selectOption('.provider-band select', 'custom')
  await page.fill('input[placeholder*="Base URL"]', STUB_BASE)
  await page.click('text=Load models')
  await expect(page.locator('.pick-col .model-row')).toHaveCount(STUB_MODELS)
}

async function next(page: Page, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await expect(page.locator('button.wizard-next')).toBeEnabled()
    await page.click('button.wizard-next')
  }
}

async function pickModel(page: Page, id: string): Promise<void> {
  await page.click(`.pick-col .model-row:has(.model-id:text-is("${id}"))`)
}

async function runAndWait(page: Page, calls: number): Promise<void> {
  await expect(page.locator('button.run-button')).toBeEnabled({ timeout: 15_000 })
  await page.click('button.run-button')
  await expect(page.locator('.step.active h2')).toHaveText('Results')
  await expect(page.locator('.final-table tbody tr')).toHaveCount(calls, { timeout: 30_000 })
  await expect(page.locator('.status-line')).toContainText('Done', { timeout: 30_000 })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  // Each test starts from a clean browser; the wizard must open on the first screen.
  await expect(page.locator('.step.active h2')).toHaveText('Prompt & data')
})

test.describe('single prompt', () => {
  test('runs one prompt across two models, shows both answers, exports CSV, and lists the saved run', async ({ page }) => {
    await page.fill('textarea[data-field="prompt"]', 'Classify this request')
    await next(page, 2)
    await connectStub(page)
    await pickModel(page, 'stub-echo')
    await pickModel(page, 'stub-uppercase')
    await expect(page.locator('.selected-col .model-row')).toHaveCount(2)
    await expect(page.locator('.pick-col .model-row')).toHaveCount(STUB_MODELS - 2)
    await next(page, 2)
    // The review screen shows the frozen request before anything is sent.
    await expect(page.locator('.review-model')).toHaveCount(2)
    await expect(page.locator('.review-model').first()).toContainText('max_tokens')
    await runAndWait(page, 2)
    await expect(page.locator('.final-table')).toContainText('CLASSIFY THIS REQUEST')
    await expect(page.locator('.status.ok')).toHaveCount(2)

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('text=CSV')])
    const csv = (await streamToString(await download.createReadStream())).toString('utf8')
    expect(csv.split('\r\n')).toHaveLength(3)
    expect(csv).toContain('CLASSIFY THIS REQUEST')
    expect(csv).toContain('Request body SHA-256')

    await page.click('text=Saved runs on this device')
    await expect(page.locator('.saved-run')).toHaveCount(1)
    await expect(page.locator('.saved-run')).toContainText('stub-echo, stub-uppercase')
  })

  test('a placeholder in single-prompt mode blocks the first screen with a reason', async ({ page }) => {
    await page.fill('textarea[data-field="prompt"]', 'Hello {{name}}')
    await expect(page.locator('button.wizard-next')).toBeDisabled()
    await expect(page.locator('.wizard-blocker').first()).toContainText('{{name}}')
  })

  test('a dead endpoint blocks advancing past the models screen', async ({ page }) => {
    await page.fill('textarea[data-field="prompt"]', 'x')
    await next(page, 2)
    await page.selectOption('.provider-band select', 'custom')
    await page.fill('input[placeholder*="Base URL"]', 'http://localhost:59999')
    await page.click('text=Load models')
    await expect(page.locator('[data-field="loadFacts"]')).toContainText('Load failed')
    await expect(page.locator('button.wizard-next')).toBeDisabled()
  })
})

test.describe('spreadsheet', () => {
  const csv = [
    'id,text,frame,score',
    'A1,Markets fell on rate fears,economic,4',
    'A2,The council debated the park,civic,2',
    'A3,Hospital wait times doubled,,',
    'A4,Startup raises money,,',
    'A5,Partly coded,economic,',
  ].join('\n')

  async function loadSheet(page: Page): Promise<void> {
    await page.click('button.chip[data-flow="sheet"]')
    await page.setInputFiles('input[type=file][accept*=".csv"]', { name: 'articles.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
    await expect(page.locator('.roles-table tbody tr')).toHaveCount(4)
  }

  test('roles drive the partition: filled output rows become examples, blank rows run, partial rows are skipped', async ({ page }) => {
    await loadSheet(page)
    await page.selectOption('select.role-select[data-column="id"]', 'reference')
    await page.selectOption('select.role-select[data-column="frame"]', 'output')
    await page.selectOption('select.role-select[data-column="score"]', 'output')
    await expect(page.locator('.partition-box')).toContainText('2 rows to run')
    await expect(page.locator('.partition-box')).toContainText('2 rows already filled become worked examples')
    await expect(page.locator('.partition-box')).toContainText('1 rows have some outputs filled')

    // A reference column in the prompt is refused, with the reason shown.
    await page.fill('textarea[data-field="prompt"]', 'Code this: {{text}} ({{id}})')
    await expect(page.locator('button.wizard-next')).toBeDisabled()
    await expect(page.locator('.inline-blocker')).toContainText('reference column')
    await page.fill('textarea[data-field="prompt"]', 'Code this: {{text}}')
    await expect(page.locator('button.wizard-next')).toBeEnabled()

    // The examples are compiled once and shown.
    await page.click('text=What every call will carry')
    await expect(page.locator('.constant-block')).toContainText('<example>')
    await expect(page.locator('.constant-block')).toContainText('Markets fell on rate fears')
    await expect(page.locator('.constant-block')).toContainText('"frame":"economic"')
    await expect(page.locator('.preview-user')).toContainText('Code this: Hospital wait times doubled')
  })

  test('runs the target rows, parses JSON into columns, and exports the completed spreadsheet', async ({ page }) => {
    await loadSheet(page)
    await page.selectOption('select.role-select[data-column="frame"]', 'output')
    await page.selectOption('select.role-select[data-column="score"]', 'output')
    await page.fill('textarea[data-field="prompt"]', 'Code this: {{text}}')
    await next(page)
    // Output format: two fields so the schema and the columns exist.
    await page.click('text=+ Add field')
    const entry = page.locator('.field-entry').first()
    await entry.locator('input[placeholder*="field name"]').fill('frame')
    await entry.locator('input[placeholder*="field name"]').press('Tab')
    await entry.locator('.choice-row input').first().fill('economic')
    await entry.locator('.choice-row input').first().press('Tab')
    await next(page)
    await connectStub(page)
    await pickModel(page, 'stub-json')
    await next(page, 2)
    await expect(page.locator('.review-summary')).toContainText('2 rows to run (2 worked examples, 1 skipped)')
    await runAndWait(page, 2)
    await expect(page.locator('.final-table thead')).toContainText('frame')
    await expect(page.locator('.final-table tbody')).toContainText('civic')
    await expect(page.locator('.status.ok')).toHaveCount(2)

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('text=Completed spreadsheet')])
    expect(await download.path()).not.toBeNull()
    expect(download.suggestedFilename()).toMatch(/completed.*\.xlsx$/)

    // The detail dialog shows the exact request that was sent.
    await page.click('.final-table tbody tr >> nth=0')
    await expect(page.locator('.detail-dialog')).toContainText('Request that was sent')
    await expect(page.locator('.detail-dialog')).toContainText('Hospital wait times doubled')
  })
})

test.describe('resilience', () => {
  test('a flaky model recovers within its retries and a failing model is reported, not hidden', async ({ page }) => {
    await page.fill('textarea[data-field="prompt"]', 'Flaky hello')
    await next(page, 2)
    await connectStub(page)
    await pickModel(page, 'stub-flaky')
    await pickModel(page, 'stub-fail')
    await next(page)
    await page.fill('[data-field="retries"]', '2')
    await page.locator('[data-field="retries"]').press('Tab')
    await next(page)
    await runAndWait(page, 2)
    await expect(page.locator('.status.ok')).toHaveCount(1)
    await expect(page.locator('.status.error')).toHaveCount(1)
    await expect(page.locator('.final-table')).toContainText('HTTP 500')
    await expect(page.locator('button:has-text("Run the missing calls")')).toBeVisible()
  })

  test('saved templates round-trip prompt and fields', async ({ page }) => {
    await page.fill('textarea[data-field="prompt"]', 'Original prompt')
    await next(page)
    await page.fill('input[placeholder="Template name"]', 'My template')
    await page.click('text=Save as template')
    await page.click('text=← Back')
    await page.fill('textarea[data-field="prompt"]', 'Changed prompt')
    await next(page)
    await page.locator('.template-row select').selectOption({ label: 'My template' })
    await page.click('text=← Back')
    await expect(page.locator('textarea[data-field="prompt"]')).toHaveValue('Original prompt')
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
