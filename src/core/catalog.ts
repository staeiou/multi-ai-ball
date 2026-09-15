// Model catalogs: one fetch per provider, each mapped through that provider's
// own guidance translator (providers/guidance.ts), then the hand-written
// exceptions. The list is the provider's authority for what exists; guidance
// is what it (or models.dev, for OpenAI) says about each model.

import { errorMessage } from './providers/shapes'
import {
  applyExceptions,
  catalogModelFromAnthropic,
  catalogModelFromCustom,
  catalogModelFromOpenAI,
  catalogModelFromOpenRouter,
  openRouterHidden,
} from './providers/guidance'
import type { CatalogModel, ProviderPreset } from './types'

type JsonRecord = Record<string, unknown>

export function modelListHeaders(preset: ProviderPreset, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { ...preset.headers }
  if (apiKey) {
    if (preset.auth.kind === 'bearer') headers.Authorization = `Bearer ${apiKey}`
    else if (preset.auth.header) headers[preset.auth.header] = apiKey
  }
  return headers
}

export function parseCatalog(preset: ProviderPreset, json: unknown): CatalogModel[] {
  const rows = Array.isArray((json as JsonRecord | null)?.data) ? ((json as JsonRecord).data as JsonRecord[]) : []
  const out: CatalogModel[] = []
  const seen = new Set<string>()
  for (const entry of rows) {
    let model: CatalogModel | null
    if (preset.id === 'openrouter') {
      const id = String(entry.id ?? '')
      if (openRouterHidden(id)) continue
      model = catalogModelFromOpenRouter(entry)
    } else if (preset.id === 'anthropic') model = catalogModelFromAnthropic(entry)
    else if (preset.id === 'openai') model = catalogModelFromOpenAI(entry)
    else model = catalogModelFromCustom(entry)
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    out.push(applyExceptions(preset.id, model))
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

export async function fetchCatalog(preset: ProviderPreset, baseUrl: string, apiKey: string): Promise<CatalogModel[]> {
  const url = `${baseUrl}${preset.modelsPath}${preset.id === 'anthropic' ? '?limit=1000' : ''}`
  const res = await fetch(url, { method: 'GET', headers: modelListHeaders(preset, apiKey) })
  const raw = await res.text()
  let json: unknown = null
  try { json = raw ? JSON.parse(raw) : null } catch { /* keep raw for the error */ }
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${errorMessage(json) ?? raw.slice(0, 200)}`)
  return parseCatalog(preset, json)
}

/** OpenRouter's ZDR-capable model ids (`/api/v1/endpoints/zdr`). */
export async function fetchZdrModels(baseUrl: string): Promise<Set<string>> {
  const res = await fetch(`${baseUrl}/api/v1/endpoints/zdr`)
  const raw = await res.text()
  let json: unknown = null
  try { json = raw ? JSON.parse(raw) : null } catch { /* keep raw */ }
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${errorMessage(json) ?? raw.slice(0, 200)}`)
  const rows = Array.isArray((json as JsonRecord | null)?.data) ? ((json as JsonRecord).data as JsonRecord[]) : []
  return new Set(rows.map(row => String(row.model_id ?? '')).filter(Boolean))
}
