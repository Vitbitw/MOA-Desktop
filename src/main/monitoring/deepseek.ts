// ─── DeepSeek 云端用量监控客户端 ───
// 职责：
//   1. 应用内登录窗：加载 platform.deepseek.com，登录后从 localStorage 捕获 userToken
//   2. 用量拉取：/user/balance（余额，Bearer API Key）；
//      /api/v0/usage/amount|cost（平台用量，Bearer userToken，回退 API Key）
//   3. 归一化为 DeepSeekUsage，区块级优雅降级
// 网络请求统一走 fetchProxy（尊重用户的网络代理设置）。
// 注意：平台用量接口需要浏览器登录态 userToken（localStorage），余额接口仅需 API Key。

import { BrowserWindow, session } from 'electron'
import { fetchProxy } from '../local/fetchProxy'
import { getUsageCredential, removeUsageCredential, saveUsageCredential } from '../store/key-store'
import type {
  DeepSeekBalance,
  DeepSeekBalanceInfo,
  DeepSeekDailyUsage,
  DeepSeekModelUsage,
  DeepSeekUsage,
  MonitorStatus,
  RemoteUsageSource
} from '../../shared/types'

const API_BASE = 'https://api.deepseek.com'
const PLATFORM_API_BASE = 'https://platform.deepseek.com/api/v0'
const LOGIN_URL = 'https://platform.deepseek.com'
const LOGIN_PARTITION = 'persist:deepseek'
const REQUEST_TIMEOUT_MS = 15_000

/** 登录后 localStorage 中可能存放 userToken 的键（按优先级尝试） */
const TOKEN_KEYS = ['userToken', 'user_token', 'USER_TOKEN']

let loginWin: BrowserWindow | null = null

// ─── 凭证 key 约定（与 commandCode 一致）───
export function usageTokenKey(sourceId: string): string {
  return sourceId
}
export function usageApiKeyKey(sourceId: string): string {
  return `${sourceId}.apiKey`
}

// ─── 登录窗 ───

/** 从登录窗页面的 localStorage 读取 userToken；命中（value 为非空字符串）则保存并返回 true。
 * 注意：userToken 的值是 JSON 包装 `{"value": "<token>", ...}`，未登录时 value 为 null，
 * 不能仅凭「值非空」判定命中，否则会误把占位结构当登录态导致登录窗被误关。 */
async function tryCaptureToken(win: BrowserWindow, sourceId: string): Promise<boolean> {
  try {
    const token = await win.webContents.executeJavaScript(
      `(() => { const keys = ${JSON.stringify(TOKEN_KEYS)}; for (const k of keys) { const raw = localStorage.getItem(k); if (!raw) continue; try { const parsed = JSON.parse(raw); if (parsed !== null && typeof parsed === 'object') { const inner = parsed.value; if (typeof inner === 'string' && inner.trim()) return inner.trim(); continue; } if (typeof parsed === 'string' && parsed.trim()) return parsed.trim(); continue; } catch { if (raw.trim()) return raw.trim(); } } return ''; })()`
    )
    if (typeof token === 'string' && token) {
      saveUsageCredential(usageTokenKey(sourceId), token)
      return true
    }
  } catch {
    // 页面未加载完 / 非受信域 → 视为未命中
  }
  return false
}

/**
 * 打开登录窗加载 platform.deepseek.com；用户在窗内登录后，从 localStorage 捕获 userToken。
 * 轮询每 1.2s 检查一次；命中即保存、关窗、resolve success。
 * 关窗兜底：close 时再尝试读取一次（宽限期 4s），仍无 → cancelled（静默）。
 */
