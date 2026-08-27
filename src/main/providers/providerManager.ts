import crypto from 'node:crypto'
import { getDatabase } from '../db/database'
import { getProviderKey, saveProviderKey, removeProviderKey } from '../store/key-store'
import type { Provider, ModelInfo } from '../../shared/types'
import { BUILT_IN_PROVIDER_TEMPLATES } from '../../shared/defaults'
import { fetchProxy } from '../local/fetchProxy'

export function getAllProviders(): Provider[] {
  const rows = getDatabase().query<{
    id: string; name: string; base_url: string; model_list: string; enabled: number
  }>('SELECT id, name, base_url, model_list, enabled FROM providers ORDER BY name')

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
  // 用户提供的 URL 优先；仅当用户留空时才回退内置模板 URL。
  // 注意不能模板优先：用户自定义网关命名为「OpenAI」时其 baseUrl 会被静默替换为官方地址。
  let url = baseUrl.trim()
  if (!url) {
    url = template?.baseUrl || ''
    if (!url) throw new Error('请填写 API 地址（或从内置厂商中选择）')
  } else {
    // 用户提供的 URL 一律校验合法性（无论名称是否命中内置模板）
    try {
      const u = new URL(url)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error('仅支持 http/https 协议')
      }
    } catch (err) {
      throw new Error(`API 地址无效: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

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
