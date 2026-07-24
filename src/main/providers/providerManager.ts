import crypto from 'node:crypto'
import { getDatabase } from '../db/database'
import { getProviderKey, saveProviderKey, removeProviderKey } from '../store/key-store'
import type { Provider, ModelInfo } from '../../shared/types'
import { BUILT_IN_PROVIDER_TEMPLATES } from '../../shared/defaults'

export function getAllProviders(): Provider[] {
  const rows = getDatabase().query<{
    id: string; name: string; base_url: string; model_list: string; enabled: number; created_at: number
  }>('SELECT * FROM providers ORDER BY name')

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    apiKey: getProviderKey(row.id) || '',
    models: JSON.parse(row.model_list || '[]') as ModelInfo[],
    enabled: row.enabled === 1
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
  if (!provider.apiKey) return []

  try {
    const resp = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      signal: AbortSignal.timeout(10_000)
    })
    if (!resp.ok) return []

    const body = await resp.json()
    const models: ModelInfo[] = (body.data || []).map((m: { id: string }) => ({
      id: m.id,
      name: m.id,
      providerId
    }))

    getDatabase().exec('UPDATE providers SET model_list = ? WHERE id = ?', [JSON.stringify(models), providerId])
    return models
  } catch {
    return []
  }
}

export function seedBuiltInProviders(): void {
  const count = getDatabase().queryOne<{ c: number }>('SELECT COUNT(*) as c FROM providers')
  if (count && count.c > 0) return

  for (const tpl of BUILT_IN_PROVIDER_TEMPLATES) {
    getDatabase().exec(
      'INSERT INTO providers (id, name, base_url, model_list, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      [crypto.randomUUID(), tpl.name, tpl.baseUrl, '[]', Date.now()]
    )
  }
  console.log(`[Providers] Seeded ${BUILT_IN_PROVIDER_TEMPLATES.length} built-in providers`)
}