export function loginToDeepSeek(
  source: RemoteUsageSource,
  parent?: BrowserWindow | null
): Promise<{ success: boolean; cancelled?: boolean; error?: string }> {
  return new Promise(async (resolve) => {
    if (loginWin && !loginWin.isDestroyed()) {
      loginWin.focus()
      resolve({ success: false, cancelled: true })
      return
    }

    let settled = false
    let captured = false
    const finish = (r: { success: boolean; cancelled?: boolean; error?: string }) => {
      if (!settled) {
        settled = true
        resolve(r)
      }
    }

    const ses = session.fromPartition(LOGIN_PARTITION)

    loginWin = new BrowserWindow({
      width: 960,
      height: 720,
      parent: parent ?? undefined,
      modal: !!parent,
      autoHideMenuBar: true,
      title: '登录 DeepSeek 开放平台',
      webPreferences: {
        // 必须复用同一 partition，localStorage 才会持久化在同一会话
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    const win = loginWin

    // 仅在页面加载完成后轮询（避免 executeJavaScript 在 document 就绪前执行）。
    // 不设「立即复用旧 token」：SPA 加载初期可能短暂读到旧的过期 token，统一交给轮询 + value 校验判断。
    let pollTimer: ReturnType<typeof setInterval> | null = null
    const startPolling = () => {
      if (captured || settled) return
      pollTimer = setInterval(async () => {
        if (captured) return
        if (await tryCaptureToken(win, source.id)) {
          captured = true
          finish({ success: true })
          win.close()
        }
      }, 1200)
    }

    win.webContents.on('did-finish-load', () => {
      startPolling()
    })

    win.on('closed', () => {
      if (pollTimer) clearInterval(pollTimer)
      loginWin = null
      if (!captured && !settled) {
        // 宽限期：localStorage 可能刚写入，关窗后 4s 内再尝试
        let attempts = 0
        const graceTimer = setInterval(async () => {
          if (captured || settled) {
            clearInterval(graceTimer)
            return
          }
          attempts++
          if (await tryCaptureToken(win, source.id)) {
            captured = true
            clearInterval(graceTimer)
            finish({ success: true })
            return
          }
          if (attempts >= 8) {
            clearInterval(graceTimer)
            finish({ success: false, cancelled: true })
            console.warn('[Monitor] DeepSeek login window closed, userToken not captured after grace period')
          }
        }, 500)
        return
      }
      finish({ success: false, cancelled: true })
    })

    win.webContents.on('did-fail-load', () => {
      // 加载失败不立即终止，用户可手动刷新
    })

    win.loadURL(source.studioUrl || LOGIN_URL).catch(() => {
      finish({ success: false, error: '无法打开登录页面' })
    })
  })
}

/** 清除某监控源的登录态与 API Key */
export function logoutDeepSeek(sourceId: string): void {
  removeUsageCredential(usageTokenKey(sourceId))
  removeUsageCredential(usageApiKeyKey(sourceId))
}

/** 查询某监控源的认证状态：登录态 = 有 userToken 或有 API Key */
export function getDeepSeekStatus(sourceId: string): MonitorStatus {
  return {
    loggedIn: !!getUsageCredential(usageTokenKey(sourceId)) || !!getUsageCredential(usageApiKeyKey(sourceId)),
    hasApiKey: !!getUsageCredential(usageApiKeyKey(sourceId))
  }
}

// ─── API 客户端 ───

interface DsResponse {
  status: number
  body: unknown
}

/** 平台用量 / 余额请求（Bearer 认证），超时与重试统一由 fetchProxy 处理 */
async function dsGet(
  url: string,
  token: string,
  extraHeaders: Record<string, string> = {}
): Promise<DsResponse> {
  try {
    const resp = await fetchProxy(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'moa-desktop',
        ...extraHeaders
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    const body = await resp.json().catch(() => null)
    return { status: resp.status, body }
  } catch (err) {
    return { status: 0, body: null }
  }
}

/** 余额请求（Bearer API Key，官方公开接口） */
function fetchBalance(apiKey: string): Promise<DsResponse> {
  return dsGet(`${API_BASE}/user/balance`, apiKey)
}

/** 平台余额请求（Bearer userToken，登录态即可，无需 API Key）。
 * GET /api/v0/users/get_user_summary → data.biz_data.{ normal_wallets, bonus_wallets, total_costs } */
function fetchUserSummary(userToken: string): Promise<DsResponse> {
  return dsGet(`${PLATFORM_API_BASE}/users/get_user_summary`, userToken, {
    Referer: 'https://platform.deepseek.com/usage'
  })
}

/** 平台用量请求（Bearer userToken / API Key），需带 Referer 通过平台校验 */
function fetchPlatformUsage(kind: 'amount' | 'cost', token: string, year: number, month: number): Promise<DsResponse> {
  return dsGet(`${PLATFORM_API_BASE}/usage/${kind}?month=${month}&year=${year}`, token, {
    Referer: 'https://platform.deepseek.com/usage'
  })
}

// ─── 防御性解析 ───

function toNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object'
}

/** 解析 /user/balance（{ is_available, balance_infos: [{currency,total_balance,granted_balance,topped_up_balance}] }） */
function parseBalance(body: unknown): DeepSeekBalance | undefined {
  if (!isObj(body)) return undefined
  const infos: DeepSeekBalanceInfo[] = []
  if (Array.isArray(body.balance_infos)) {
    for (const raw of body.balance_infos) {
      if (!isObj(raw)) continue
      const totalBalance = toNum(raw.total_balance)
      if (totalBalance === undefined) continue
      infos.push({
        currency: typeof raw.currency === 'string' ? raw.currency : 'CNY',
        totalBalance,
        grantedBalance: toNum(raw.granted_balance) ?? 0,
        toppedUpBalance: toNum(raw.topped_up_balance) ?? 0
      })
    }
  }
  if (infos.length === 0) return undefined
  return { isAvailable: body.is_available !== false, infos }
}

/** 解析 /api/v0/users/get_user_summary：
 * data.biz_data.{ normal_wallets: [{currency,balance,token_estimation}], bonus_wallets: [...], total_costs: [{currency,amount}] }
 * 充值余额 = normal_wallets（可负，透支），赠送余额 = bonus_wallets，总余额 = 两者之和 */
function parseUserSummary(body: unknown): DeepSeekBalance | undefined {
  const root = isObj(body) ? body : null
  const data = root && isObj(root.data) ? root.data : null
  const biz = data && isObj(data.biz_data) ? data.biz_data : null
  if (!biz) return undefined

  const walletSum = (arr: unknown): Map<string, number> => {
    const byCur = new Map<string, number>()
    if (!Array.isArray(arr)) return byCur
    for (const w of arr) {
      if (!isObj(w)) continue
      const currency = typeof w.currency === 'string' ? w.currency : 'CNY'
      const balance = toNum(w.balance)
      if (balance === undefined) continue
      byCur.set(currency, (byCur.get(currency) ?? 0) + balance)
    }
    return byCur
  }

  const normal = walletSum(biz.normal_wallets)
  const bonus = walletSum(biz.bonus_wallets)
  const currencies = new Set([...normal.keys(), ...bonus.keys()])
  const infos: DeepSeekBalanceInfo[] = []
  for (const currency of currencies) {
    const toppedUpBalance = normal.get(currency) ?? 0
    const grantedBalance = bonus.get(currency) ?? 0
    if (toppedUpBalance === 0 && grantedBalance === 0) continue
    infos.push({ currency, totalBalance: toppedUpBalance + grantedBalance, grantedBalance, toppedUpBalance })
  }
  if (infos.length === 0) return undefined
  // 有透支（充值余额为负）视为余额不可用；否则可用
  const isAvailable = infos.every((f) => f.totalBalance > 0)
  return { isAvailable, infos }
}

/** 从单模型记录提取 usage 数值映射（按 type → amount，amount 为字符串） */
function usageMap(record: unknown): Record<string, number> {
  const map: Record<string, number> = {}
  if (!isObj(record) || !Array.isArray(record.usage)) return map
  for (const u of record.usage) {
    if (!isObj(u)) continue
    const type = typeof u.type === 'string' ? u.type : ''
    if (!type) continue
    map[type] = toNum(u.amount) ?? 0
  }
  return map
}

interface UsagePayload {
  total: unknown[]
  days: unknown[]
}

/** 提取 total/days：biz_data 可能是对象（amount）或数组（cost，取首个） */
function extractPayload(body: unknown): UsagePayload | null {
  const root = isObj(body) ? body : null
  const data = root && isObj(root.data) ? root.data : null
  const rawBizData = data ? data.biz_data : undefined
  let payload: unknown = rawBizData
  if (Array.isArray(rawBizData)) payload = rawBizData[0] ?? undefined
  if (!isObj(payload)) return null
  return {
    total: Array.isArray(payload.total) ? payload.total : [],
    days: Array.isArray(payload.days) ? payload.days : []
  }
}

/** 解析 amount 响应：按模型聚合 input/output/total/requests */
function parseAmount(
  payload: UsagePayload
): { models: DeepSeekModelUsage[]; monthTokens: number; requests: number } {
  const byModel = new Map<string, DeepSeekModelUsage>()
  let monthTokens = 0
  let requests = 0

  const addTotal = (raw: unknown) => {
    const model = isObj(raw) && typeof raw.model === 'string' ? raw.model : ''
    const m = usageMap(raw)
    const input = (m.PROMPT_TOKEN ?? 0) + (m.PROMPT_CACHE_HIT_TOKEN ?? 0) + (m.PROMPT_CACHE_MISS_TOKEN ?? 0)
    const output = m.RESPONSE_TOKEN ?? 0
    const req = m.REQUEST ?? 0
    const total = input + output
    monthTokens += total
    requests += req
    if (!model) return
    const cur = byModel.get(model) ?? { model, inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, cost: 0 }
    cur.inputTokens += input
    cur.outputTokens += output
    cur.totalTokens += total
    cur.requests += req
    byModel.set(model, cur)
  }

  for (const raw of payload.total) addTotal(raw)

  return { models: Array.from(byModel.values()), monthTokens, requests }
}

/** 解析 cost 响应：按模型聚合花费 + 每日花费 */
function parseCost(payload: UsagePayload): { costByModel: Map<string, number>; costByDay: Map<string, number> } {
  const costByModel = new Map<string, number>()
  const costByDay = new Map<string, number>()

  const sumCost = (record: unknown): number => {
    let cost = 0
    if (!isObj(record) || !Array.isArray(record.usage)) return cost
    for (const u of record.usage) {
      if (!isObj(u)) continue
      if (u.type === 'REQUEST') continue
      cost += toNum(u.amount) ?? 0
    }
    return cost
  }

  for (const raw of payload.total) {
    const model = isObj(raw) && typeof raw.model === 'string' ? raw.model : ''
    if (!model) continue
    costByModel.set(model, (costByModel.get(model) ?? 0) + sumCost(raw))
  }

  for (const day of payload.days) {
    if (!isObj(day) || typeof day.date !== 'string') continue
    let dayCost = 0
    if (Array.isArray(day.data)) {
      for (const raw of day.data) dayCost += sumCost(raw)
    }
    costByDay.set(day.date, (costByDay.get(day.date) ?? 0) + dayCost)
  }

  return { costByModel, costByDay }
}

/** 生成近 7 日（含今天）日期键，格式 YYYY-MM-DD */
function lastSevenDaysKeys(today = new Date()): string[] {
  const keys: string[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(today.getDate() - i)
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    keys.push(`${d.getFullYear()}-${mm}-${dd}`)
  }
  return keys
}

/** 把日期字符串归一化为数值（年*10000 + 月*100 + 日），兼容 2026-08-01 / 2026-8-1 / 2026/08/01 */
function toDateNum(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(v.trim())
  if (!m) return null
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3])
}

// ─── 主入口：拉取并归一化 ───

export type DeepSeekRefreshResult =
  | { ok: true; data: DeepSeekUsage }
  | { ok: false; code: 'not_authenticated' | 'session_expired' | 'network' | 'unknown'; error?: string }

/**
 * 拉取 DeepSeek 用量。
 * 并行请求：余额（API Key，可选）+ 平台用量 amount/cost（userToken，回退 API Key）。
 * 用量接口 401/403 → session_expired；其余网络异常 → network。
 */
export async function refreshDeepSeekUsage(source: RemoteUsageSource): Promise<DeepSeekRefreshResult> {
  const apiKey = getUsageCredential(usageApiKeyKey(source.id))
  const userToken = getUsageCredential(usageTokenKey(source.id))
  if (!apiKey && !userToken) return { ok: false, code: 'not_authenticated' }

  const usageToken = userToken || apiKey!
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1

  const jobs: Promise<DsResponse>[] = []
  // 余额：登录态（userToken）优先，无需 API Key；仅有 API Key 时回退官方 /user/balance
  const hasBalanceSource = !!userToken || !!apiKey
  if (userToken) jobs.push(fetchUserSummary(userToken))
  else if (apiKey) jobs.push(fetchBalance(apiKey))
  jobs.push(fetchPlatformUsage('amount', usageToken, year, month), fetchPlatformUsage('cost', usageToken, year, month))
  let results: PromiseSettledResult<DsResponse>[]
  try {
    results = await Promise.allSettled(jobs)
  } catch (err) {
    return { ok: false, code: 'network', error: err instanceof Error ? err.message : String(err) }
  }

  const get = (i: number): DsResponse | null => (results[i]?.status === 'fulfilled' ? results[i].value : null)
  const balRes = hasBalanceSource ? get(0) : null
  const amtRes = get(hasBalanceSource ? 1 : 0)
  const costRes = get(hasBalanceSource ? 2 : 1)
  console.log(`[Monitor] deepseek refresh(${source.id}): balance=${balRes?.status ?? 0} amount=${amtRes?.status ?? 0} cost=${costRes?.status ?? 0} (balanceSrc=${userToken ? 'userSummary' : apiKey ? 'userBalance' : 'none'}, usageAuth=${userToken ? 'userToken' : 'apiKey'})`)

  // 用量接口 401/403 → 登录态失效（userToken 过期或 API Key 无权访问平台用量）
  if ((amtRes && (amtRes.status === 401 || amtRes.status === 403)) || (costRes && (costRes.status === 401 || costRes.status === 403))) {
    return { ok: false, code: 'session_expired' }
  }

  const data: DeepSeekUsage = { fetchedAt: Date.now(), sourcesAvailable: { balance: false, usage: false } }

  // 余额：userToken → get_user_summary；仅 API Key → /user/balance
  if (hasBalanceSource && balRes && balRes.status === 200) {
    const balance = userToken ? parseUserSummary(balRes.body) : parseBalance(balRes.body)
    if (balance) {
      data.balance = balance
      data.sourcesAvailable.balance = true
    }
  }

  // 用量（需 amount 与 cost 至少一个成功）
  const amtPayload = amtRes && amtRes.status === 200 ? extractPayload(amtRes.body) : null
  const costPayload = costRes && costRes.status === 200 ? extractPayload(costRes.body) : null
  // 诊断：接口状态与解析结果，用于排查趋势/用量数据异常
  console.log(
    `[Monitor] deepseek usage parse: amount=${amtRes?.status ?? 0}(${amtPayload ? `total:${amtPayload.total.length},days:${amtPayload.days.length}` : 'null'}) cost=${costRes?.status ?? 0}(${costPayload ? `total:${costPayload.total.length},days:${costPayload.days.length}` : 'null'})`
  )
  if (amtRes && amtRes.status !== 500) {
    const preview = JSON.stringify(amtRes?.body ?? null)
    console.log(`[Monitor] deepseek amount body (${preview.length} chars):`, preview.slice(0, 300))
  }
  if (amtPayload || costPayload) {
    const amount = amtPayload ? parseAmount(amtPayload) : null
    const cost = costPayload ? parseCost(costPayload) : null

    // 按模型合并：tokens 来自 amount，花费来自 cost
    const models = new Map<string, DeepSeekModelUsage>()
    if (amount) {
      for (const m of amount.models) models.set(m.model, m)
    }
    if (cost) {
      for (const [model, c] of cost.costByModel) {
        const cur = models.get(model) ?? { model, inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, cost: 0 }
        cur.cost = c
        models.set(model, cur)
      }
    }
    const modelRows = Array.from(models.values())
      .filter((m) => m.totalTokens > 0 || m.cost > 0)
      .sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens)
    if (modelRows.length > 0) data.models = modelRows

    // 日趋势（近 7 日）：日期统一归一化为数值 key，避免格式/时区差异导致全部失配
    const tokensByDay = new Map<number, number>()
    const amtDays = amtPayload?.days ?? []
    for (const day of amtDays) {
      if (!isObj(day)) continue
      const dn = toDateNum(day.date)
      if (dn === null) continue
      let tokens = 0
      if (Array.isArray(day.data)) {
        for (const raw of day.data) {
          const m = usageMap(raw)
          tokens += (m.PROMPT_TOKEN ?? 0) + (m.PROMPT_CACHE_HIT_TOKEN ?? 0) + (m.PROMPT_CACHE_MISS_TOKEN ?? 0) + (m.RESPONSE_TOKEN ?? 0)
        }
      }
      tokensByDay.set(dn, (tokensByDay.get(dn) ?? 0) + tokens)
    }
    const rawCostByDay = cost?.costByDay ?? new Map<string, number>()
    const costByDay = new Map<number, number>()
    for (const [date, c] of rawCostByDay) {
      const dn = toDateNum(date)
      if (dn !== null) costByDay.set(dn, (costByDay.get(dn) ?? 0) + c)
    }
    const sevenKeys = lastSevenDaysKeys(now)
    const daily: DeepSeekDailyUsage[] = sevenKeys.map((key) => {
      const dn = toDateNum(key) ?? 0
      return {
        date: key,
        tokens: Math.round(tokensByDay.get(dn) ?? 0),
        cost: costByDay.get(dn) ?? 0
      }
    })
    data.daily = daily
    console.log(`[Monitor] deepseek daily generated: ${daily.map((d) => `${d.date.slice(5)}:${d.tokens}`).join(' ')}`)

    const today = daily[6]
    data.todayTokens = today?.tokens ?? 0
    data.todayCost = today?.cost ?? 0
    // 当月汇总：amount.total 为当月全部 tokens，cost.total 为当月全部花费（近 7 日只是当月子集）
    data.monthTokens = amount?.monthTokens ?? Math.round(daily.reduce((sum, d) => sum + d.tokens, 0))
    data.monthCost = cost ? Array.from(cost.costByModel.values()).reduce((sum, c) => sum + c, 0) : daily.reduce((sum, d) => sum + d.cost, 0)
    // 余额中有币种则用余额币种，否则 CNY
    data.currency = data.balance?.infos[0]?.currency ?? 'CNY'
    data.sourcesAvailable.usage = true
  }

  return { ok: true, data }
}