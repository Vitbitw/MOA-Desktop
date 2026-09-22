import crypto from 'node:crypto'
import { getDatabase } from '../db/database'
import { getProviderKey, saveProviderKey, removeProviderKey } from '../store/key-store'
import type { Provider, ModelInfo, ProviderUpdatePatch } from '../../shared/types'
import { BUILT_IN_PROVIDER_TEMPLATES, PLAN_BILLING_NAMES, VENDOR_GROUP } from '../../shared/defaults'
import { fetchProxy } from '../local/fetchProxy'
import { broadcastToUi } from '../uiBridge'
import { IPC_EVENT } from '../../shared/ipc-channels'

export function getAllProviders(): Provider[] {
  const rows = getDatabase().query<{
    id: string; name: string; base_url: string; model_list: string; enabled: number
    vendor_key: string; billing: string
    plan_amount: number | null; plan_currency: string; plan_anchor_ts: number | null
  }>('SELECT id, name, base_url, model_list, enabled, vendor_key, billing, plan_amount, plan_currency, plan_anchor_ts FROM providers ORDER BY name')

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    apiKey: getProviderKey(row.id) || '',
    models: JSON.parse(row.model_list || '[]') as ModelInfo[],
    enabled: row.enabled === 1,
    vendorKey: row.vendor_key || '',
    billing: row.billing === 'plan' ? 'plan' : 'usage',
    plan: planFromRow(row.plan_amount, row.plan_currency, row.plan_anchor_ts)
  }))
}

/** 校验用户提供的 API 地址（仅 http/https），非法抛错；addProvider / updateProvider 共用 */
function validateProviderUrl(raw: string): string {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error('仅支持 http/https 协议')
    }
  } catch (err) {
    throw new Error(`API 地址无效: ${err instanceof Error ? err.message : String(err)}`)
  }
  return raw
}

/** plan_amount 缺失 / 0 = 「未配置订阅费」→ plan 字段整体为 undefined（消费端回退单价链估算） */
function planFromRow(
  amount: number | null,
  currency: string,
  anchorTs: number | null
): { amount: number; currency: 'USD' | 'CNY'; anchorTs?: number } | undefined {
  if (amount == null || amount <= 0) return undefined
  const plan: { amount: number; currency: 'USD' | 'CNY'; anchorTs?: number } = {
    amount,
    currency: currency === 'USD' ? 'USD' : 'CNY'
  }
  if (anchorTs != null) plan.anchorTs = anchorTs
  return plan
}

/** addProvider 可选扩展（T1）：同厂商分组 / 计费通道 / Plan 三件套 */
export interface AddProviderOpts {
  vendorKey?: string
  billing?: 'usage' | 'plan'
  plan?: { amount: number; currency: 'USD' | 'CNY'; anchorTs?: number }
}

export function addProvider(
  name: string,
  baseUrl: string,
  apiKey: string,
  opts?: AddProviderOpts
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
    url = validateProviderUrl(url)
  }

  const id = crypto.randomUUID()
  getDatabase().exec(
    'INSERT INTO providers (id, name, base_url, model_list, enabled, created_at, vendor_key, billing, plan_amount, plan_currency, plan_anchor_ts) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)',
    [
      id, name, url, '[]', Date.now(),
      opts?.vendorKey?.trim() ?? '',
      opts?.billing === 'plan' ? 'plan' : 'usage',
      opts?.plan?.amount ?? null,
      opts?.plan?.currency === 'USD' ? 'USD' : 'CNY',
      opts?.plan?.anchorTs ?? null
    ]
  )

  if (apiKey) saveProviderKey(id, apiKey)

  return { id }
}


/**
 * 编辑厂商（T1）：仅 patch 传入的字段更新，未传入的保持原值。
 * baseUrl 复用 addProvider 的 URL 校验；plan 传 null 清空订阅费三列。
 */
export function updateProvider(id: string, patch: ProviderUpdatePatch): void {
  const sets: string[] = []
  const params: unknown[] = []

  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name) throw new Error('厂商名称不能为空')
    sets.push('name = ?')
    params.push(name)
  }
  if (patch.baseUrl !== undefined) {
    sets.push('base_url = ?')
    params.push(validateProviderUrl(patch.baseUrl.trim()))
  }
  if (patch.vendorKey !== undefined) {
    sets.push('vendor_key = ?')
    params.push(patch.vendorKey.trim())
  }
  if (patch.billing !== undefined) {
    if (patch.billing !== 'usage' && patch.billing !== 'plan') {
      throw new Error(`计费通道无效: ${patch.billing}`)
    }
    sets.push('billing = ?')
    params.push(patch.billing)
  }
  if (patch.plan !== undefined) {
    // plan 视为一个字段整体写入：null = 清空（amount / anchor 置 NULL，currency 复位 CNY）
    sets.push('plan_amount = ?', 'plan_currency = ?', 'plan_anchor_ts = ?')
    params.push(patch.plan ? patch.plan.amount : null)
    params.push(patch.plan && patch.plan.currency === 'USD' ? 'USD' : 'CNY')
    params.push(patch.plan ? (patch.plan.anchorTs ?? null) : null)
  }
  if (sets.length === 0) return

  params.push(id)
  getDatabase().exec(`UPDATE providers SET ${sets.join(', ')} WHERE id = ?`, params)
}

