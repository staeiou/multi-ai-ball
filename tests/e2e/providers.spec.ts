// The three real providers, mocked at the network edge with Playwright route
// interception. No keys, no network. This exercises what the stub cannot:
// each provider's catalog shape, the guidance derived from it, the per-model
// parameter decisions shown on the check screen, and each wire shape's
// request body and response reading.
import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

import { ANTHROPIC_MODELS, OPENAI_MODELS, OPENROUTER_MODELS, anthropicResponse, openaiChatResponse, promptOf } from './fixtures/catalogs'

interface Seen {
  bodies: Array<Record<string, unknown>>
  headers: Array<Record<string, string>>
}

function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function mockProviders(page: Page): Promise<Record<string, Seen>> {
  const seen: Record<string, Seen> = { openai: { bodies: [], headers: [] }, anthropic: { bodies: [], headers: [] }, openrouter: { bodies: [], headers: [] } }
  await page.route('https://api.openai.com/**', route => {
    const url = route.request().url()
    if (url.endsWith('/v1/models')) return json(route, 200, OPENAI_MODELS)
    const body = route.request().postDataJSON() as Record<string, unknown>
    seen.openai.bodies.push(body)
    seen.openai.headers.push(route.request().headers())
    if ('temperature' in body && String(body.model).startsWith('gpt-5')) {
      return json(route, 400, { error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.", type: 'invalid_request_error', param: 'temperature', code: 'unsupported_value' } })
    }
    if ('max_tokens' in body) return json(route, 400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: 'invalid_request_error', param: 'max_tokens', code: 'unsupported_parameter' } })
    return json(route, 200, openaiChatResponse(String(body.model), `openai says: ${promptOf(body)}`))
  })
  await page.route('https://api.anthropic.com/**', route => {
    const url = route.request().url()
    if (url.includes('/v1/models')) return json(route, 200, ANTHROPIC_MODELS)
    const body = route.request().postDataJSON() as Record<string, unknown>
    seen.anthropic.bodies.push(body)
    seen.anthropic.headers.push(route.request().headers())
    if (!('max_tokens' in body)) return json(route, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: Field required' } })
    if ('temperature' in body && body.model === 'claude-sonnet-5') return json(route, 400, { type: 'error', error: { type: 'invalid_request_error', message: '`temperature` is deprecated for this model.' } })
    return json(route, 200, anthropicResponse(String(body.model), `claude says: ${promptOf(body)}`))
  })
  await page.route('https://openrouter.ai/**', route => {
    const url = route.request().url()
    if (url.endsWith('/api/v1/models')) return json(route, 200, OPENROUTER_MODELS)
    if (url.endsWith('/api/v1/endpoints/zdr')) return json(route, 200, { data: [{ model_id: 'anthropic/claude-sonnet-4.5' }] })
    const body = route.request().postDataJSON() as Record<string, unknown>
    seen.openrouter.bodies.push(body)
    seen.openrouter.headers.push(route.request().headers())
    return json(route, 200, openaiChatResponse(String(body.model), `router says: ${promptOf(body)}`, { provider: 'Azure', usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, cost: 0.000123 } }))
  })
  return seen
}

async function toModels(page: Page, prompt: string): Promise<void> {
  await page.goto('/')
  await page.click('button.wizard-next')
  await page.fill('textarea[data-field="prompt"]', prompt)
  await page.click('button.wizard-next')
  await page.click('button.wizard-next')
}

async function connect(page: Page, preset: string, key: string): Promise<void> {
  await page.selectOption('.provider-band select', preset)
  await page.fill('input[placeholder*="API key"]', key)
  await page.click('text=Load models')
}

async function pick(page: Page, id: string): Promise<void> {
  await page.click(`.pick-col .model-row:has(.model-id:text-is("${id}"))`)
}

async function reportRow(page: Page, model: string, param: string) {
  const card = page.locator('.review-model').filter({ hasText: model })
  if (!(await card.locator('.report-table').isVisible())) await card.locator('summary').click()
  return card.locator('.report-table tr').filter({ hasText: param })
}

test.describe('OpenAI native (mocked)', () => {
  test('filters non-chat ids, spells the cap max_completion_tokens, omits temperature on gpt-5 with a reason, sends the bearer key', async ({ page }) => {
    const seen = await mockProviders(page)
    await toModels(page, 'Say hello')
    await connect(page, 'openai', 'sk-test-key')
    // gpt-5, its dated snapshot, gpt-4.1-mini; not whisper, embeddings, or the Responses-only pro model.
    await expect(page.locator('.pick-col .model-row')).toHaveCount(3)
    await pick(page, 'gpt-5')
    await pick(page, 'gpt-4.1-mini')
    await page.click('button.wizard-next')
    await page.selectOption('[data-field="temperatureWords"]', 'focused')
    await page.selectOption('[data-field="effort"]', 'less')
    await page.click('button.wizard-next')
    await expect(page.locator('.review-model')).toHaveCount(2)
    await expect(await reportRow(page, 'gpt-5', 'temperature')).toContainText('only its default')
    await expect(await reportRow(page, 'gpt-5', 'reasoning_effort')).toContainText('minimal')
    await expect(await reportRow(page, 'gpt-4.1-mini', 'temperature')).toContainText('0.2')
    await expect(await reportRow(page, 'gpt-4.1-mini', 'max_completion_tokens')).toContainText('2048')
    await page.click('button.run-button')
    await expect(page.locator('.status.ok')).toHaveCount(2, { timeout: 20_000 })
    expect(seen.openai.bodies).toHaveLength(2)
    const gpt5 = seen.openai.bodies.find(b => b.model === 'gpt-5')!
    expect(gpt5).not.toHaveProperty('temperature')
    expect(gpt5.max_completion_tokens).toBe(2048)
    expect(gpt5.reasoning_effort).toBe('minimal')
    expect(seen.openai.headers[0]!.authorization).toBe('Bearer sk-test-key')
  })
})

