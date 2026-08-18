// Thin fetch layer for live provider data (model lists, ZDR endpoints).
// Parsing stays in core/providers; this only talks to the network.

import { modelListRequest, parseChatError, parseModelList, parseZdrModels } from '../core/providers'
import type { ProviderPreset } from '../core/providers'
import type { ModelCatalogEntry } from '../core/types'

export async function fetchModelList(preset: ProviderPreset, baseUrl: string, apiKey: string): Promise<ModelCatalogEntry[]> {
  const req = modelListRequest(preset, baseUrl, apiKey)
  const res = await fetch(req.url, { method: 'GET', headers: req.headers })
  const raw = await res.text()
  let json: unknown = null
  try {
    json = raw ? JSON.parse(raw) : null
  } catch {
    // keep raw for the error path
  }
  if (!res.ok) throw new Error(parseChatError(res.status, json, preset.provider.responseTransform))
  return parseModelList(json)
}

export async function fetchZdrModels(baseUrl: string): Promise<Set<string>> {
  const res = await fetch(`${baseUrl}/api/v1/endpoints/zdr`)
  const raw = await res.text()
  let json: unknown = null
  try {
    json = raw ? JSON.parse(raw) : null
  } catch {
    // keep raw for the error path
  }
  if (!res.ok) throw new Error(parseChatError(res.status, json))
  return parseZdrModels(json)
}