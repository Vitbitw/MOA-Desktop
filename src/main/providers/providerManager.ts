import crypto from 'node:crypto'
import { getDatabase } from '../db/database'
import { readAppSettings, updateRawAppSettings } from '../config/appSettings'
import { getProviderKey, saveProviderKey, removeProviderKey } from '../store/key-store'
import type { Provider, ProviderAccount, ProviderAccountInput, ProviderAccountPatch, ModelInfo, ProviderUpdatePatch } from '../../shared/types'
import { BUILT_IN_PROVIDER_TEMPLATES, PLAN_BILLING_NAMES } from '../../shared/defaults'
import { hasProviderAccess, isLocalBaseUrl } from '../../shared/providerAccess'
import { fetchProxy } from '../local/fetchProxy'
import { broadcastToUi } from '../uiBridge'
import { IPC_EVENT } from '../../shared/ipc-channels'

interface AccountRow {
  id: string
  provider_id: string
  label: string
  billing: string
  plan_amount: number | null
  plan_currency: string
  plan_anchor_ts: number | null
  active: number
  created_at: number
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

/** 账号核心字段（不含 Key）：DB 读出的形态，拼装 Provider 时再逐条补 Key */
type AccountCore = Omit<ProviderAccount, 'apiKey'>

function accountFromRow(row: AccountRow): AccountCore {
  const plan = planFromRow(row.plan_amount, row.plan_currency, row.plan_anchor_ts)
  return {
    id: row.id,
    providerId: row.provider_id,
    label: row.label || '',
    billing: row.billing === 'plan' ? 'plan' : 'usage',
    ...(plan ? { plan } : {}),
    active: row.active === 1
  }
}

/** 读全部账号行，按 provider_id 分组（保持 created_at 升序 = 展示顺序） */
function loadAccountsByProvider(): Map<string, AccountCore[]> {
  const rows = getDatabase().query<AccountRow>(
    'SELECT id, provider_id, label, billing, plan_amount, plan_currency, plan_anchor_ts, active, created_at FROM provider_accounts ORDER BY created_at, id'
  )
  const map = new Map<string, AccountCore[]>()
  for (const row of rows) {
    const acc = accountFromRow(row)
    const list = map.get(acc.providerId)
    if (list) list.push(acc)
    else map.set(acc.providerId, [acc])
  }
  return map
}

/** 当前账号：active=true 的那条；数据异常（无 active）时回退第一条 */
function pickActive<T extends { active: boolean }>(accounts: T[]): T | undefined {
  return accounts.find((a) => a.active) ?? accounts[0]
}

/**
 * 读全部厂商。
 * 账号层拆分后，`billing` / `plan` / `apiKey` 三项都是**当前账号的投影**——
 * 调用链（MoA / 网关 / 标题 / 探查）与成本记账只认这三项，天然只用当前账号，
 * 不会把别的账号的 Key 或通道串进请求与统计。
 */
export function getAllProviders(): Provider[] {
  const rows = getDatabase().query<{
    id: string
    name: string
    base_url: string
    model_list: string
    enabled: number
  }>('SELECT id, name, base_url, model_list, enabled FROM providers ORDER BY name')

  const accountsByProvider = loadAccountsByProvider()

  return rows.map((row) => {
    const accounts = (accountsByProvider.get(row.id) ?? []).map((a) => ({ ...a, apiKey: getProviderKey(a.id) || '' }))
    const active = pickActive(accounts)
    return {
      id: row.id,
      name: row.name,
      baseUrl: row.base_url,
      models: JSON.parse(row.model_list || '[]') as ModelInfo[],
      enabled: row.enabled === 1,
      accounts,
      activeAccountId: active?.id ?? row.id,
      billing: active?.billing ?? 'usage',
      ...(active?.plan ? { plan: active.plan } : {}),
      apiKey: active?.apiKey || ''
    }
  })
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

/** addProvider 可选扩展：首个账号的计费通道 / Plan 三件套 */
export interface AddProviderOpts {
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
    'INSERT INTO providers (id, name, base_url, model_list, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    [id, name, url, '[]', Date.now()]
  )
  // 首个账号 id **沿用 provider id**：历史 key-store 键与 request_logs.models.providerId 原样成立
  insertAccountRow({
    id,
    providerId: id,
    label: '',
    billing: opts?.billing === 'plan' ? 'plan' : 'usage',
    plan: opts?.plan,
    active: true
  })

  if (apiKey) saveProviderKey(id, apiKey)

  return { id }
}

/** 写入一条账号行（新建来源 / 新增账号共用） */
function insertAccountRow(args: {
  id: string
  providerId: string
  label: string
  billing: 'usage' | 'plan'
  plan?: { amount: number; currency: 'USD' | 'CNY'; anchorTs?: number }
  active: boolean
}): void {
  getDatabase().exec(
    'INSERT INTO provider_accounts (id, provider_id, label, billing, plan_amount, plan_currency, plan_anchor_ts, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      args.id,
      args.providerId,
      args.label,
      args.billing === 'plan' ? 'plan' : 'usage',
      args.plan?.amount ?? null,
      args.plan?.currency === 'USD' ? 'USD' : 'CNY',
      args.plan?.anchorTs ?? null,
      args.active ? 1 : 0,
      Date.now()
    ]
  )
}