test.describe('Anthropic native (mocked)', () => {
  test('reads the capability tree, requires max_tokens, puts the system prompt in its own field and effort under output_config', async ({ page }) => {
    const seen = await mockProviders(page)
    await page.goto('/')
    await page.click('button.wizard-next')
    await page.fill('textarea[data-field="prompt"]', 'Capital of France?')
    await page.click('.step.active .more-options summary')
    await page.fill('textarea[data-field="system"]', 'Answer in one word.')
    await page.click('button.wizard-next')
    await page.click('button.wizard-next')
    await connect(page, 'anthropic', 'sk-ant-test')
    await expect(page.locator('.pick-col .model-row')).toHaveCount(2)
    await pick(page, 'claude-sonnet-5')
    await pick(page, 'claude-haiku-4-5-20251001')
    await page.click('button.wizard-next')
    await page.selectOption('[data-field="effort"]', 'more')
    await page.click('button.wizard-next')
    await expect(await reportRow(page, 'claude-sonnet-5', 'output_config.effort')).toContainText('max')
    await expect(await reportRow(page, 'claude-haiku-4-5', 'output_config.effort')).toContainText('not reported')
    await page.click('button.run-button')
    await expect(page.locator('.status.ok')).toHaveCount(2, { timeout: 20_000 })
    const sonnet = seen.anthropic.bodies.find(b => b.model === 'claude-sonnet-5')!
    expect(sonnet.system).toBe('Answer in one word.')
    expect(sonnet.max_tokens).toBe(2048)
    expect((sonnet.output_config as { effort: string }).effort).toBe('max')
    expect(seen.anthropic.headers[0]!['x-api-key']).toBe('sk-ant-test')
    expect(seen.anthropic.headers[0]!['anthropic-version']).toBe('2023-06-01')
    await expect(page.locator('.final-table')).toContainText('claude says: Capital of France?')
  })
})

test.describe('OpenRouter (mocked)', () => {
  test('hides batch and free routes by default, uses per-model cap spelling, sends the routing block, records the sub-provider and cost', async ({ page }) => {
    const seen = await mockProviders(page)
    await toModels(page, 'Route me')
    await connect(page, 'openrouter', 'sk-or-test')
    // :batch hidden always; :free hidden by default -> two rows.
    await expect(page.locator('.pick-col .model-row')).toHaveCount(2)
    await page.uncheck('.model-filters input[type=checkbox] >> nth=0')
    await expect(page.locator('.pick-col .model-row')).toHaveCount(3)
    await pick(page, 'openai/gpt-5')
    await pick(page, 'anthropic/claude-sonnet-4.5')
    await page.click('button.wizard-next')
    await page.selectOption('[data-field="temperatureWords"]', 'balanced')
    await page.click('button.wizard-next')
    await expect(await reportRow(page, 'openai/gpt-5', 'temperature')).toContainText('only its default')
    await expect(await reportRow(page, 'anthropic/claude-sonnet-4.5', 'temperature')).toContainText('0.7')
    await expect(await reportRow(page, 'openai/gpt-5', 'provider')).toContainText('require_parameters')
    await page.click('button.run-button')
    await expect(page.locator('.status.ok')).toHaveCount(2, { timeout: 20_000 })
    const gpt5 = seen.openrouter.bodies.find(b => b.model === 'openai/gpt-5')!
    expect(gpt5.provider).toEqual({ require_parameters: true })
    expect(gpt5).not.toHaveProperty('temperature')
    const sonnet = seen.openrouter.bodies.find(b => b.model === 'anthropic/claude-sonnet-4.5')!
    expect(sonnet.temperature).toBe(0.7)
    // Cost from the router's usage.cost and the sub-provider appear on the row detail.
    await page.click('.final-table tbody tr >> nth=0')
    await expect(page.locator('.detail-dialog')).toContainText('via Azure')
    await expect(page.locator('.detail-dialog')).toContainText('$0.000123')
  })

  test('the per-model gear: a response-format override and extras reach the body; structural keys do not', async ({ page }) => {
    const seen = await mockProviders(page)
    await toModels(page, 'Gear test')
    await connect(page, 'openrouter', 'sk-or-test')
    await pick(page, 'anthropic/claude-sonnet-4.5')
    await page.click('.selected-col .gear')
    await page.fill('.settings-dialog textarea', '{"top_p": 0.9, "model": "hijack", "seed": 7}')
    await page.fill('.settings-dialog input[placeholder*="Azure"]', 'Anthropic')
    await page.click('.settings-dialog button:has-text("Done")')
    await page.click('button.wizard-next')
    await page.click('button.wizard-next')
    await expect(await reportRow(page, 'anthropic/claude-sonnet-4.5', 'top_p')).toContainText('sent as typed')
    await expect(await reportRow(page, 'anthropic/claude-sonnet-4.5', 'hijack')).toContainText('structural')
    await page.click('button.run-button')
    await expect(page.locator('.status.ok')).toHaveCount(1, { timeout: 20_000 })
    const body = seen.openrouter.bodies[0]!
    expect(body.top_p).toBe(0.9)
    expect(body.seed).toBe(7)
    expect(body.model).toBe('anthropic/claude-sonnet-4.5')
    expect((body.provider as { order: string[] }).order).toEqual(['Anthropic'])
  })
})
