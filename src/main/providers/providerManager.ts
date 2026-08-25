import crypto from 'node:crypto'
import { getDatabase } from '../db/database'
import { getProviderKey, saveProviderKey, removeProviderKey } from '../store/key-store'
import type { Provider, ModelInfo, ProviderKind } from '../../shared/types'
import { BUILT_IN_PROVIDER_TEMPLATES } from '../../shared/defaults'
import { fetchProxy } from '../local/fetchProxy'

export function getAllProviders(): Provider[] {
  const rows = getDatabase().query<{
    id: string; name: string; base_url: string; model_list: string; enabled: number; created_at: number
    kind: string; engine_id: string | null
  }>('SELECT id, name, base_url, model_list, enabled, created_at, kind, engine_id FROM providers ORDER BY name')

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    apiKey: getProviderKey(row.id) || '',
    models: JSON.parse(row.model_list || '[]') as ModelInfo[],
    enabled: row.enabled === 1,
    kind: (row.kind || 'api') as ProviderKind,
    engineId: row.engine_id || undefined
  }))
}

export function addProvider(
  name: string,
  baseUrl: string,
  apiKey: string
): { id: string } {
  const template = BUILT_IN_PROVIDER_TEMPLATES.find((t) => t.name === name)
  const url = template?.baseUrl || baseUrl

  const id = crypto.randomUUID()
  getDatabase().exec(
    'INSERT INTO providers (id, name, base_url, model_list, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    [id, name, url, '[]', Date.now()]
  )

  if (apiKey) saveProviderKey(id, apiKey)

  return { id }
}

export function removeProvider(id: string): void {
  removeProviderKey(id)
  getDatabase().exec('DELETE FROM providers WHERE id = ?', [id])
}

export async function fetchAndCacheModels(providerId: string): Promise<ModelInfo[]> {
  const providers = getAllProviders()
  const provider = providers.find((p) => p.id === providerId)
  if (!provider) throw new Error(`Provider ${providerId} not found`)
  const isLocal = provider.kind === 'local'
  if (!isLocal && !provider.apiKey) return []

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`
    // P2-7：统一走 fetchProxy（本地引擎回环直连、云端 provider 可走网络代理）
    const resp = await fetchProxy(`${provider.baseUrl.replace(/\/+$/, '')}/models`, {
      headers,
      signal: AbortSignal.timeout(10_000)
    })
    if (!resp.ok) return []

    const body = await resp.json()
    // 兼容两种返回：OpenAI 风格 { data: [{ id }] } 与 /api/tags 风格 { models: [{ name }] }
    const rawList: Array<{ id: string; name?: string }> = Array.isArray(body.data) ? body.data : (Array.isArray(body.models) ? body.models : [])
    const models: ModelInfo[] = rawList.map((m: { id: string; name?: string }) => ({
      id: m.id || m.name || '',
      name: m.id || m.name || '',
      providerId
    })).filter((m) => m.id)

    getDatabase().exec('UPDATE providers SET model_list = ? WHERE id = ?', [JSON.stringify(models), providerId])
    return models
  } catch {
    return []
  }
}

export function seedBuiltInProviders(): void {
  const existing = getDatabase().query<{ name: string }>('SELECT name FROM providers')
  const existingNames = new Set(existing.map((row) => row.name))

  let added = 0
  for (const tpl of BUILT_IN_PROVIDER_TEMPLATES) {
    if (existingNames.has(tpl.name)) continue
    getDatabase().exec(
      'INSERT INTO providers (id, name, base_url, model_list, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      [crypto.randomUUID(), tpl.name, tpl.baseUrl, '[]', Date.now()]
    )
    added++
  }

  if (existing.length === 0) {
    console.log(`[Providers] Seeded ${BUILT_IN_PROVIDER_TEMPLATES.length} built-in providers`)
  } else if (added > 0) {
    console.log(`[Providers] Added ${added} new built-in provider(s)`)
  } else {
    console.log(`[Providers] All ${BUILT_IN_PROVIDER_TEMPLATES.length} built-in providers already present`)
  }
}