/**
 * 编辑厂商（来源级字段）：仅 patch 传入的字段更新，未传入的保持原值。
 * baseUrl 复用 addProvider 的 URL 校验。计费通道 / 订阅费 / Key 属于账号，走 updateProviderAccount。
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
  if (sets.length === 0) return

  params.push(id)
  getDatabase().exec(`UPDATE providers SET ${sets.join(', ')} WHERE id = ?`, params)
}

// ─── 账号 CRUD ───

/**
 * 新增账号（同来源下数量不限）：新账号不自动成为当前账号——
 * 切换当前账号会改变调用用的 Key 与成本记账通道，必须由用户显式选择（setActiveProviderAccount）。
 */
export function addProviderAccount(providerId: string, input: ProviderAccountInput): { id: string } {
  const provider = getDatabase().queryOne<{ id: string }>('SELECT id FROM providers WHERE id = ?', [providerId])
  if (!provider) throw new Error(`Provider ${providerId} not found`)

  const id = crypto.randomUUID()
  const billing = input.billing === 'plan' ? 'plan' : 'usage'
  const existing = loadAccountsByProvider().get(providerId) ?? []
  insertAccountRow({
    id,
    providerId,
    label: (input.label ?? '').trim(),
    billing,
    plan: input.plan,
    // 第一个账号（理论仅出现在旧数据缺账号时）自动成为当前账号，保证来源始终可用
    active: existing.length === 0
  })
  if (input.apiKey) saveProviderKey(id, input.apiKey)

  return { id }
}

/**
 * 编辑账号：仅 patch 传入的字段更新。plan 传 null 清空订阅费（amount / currency / anchor 三列一并重置）。
 * 若改的是当前账号，来源投影（provider.billing / plan / apiKey）随之变化——调用与记账自动跟随。
 */