/**
 * 改 API 密钥（T1，组内共享）：先查同 vendor_key（非空）的全部记录 id 并收集完整名单，
 * 再对名单内每个 id 写入同一值（复用 saveProviderKey）；vendor_key 为空 = 独立厂商只写自身。
 * 收集阶段异常向上抛（尚未写入任何 key）；写入阶段异常同样向上抛、不做静默吞错。
 */
export function updateProviderKey(id: string, apiKey: string): void {
  const row = getDatabase().queryOne<{ id: string; vendor_key: string }>(
    'SELECT id, vendor_key FROM providers WHERE id = ?',
    [id]
  )
  if (!row) throw new Error(`Provider ${id} not found`)

  // ① 收集全组 id（含自身防御：组查询万一漏掉自身也补上）
  let ids = [row.id]
  if (row.vendor_key) {
    const group = getDatabase().query<{ id: string }>(
      'SELECT id FROM providers WHERE vendor_key = ?',
      [row.vendor_key]
    )
    ids = group.map((r) => r.id)
    if (!ids.includes(row.id)) ids.push(row.id)
  }

  // ② 对收集到的 id 逐条写入同一值
  for (const targetId of ids) saveProviderKey(targetId, apiKey)
}

export function removeProvider(id: string): void {
  removeProviderKey(id)
  getDatabase().exec('DELETE FROM providers WHERE id = ?', [id])
}

export async function fetchAndCacheModels(
  providerId: string,
  opts?: { allowEmpty?: boolean }
): Promise<ModelInfo[]> {
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
    const rawList: Array<{ id: string; name?: string }> | null = Array.isArray(body.data)
      ? body.data
      : Array.isArray(body.models)
        ? body.models
        : null
    // 结构异常（两种字段都不是数组）：一律保留本地缓存，不落库不广播
    if (!rawList) return []
    const models: ModelInfo[] = rawList.map((m: { id: string; name?: string }) => ({
      id: m.id || m.name || '',
      name: m.id || m.name || '',
      providerId
    })).filter((m) => m.id)

    // 合法空列表（中转端点偶发 200 + {"data":[]} 与厂商真无模型无法区分）：
    // 探查路径只取关键词，保守保留缓存；手动「获取模型列表」allowEmpty=true 如实清空并广播
    if (models.length === 0 && opts?.allowEmpty !== true) return []

    const nextList = JSON.stringify(models)
    const changed = nextList !== JSON.stringify(provider.models ?? [])
    getDatabase().exec('UPDATE providers SET model_list = ? WHERE id = ?', [nextList, providerId])
    // 列表有变化才广播（探查可能连续刷新多个厂商，渲染进程合并为一次重拉）
    if (changed) broadcastToUi(IPC_EVENT.CONFIG_PROVIDERS_CHANGED, { providerId })
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
    // T1：新建条目直接写入预设分组 / 计费通道（migrate-only 清单命中才预设，未命中保持默认态）
    getDatabase().exec(
      'INSERT INTO providers (id, name, base_url, model_list, enabled, created_at, vendor_key, billing) VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
      [
        crypto.randomUUID(), tpl.name, tpl.baseUrl, '[]', Date.now(),
        VENDOR_GROUP[tpl.name] ?? '',
        PLAN_BILLING_NAMES.includes(tpl.name) ? 'plan' : 'usage'
      ]
    )
    added++
  }

  if (existing.length === 0) {
    console.log(`[Providers] Seeded ${BUILT_IN_PROVIDER_TEMPLATES.length} built-in providers`)
  } else if (added > 0) {
    console.log(`[Providers] Added ${added} new built-in provider(s)`)
  }
  // 无变化（全部已存在）不打日志：每次启动输出「All present」是无信息量噪音
}

/**
 * 启动 backfill（T1，设计文档 §1 / D4）：按名称清单给「默认态」旧记录补计费通道与厂商分组。
 * 仅当 billing='usage' AND vendor_key=''（用户从未改过）的记录才补写，已手动改过的不覆盖；
 * billing 与 vendor_key 两字段独立判断（清单命中谁补谁）；幂等，二次运行 no-op。
 * 全部写走 getDatabase().exec（触发 scheduleSave 落盘）。
 */
export function backfillProviderBilling(): void {
  const rows = getDatabase().query<{ id: string; name: string }>(
    "SELECT id, name FROM providers WHERE billing = 'usage' AND vendor_key = ''"
  )

  let billingPatched = 0
  let vendorPatched = 0
  for (const row of rows) {
    if (PLAN_BILLING_NAMES.includes(row.name)) {
      getDatabase().exec("UPDATE providers SET billing = 'plan' WHERE id = ?", [row.id])
      billingPatched++
    }
    const group = VENDOR_GROUP[row.name]
    if (group) {
      getDatabase().exec('UPDATE providers SET vendor_key = ? WHERE id = ?', [group, row.id])
      vendorPatched++
    }
  }

  if (billingPatched > 0 || vendorPatched > 0) {
    console.log(`[Providers] Backfilled billing=${billingPatched} vendorKey=${vendorPatched}`)
  }
}

