// End-to-end against the local stub provider (dev/stub-server.mjs). No keys,
// no network, no real models. These walk the seven screens the way a user
// who knows spreadsheets and nothing about APIs would.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const STUB_BASE = 'http://localhost:8787'
const STUB_MODELS = 7

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
  await expect(page.locator('.step.active h2')).toHaveText('Your data')
})

test.describe('one question', () => {
  test('asks two models, shows both answers, exports CSV, and lists the saved run', async ({ page }) => {
    await next(page) // one question needs no data setup
    await page.fill('textarea[data-field="prompt"]', 'Classify this request')
    await next(page, 2) // instructions -> format (plain text by default) -> models
    await connectStub(page)
    await pickModel(page, 'stub-echo')
    await pickModel(page, 'stub-uppercase')
    await expect(page.locator('.selected-col .model-row')).toHaveCount(2)
    await expect(page.locator('.pick-col .model-row')).toHaveCount(STUB_MODELS - 2)
    await next(page, 2) // settings -> check
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

  test('a blank like {{name}} in a single question is explained and blocks', async ({ page }) => {
    await next(page)
    await page.fill('textarea[data-field="prompt"]', 'Hello {{name}}')
    await expect(page.locator('button.wizard-next')).toBeDisabled()
    await expect(page.locator('.wizard-buttons .wizard-blocker')).toContainText('{{name}}')
  })

  test('a dead endpoint blocks advancing past the models screen', async ({ page }) => {
    await next(page)
    await page.fill('textarea[data-field="prompt"]', 'x')
    await next(page, 2)
    await page.selectOption('.provider-band select', 'custom')
    await page.fill('input[placeholder*="Base URL"]', 'http://localhost:59999')
    await page.click('text=Load models')
    await expect(page.locator('[data-field="loadFacts"]')).toContainText('Load failed')
    await expect(page.locator('button.wizard-next')).toBeDisabled()
  })
})

test.describe('a spreadsheet', () => {
  const csv = [
    'id,text,frame,score,notes',
    'A1,Markets fell on rate fears as investors sold shares across the board,economic,4,checked',
    'A2,The council debated the new park for three hours,civic,2,',
    'A3,Hospital wait times doubled over the winter,,,',
    'A4,Startup raises money from local investors,,,',
    'A5,Partly coded article about taxes,economic,,',
  ].join('\n')

  async function loadSheet(page: Page): Promise<void> {
    await page.click('button.chip[data-flow="sheet"]')
    await page.setInputFiles('input[type=file][accept*=".csv"]', { name: 'articles.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
    await expect(page.locator('.data-preview .sheet-table tbody tr')).toHaveCount(5)
  }

  test('guesses what to read and what to fill in, explains the split, and refuses a kept column in the prompt', async ({ page }) => {
    await loadSheet(page)
    // The guesses: the long text column is read; the partly filled columns are filled in.
    await expect(page.locator('input[data-role="input"][data-column="text"]')).toBeChecked()
    await expect(page.locator('input[data-role="output"][data-column="frame"]')).toBeChecked()
    await expect(page.locator('input[data-role="output"][data-column="score"]')).toBeChecked()
    await expect(page.locator('input[data-role="input"][data-column="id"]')).not.toBeChecked()
    await expect(page.locator('.partition-box')).toContainText('2 rows will be filled in')
    await expect(page.locator('.partition-box')).toContainText('2 rows are already filled in')
    await expect(page.locator('.partition-box')).toContainText('1 row has some answers filled in')
    await expect(page.locator('.stage-card').first()).toContainText('never sent to a model')
    await next(page)
    // The per-row text was generated from the chosen column; the user only writes instructions.
    await expect(page.locator('textarea[data-field="prompt"]')).toHaveValue('{{text}}')
    await expect(page.locator('button.wizard-next')).toBeDisabled()
    await page.fill('textarea[data-field="system"]', 'Decide the frame and give a score.')
    await expect(page.locator('button.wizard-next')).toBeEnabled()
    // Taking over the row text and naming a kept column is refused with the reason.
    await page.click('text=Edit how each row is shown to the model')
    await page.fill('textarea[data-field="prompt"]', 'Article: {{text}} ({{id}})')
    await expect(page.locator('.step.active .inline-blocker')).toContainText('{{id}}')
    await page.click('text=Back to automatic')
    await expect(page.locator('textarea[data-field="prompt"]')).toHaveValue('{{text}}')
    await page.click('text=The examples and answer format every call carries')
    await expect(page.locator('.constant-block')).toContainText('Markets fell on rate fears')
    await expect(page.locator('.constant-block')).toContainText('"frame":"economic"')
    await next(page)
    // Answer format pre-filled from the two output columns, kinds guessed.
    await expect(page.locator('.field-entry')).toHaveCount(2)
    await expect(page.locator('.field-entry').first().locator('input').first()).toHaveValue('frame')
    await expect(page.locator('.field-entry').first().locator('select')).toHaveValue('enum')
    await expect(page.locator('.field-entry').nth(1).locator('select')).toHaveValue('integer')
  })

  test('runs the blank rows, puts each field in a column, and exports the completed spreadsheet', async ({ page }) => {
    await loadSheet(page)
    await next(page)
    await page.fill('textarea[data-field="system"]', 'Decide the frame and give a score.')
    await next(page, 2)
    await connectStub(page)
    await pickModel(page, 'stub-json')
    await next(page, 2)
    await expect(page.locator('.review-summary')).toContainText('2 rows to run (2 worked examples, 1 skipped)')
    await runAndWait(page, 2)
    await expect(page.locator('.final-table thead')).toContainText('frame')
    await expect(page.locator('.final-table tbody')).toContainText('civic')
    await expect(page.locator('.status.ok')).toHaveCount(2)

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('text=Completed spreadsheet')])
    expect(download.suggestedFilename()).toMatch(/completed.*\.xlsx$/)

    await page.click('.final-table tbody tr >> nth=0')
    await expect(page.locator('.detail-dialog')).toContainText('Request that was sent')
    await expect(page.locator('.detail-dialog')).toContainText('Hospital wait times doubled')
  })

  test('a sheet with nothing filled in gets a new answer column', async ({ page }) => {
    await page.click('button.chip[data-flow="sheet"]')
    await page.setInputFiles('input[type=file][accept*=".csv"]', { name: 'plain.csv', mimeType: 'text/csv', buffer: Buffer.from('id,text\n1,The park is lovely today\n2,Traffic was terrible\n') })
    await expect(page.locator('.data-preview .sheet-table tbody tr')).toHaveCount(2)
    await expect(page.locator('.partition-box')).toContainText('Pick a column to fill in')
    await page.fill('input.new-column', 'sentiment')
    await page.click('text=Add a new column')
    await expect(page.locator('.partition-box')).toContainText('2 rows will be filled in')
    await expect(page.locator('.partition-box')).toContainText('No row is filled in yet')
    await next(page)
    await page.fill('textarea[data-field="system"]', 'Is the sentiment positive or negative?')
    await next(page)
    await expect(page.locator('.field-entry')).toHaveCount(1)
    await expect(page.locator('.field-entry').first().locator('input').first()).toHaveValue('sentiment')
  })
})

test.describe('resilience', () => {
  test('a flaky model recovers within its retries and a failing model is reported, not hidden', async ({ page }) => {
    await next(page)
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

  test('saved setups round-trip the prompt', async ({ page }) => {
    await next(page)
    await page.fill('textarea[data-field="prompt"]', 'Original prompt')
    await next(page)
    await page.click('.step.active .more-options summary')
    await page.fill('input[placeholder="Name this setup"]', 'My setup')
    await page.click('text=Save setup')
    await page.click('text=← Back')
    await page.fill('textarea[data-field="prompt"]', 'Changed prompt')
    await next(page)
    await page.locator('.template-row select').selectOption({ label: 'My setup' })
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

test.describe('the rest of the surface', () => {
  test('variations: every combination becomes a case and the blanks are checked against the variables', async ({ page }) => {
    await page.click('button.chip[data-flow="sweep"]')
    await page.click('text=+ Add a blank to vary')
    await page.fill('.sweep-var input', 'name')
    await page.locator('.sweep-var input').press('Tab')
    await page.fill('.sweep-var textarea', 'Ann\nBob')
    await page.locator('.sweep-var textarea').press('Tab')
    await page.click('text=+ Add a blank to vary')
    await page.fill('.sweep-var >> nth=1 >> input', 'city')
    await page.locator('.sweep-var >> nth=1 >> input').press('Tab')
    await page.fill('.sweep-var >> nth=1 >> textarea', 'Oslo\nRome\nLima')
    await page.locator('.sweep-var >> nth=1 >> textarea').press('Tab')
    await expect(page.locator('.sweep-box')).toContainText('6 combinations')
    await next(page)
    await page.fill('textarea[data-field="prompt"]', 'Greet {{name}} from {{town}}')
    await expect(page.locator('.step.active .inline-blocker')).toContainText('{{town}}')
    await page.fill('textarea[data-field="prompt"]', 'Greet {{name}} from {{city}}')
    await expect(page.locator('.preview-user')).toContainText('Greet Ann from Oslo')
    await next(page, 2)
    await connectStub(page)
    await pickModel(page, 'stub-echo')
    await next(page, 2)
    await expect(page.locator('.review-summary')).toContainText('6 (6 × 1 × 1 repeat)')
    await runAndWait(page, 6)
    await expect(page.locator('.final-table')).toContainText('Greet Bob from Lima')
  })

  test('pause holds new calls, resume continues, cancel stops; then the missing calls can be rerun', async ({ page }) => {
    await next(page)
    await page.fill('textarea[data-field="prompt"]', 'Slowly')
    await next(page, 2)
    await connectStub(page)
    await pickModel(page, 'stub-slow')
    await next(page)
    await page.fill('[data-field="repeats"]', '4')
    await page.locator('[data-field="repeats"]').press('Tab')
    await page.fill('[data-field="concurrency"]', '1')
    await page.locator('[data-field="concurrency"]').press('Tab')
    await next(page)
    await expect(page.locator('button.run-button')).toBeEnabled({ timeout: 15_000 })
    await page.click('button.run-button')
    await expect(page.locator('.run-tally')).toContainText('1 in flight', { timeout: 10_000 })
    await expect(page.locator('.run-tally')).toContainText('3 waiting')
    await expect(page.locator('.run-tally')).toContainText('expected in total')
    await expect(page.locator('.run-tally')).toContainText('elapsed', { timeout: 5_000 })
    await page.click('button:has-text("Pause")')
    await expect(page.locator('.status-line')).toContainText('Paused')
    await page.click('button:has-text("Resume")')
    await expect(page.locator('.status.ok')).toHaveCount(2, { timeout: 15_000 })
    await page.click('button:has-text("Cancel")')
    await expect(page.locator('.status-line')).toContainText('Stopped', { timeout: 15_000 })
    const done = await page.locator('.status.ok').count()
    expect(done).toBeLessThan(4)
    await page.click('button:has-text("Run the missing calls")')
    await expect(page.locator('.status.ok')).toHaveCount(4, { timeout: 20_000 })
    await expect(page.locator('.status-line')).toContainText('Done')
    await expect(page.locator('.run-tally')).toContainText('4 of 4 done')
    await expect(page.locator('.run-tally')).toContainText('spent so far')
  })

  test('a model typed by id runs even when the list does not carry it', async ({ page }) => {
    await next(page)
    await page.fill('textarea[data-field="prompt"]', 'Typed model')
    await next(page, 2)
    await connectStub(page)
    await page.fill('input[placeholder*="Add a model by id"]', 'stub-uppercase')
    await page.press('input[placeholder*="Add a model by id"]', 'Enter')
    await expect(page.locator('.selected-col .model-row')).toHaveCount(1)
    await next(page, 2)
    await runAndWait(page, 1)
    await expect(page.locator('.final-table')).toContainText('TYPED MODEL')
  })

  test('exports: XLSX, JSONL, the Python bundle, and a run file that reopens with its rows', async ({ page }) => {
    await next(page)
    await page.fill('textarea[data-field="prompt"]', 'Export me')
    await next(page, 2)
    await connectStub(page)
    await pickModel(page, 'stub-echo')
    await next(page, 2)
    await runAndWait(page, 1)
    for (const [label, pattern] of [['Results (XLSX)', /\.xlsx$/], ['JSONL', /\.jsonl$/], ['Python bundle', /python\.zip$/]] as const) {
      const [download] = await Promise.all([page.waitForEvent('download'), page.click(`text=${label}`)])
      expect(download.suggestedFilename()).toMatch(pattern)
    }
    const [runFile] = await Promise.all([page.waitForEvent('download'), page.click('text=Save run file')])
    const path = await runFile.path()
    expect(path).not.toBeNull()
    // A fresh page has no run; opening the file restores it.
    await page.goto('/')
    await page.setInputFiles('input[type=file][accept=".zip"]', path!)
    await expect(page.locator('.step.active h2')).toHaveText('Results')
    await expect(page.locator('.final-table tbody tr')).toHaveCount(1)
    await expect(page.locator('.final-table')).toContainText('Export me')
  })

  test('results can be filtered by text and by status', async ({ page }) => {
    await next(page)
    await page.fill('textarea[data-field="prompt"]', 'Filter me')
    await next(page, 2)
    await connectStub(page)
    await pickModel(page, 'stub-echo')
    await pickModel(page, 'stub-fail')
    await next(page, 2)
    await runAndWait(page, 2)
    await page.selectOption('.result-status', 'error')
    await expect(page.locator('.final-table tbody tr')).toHaveCount(1)
    await page.selectOption('.result-status', 'all')
    await page.fill('.result-search', 'stub-echo')
    await expect(page.locator('.final-table tbody tr')).toHaveCount(1)
  })

  test('dark mode toggles the theme and persists', async ({ page }) => {
    await page.check('.app-header input[type=checkbox]')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  })
})