export function updateProviderAccount(accountId: string, patch: ProviderAccountPatch): void {
  const row = getDatabase().queryOne<AccountRow>('SELECT * FROM provider_accounts WHERE id = ?', [accountId])
  if (!row) throw new Error(`Account ${accountId} not found`)

  const sets: string[] = []
  const params: unknown[] = []

  if (patch.label !== undefined) {
    sets.push('label = ?')
    params.push(patch.label.trim())
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

  params.push(accountId)
  getDatabase().exec(`UPDATE provider_accounts SET ${sets.join(', ')} WHERE id = ?`, params)
}

/**
 * 删除账号：不得删除该来源的最后一个账号（来源必须至少有一个账号）。
 * 删除当前账号时自动把创建最早的剩余账号设为当前账号，来源不会失去可用 Key。
 */
export function removeProviderAccount(accountId: string): void {
  const row = getDatabase().queryOne<AccountRow>('SELECT * FROM provider_accounts WHERE id = ?', [accountId])
  if (!row) return

  const siblings = (loadAccountsByProvider().get(row.provider_id) ?? []).filter((a) => a.id !== accountId)
  if (siblings.length === 0) throw new Error('至少保留一个账号')

  getDatabase().exec('DELETE FROM provider_accounts WHERE id = ?', [accountId])
  removeProviderKey(accountId)
  if (row.active === 1) {
    getDatabase().exec('UPDATE provider_accounts SET active = 1 WHERE id = ?', [siblings[0].id])
  }
}

/** 切换当前账号：该来源此后所有调用与成本记账都用这个账号；每来源有且仅有一个当前账号 */
export function setActiveProviderAccount(providerId: string, accountId: string): void {
  const row = getDatabase().queryOne<{ id: string; provider_id: string }>(
    'SELECT id, provider_id FROM provider_accounts WHERE id = ?',
    [accountId]
  )
  if (!row) throw new Error(`Account ${accountId} not found`)
  if (row.provider_id !== providerId) throw new Error('账号不属于该厂商')

  getDatabase().exec('UPDATE provider_accounts SET active = 0 WHERE provider_id = ?', [providerId])
  getDatabase().exec('UPDATE provider_accounts SET active = 1 WHERE id = ?', [accountId])
}

/**
 * 改某账号的 API 密钥（账号级单条语义）：只写本账号。
 * 账号不存在抛错；写入失败时回滚本账号旧值后重抛。
 */
export function updateProviderKey(accountId: string, apiKey: string): void {
  const row = getDatabase().queryOne<{ id: string }>('SELECT id FROM provider_accounts WHERE id = ?', [accountId])
  if (!row) throw new Error(`Account ${accountId} not found`)

  const old = getProviderKey(accountId)
  try {
    saveProviderKey(accountId, apiKey)
  } catch (err) {
    try {
      if (old === undefined) removeProviderKey(accountId)
      else saveProviderKey(accountId, old)
    } catch (rollbackErr) {
      console.error('[Providers] key rollback failed:', accountId, rollbackErr)
    }
    throw err
  }
}

export function removeProvider(id: string): void {
  // 级联删账号与各自的 Key（sql.js 未开外键约束，须显式清理）
  const accounts = loadAccountsByProvider().get(id) ?? []
  for (const acc of accounts) removeProviderKey(acc.id)
  getDatabase().exec('DELETE FROM provider_accounts WHERE provider_id = ?', [id])
  removeProviderKey(id) // 旧版来源级键（迁移前的历史数据）兜底清理
  getDatabase().exec('DELETE FROM providers WHERE id = ?', [id])
}

export async function fetchAndCacheModels(
  providerId: string,
  opts?: { allowEmpty?: boolean }
): Promise<ModelInfo[]> {
  const providers = getAllProviders()
  const provider = providers.find((p) => p.id === providerId)
  if (!provider) throw new Error(`Provider ${providerId} not found`)
  if (!hasProviderAccess(provider)) return []

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
    // 本地回环模板不预置（本地厂商由用户「添加厂商」时插入）：免 Key 后预置行会立即可见，
    // 且删除后会被本逻辑复活——跳过 seed 让删除持久生效
    if (isLocalBaseUrl(tpl.baseUrl)) continue
    const id = crypto.randomUUID()
    getDatabase().exec(
      'INSERT INTO providers (id, name, base_url, model_list, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      [id, tpl.name, tpl.baseUrl, '[]', Date.now()]
    )
    // 预设通道写在默认账号上（migrate-only 清单命中才预设，未命中保持默认态）
    insertAccountRow({
      id,
      providerId: id,
      label: '',
      billing: PLAN_BILLING_NAMES.includes(tpl.name) ? 'plan' : 'usage',
      active: true
    })
    added++
  }

  if (existing.length === 0) {
    console.log(`[Providers] Seeded ${added} built-in providers`)
  } else if (added > 0) {
    console.log(`[Providers] Added ${added} new built-in provider(s)`)
  }
  // 无变化（全部已存在）不打日志：每次启动输出「All present」是无信息量噪音
}

/**
 * 启动 backfill：按名称清单给默认账号补 billing='plan'。
 * **一次性**（v4.1）：`billingBackfillDone` 置位后直接返回——避免用户手动把清单厂商改回 usage
 * 后在下次启动被静默覆盖。首次执行即置位（含 patched=0 的空跑）；执行中抛异常则不置位、下次重试。
 * 只动「默认账号」（id = provider_id）：用户自建账号的通道是显式选择，不参与按名称回填。
 * 全部写走 getDatabase().exec（触发 scheduleSave 落盘）。
 */
export function backfillProviderBilling(): void {
  if (readAppSettings().billingBackfillDone) return

  const rows = getDatabase().query<{ id: string; name: string }>(
    `SELECT a.id, p.name FROM provider_accounts a
     JOIN providers p ON p.id = a.provider_id
     WHERE a.billing = 'usage' AND a.id = a.provider_id`
  )

  let billingPatched = 0
  for (const row of rows) {
    if (PLAN_BILLING_NAMES.includes(row.name)) {
      getDatabase().exec("UPDATE provider_accounts SET billing = 'plan' WHERE id = ?", [row.id])
      billingPatched++
    }
  }

  updateRawAppSettings((raw) => {
    raw.billingBackfillDone = true
  })

  if (billingPatched > 0) {
    console.log(`[Providers] Backfilled billing=${billingPatched}`)
  }
}
