// ─── Xiaomi MiMo 云端用量监控客户端 ───
// 职责：
//   1. 应用内登录窗：加载 platform.xiaomimimo.com，轮询捕获登录 Cookie（api-platform_serviceToken / userId 等）
//   2. 用量拉取（监控项目与 Command Code 对齐）：
//      - /api/v1/balance（账户余额）、/api/v1/tokenPlan/usage（Token Plan 套餐用量）
//      - /api/v1/tokenPlan/detail（订阅套餐：planCode / currentPeriodEnd / expired / enableAutoRenew）
//      - /api/v1/usage/detail/list（按量通道：当月 日期×模型 明细，含金额）
//      - /api/v1/usage/token-plan/list（套餐通道：当月 日期×模型 明细，无金额）
//      - 两通道明细按「日期 × 模型」合并 → 汇总 + 模型明细 + 本地累计
//      - 注：MiMo Token Plan 无 5小时/7天滚动窗口（官方 FAQ「no 5-hour cap or weekly usage limit」，
//        实测两个明细接口也无窗口字段），额度只有「套餐周期池」与「余额」两个口径，不解析窗口字段
//   3. 归一化为 MimoUsage，区块级优雅降级
// 网络请求统一走 fetchProxy（尊重用户的网络代理设置）。
// POST 端点须带 `?api-platform_ph=<cookie 值去引号>`（平台网关要求，详见 mimoPost）。
// 注意：MiMo 无 API Key 通道，余额/套餐查询全部基于登录 Cookie（约 24h 有效期，过期需重新登录）。
// 金额口径：MiMo 接口按账户币种返回（国内默认 CNY），主进程统一归一为 USD，
// 展示层沿用 formatCost(…, settings.currency)（CNY 展示 ×7.2，与全应用一致）。

import { BrowserWindow, session } from 'electron'
import { fetchProxy } from '../local/fetchProxy'
import { saveUsageCredential, getUsageCredential } from '../store/key-store'
import { persistUsageRecords, type AccumulatedRecordInput } from './usageAccumulator'
import type {
  MimoBalance,
  MimoSubscription,
  MimoTokenPlan,
  MimoUsage,
  RemoteUsageSource
} from '../../shared/types'

const API_BASE = 'https://platform.xiaomimimo.com/api/v1'
const LOGIN_URL = 'https://platform.xiaomimimo.com'
const LOGIN_PARTITION = 'persist:mimo'
const REQUEST_TIMEOUT_MS = 15_000
/** CNY → USD 折算率（与 provider_accounts.plan_currency、formatCost 展示换算同一口径） */
const CNY_TO_USD = 7.2
/** 诊断开关（MOA_MONITOR_DEBUG=1）：输出刷新状态，排查用量数据异常时开启 */
const DEBUG = process.env.MOA_MONITOR_DEBUG === '1'

/** 判定登录有效所需的关键 cookie 名。ph 同时用于 POST 端点的 query 参数（见 mimoPost）：
 *  缺失时会捕获到「GET 可用、POST 不可用」的中间态凭证 → 刷新必报登录过期 */
const REQUIRED_COOKIES = ['api-platform_serviceToken', 'userId', 'api-platform_ph']

let loginWin: BrowserWindow | null = null

// ─── 凭证（按**账号**键控；默认账号 id = 源 id）───

function credKey(accountId: string): string {
  return accountId
}

/** 从分区收集 MiMo 相关 cookie 拼装 Cookie 头；关键 cookie 缺失时返回 null */
async function buildCookieHeader(ses: Electron.Session): Promise<string | null> {
  try {
    const all = await ses.cookies.get({})
    const mimo = all.filter((c) => {
      const domain = (c.domain ?? '').toLowerCase()
      return domain.includes('xiaomimimo.com') || domain.includes('mimo.mi.com')
    })
    if (mimo.length === 0) return null
    const names = new Set(mimo.map((c) => c.name))
    if (!REQUIRED_COOKIES.every((n) => names.has(n))) return null
    return mimo.map((c) => `${c.name}=${c.value}`).join('; ')
  } catch {
    return null
  }
}

/**
 * 从 Cookie 头里取单个 cookie 的值。
 * 平台 Set-Cookie 会把值用双引号包裹（页面 document.cookie 可见 `"xxx=="` 形态），
 * 而网关比对与官网前端拼 query 用的都是**去引号**的值，故统一剥掉首尾引号。
 */
function cookieValue(cookieHeader: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(cookieHeader)
  if (!m) return undefined
  return m[1].replace(/^"|"$/g, '')
}

// ─── 登录窗 ───

export function loginToMimo(
  source: RemoteUsageSource,
  accountId: string,
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

    // 开窗前清掉分区里的旧登录 Cookie：它可能服务端已失效（会话被吊销）却仍留在 cookie jar 里，
    // 留着会走两条坏路径：①「分区有 Cookie 就复用、不开窗」短路返回 success，刷新依旧 401，
    // 点「重新登录」没反应；②只删短路也会被轮询在 1.5s 内命中 → 窗口闪一下即关，走不到重登。
    // 清空后窗口里必然是登录页，轮询只可能捕获本次新登录的 Cookie（一并覆盖「退出登录后换账号」）。
    await ses.clearStorageData({ storages: ['cookies'] })

    loginWin = new BrowserWindow({
      width: 960,
      height: 720,
      parent: parent ?? undefined,
      modal: !!parent,
      autoHideMenuBar: true,
      title: '登录 Xiaomi MiMo',
      webPreferences: {
        // 关键：必须复用同一 partition，登录 cookie 才会落在轮询的那个 session 里
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    // 轮询捕获 Cookie 头
    const pollTimer = setInterval(async () => {
      if (captured) return
      const header = await buildCookieHeader(ses)
      if (header) {
        captured = true
        clearInterval(pollTimer)
        saveUsageCredential(credKey(accountId), header)
        finish({ success: true })
        loginWin?.close()
      }
    }, 1500)

    loginWin.on('closed', () => {
      clearInterval(pollTimer)
      loginWin = null
      if (!captured) {
        // 宽限期：cookie 可能刚写入/正在落盘，关窗后 4s 内重试
        let attempts = 0
        const graceTimer = setInterval(async () => {
          if (captured || settled) {
            clearInterval(graceTimer)
            return
          }
          attempts++
          const header = await buildCookieHeader(ses)
          if (header) {
            captured = true
            clearInterval(graceTimer)
            saveUsageCredential(credKey(accountId), header)
            finish({ success: true })
            return
          }
          if (attempts >= 8) {
            clearInterval(graceTimer)
            finish({ success: false, cancelled: true })
            console.warn('[Monitor] MiMo login window closed, credential cookie not captured after grace period')
          }
        }, 500)
        return
      }
      finish({ success: false, cancelled: true })
    })

    loginWin.webContents.on('did-fail-load', () => {
      // 加载失败不立即终止，用户可手动刷新
    })

    loginWin.loadURL(source.studioUrl || LOGIN_URL).catch(() => {
      finish({ success: false, error: '无法打开登录页面' })
    })
  })
}

// ─── 拉取 ───

function toNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object'
}

export type MimoRefreshResult =
  | { ok: true; data: MimoUsage; /** 本次落库影响的累计行数（新增或数值变化；供采集器统计） */ persisted: number }
  | { ok: false; code: 'not_authenticated' | 'session_expired' | 'network' | 'unknown'; error?: string }

async function mimoGet(path: string, cookie: string): Promise<{ status: number; body: unknown }> {
  try {
    const resp = await fetchProxy(`${API_BASE}${path}`, {
      headers: { Cookie: cookie, Accept: 'application/json', 'User-Agent': 'moa-desktop' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    const body = await resp.json().catch(() => null)
    return { status: resp.status, body }
  } catch (err) {
    return { status: 0, body: null }
  }
}

/**
 * POST 请求。平台网关对 POST 端点额外要求 query 带 `api-platform_ph`
 * （值 = 同名 cookie 去引号后 URL 编码，与官网前端 29618 请求层 `credentials:"same-origin"` 同款）：
 * 缺失或带引号一律判未登录 → 401 + loginUrl + 服务端清登录 cookie。
 * 真实报障对齐：修复前 POST /usage/detail/list 恒 401，UI 误报「登录已过期（Cookie 约 24h 有效）」。
 * GET 端点无此要求。
 */
async function mimoPost(path: string, payload: unknown, cookie: string): Promise<{ status: number; body: unknown }> {
  const ph = cookieValue(cookie, 'api-platform_ph')
  const query = ph ? `?api-platform_ph=${encodeURIComponent(ph)}` : ''
  try {
    const resp = await fetchProxy(`${API_BASE}${path}${query}`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'moa-desktop'
      },
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    const body = await resp.json().catch(() => null)
    return { status: resp.status, body }
  } catch {
    return { status: 0, body: null }
  }
}

/** 解析余额（data 或 { code:0, data } 包裹） */
function parseBalance(body: unknown): MimoBalance | undefined {
  let d: unknown = body
  if (isObj(body) && body.code === 0 && body.data !== undefined) d = body.data
  if (!isObj(d)) return undefined
  const currency = typeof d.currency === 'string' ? d.currency : 'CNY'
  const balance = toNum(d.balance)
  const cashBalance = toNum(d.cashBalance)
  const giftBalance = toNum(d.giftBalance)
  const frozenBalance = toNum(d.frozenBalance)
  const overdraftLimit = toNum(d.overdraftLimit)
  const remainingOverdraftLimit = toNum(d.remainingOverdraftLimit)
  if (balance === undefined) return undefined
  return {
    currency,
    balance,
    cashBalance: cashBalance ?? 0,
    giftBalance: giftBalance ?? 0,
    frozenBalance: frozenBalance ?? 0,
    overdraftLimit: overdraftLimit ?? 0,
    remainingOverdraftLimit: remainingOverdraftLimit ?? 0
  }
}

/** 解析 Token Plan 用量（{ code:0, data: { usage: { percent, items: [{name,used,limit,percent}] } } }）
 * 金额单位为 Credit 原数值（如 Standard 年度套餐总上限 1320 亿），展示层自行换算。
 * 服务端 percent 字段量纲存在歧义（实测 usage.percent=0.01 与 used/limit 真比值 0.63% 不一致），
 * 统一按 used/limit 重算，保证与「已用/总量」文字自洽；
 * limit=0 的补偿积分条目与官方前端一致地跳过（无意义的 0/0 进度行）。 */
function parseTokenPlan(body: unknown): { percent: number; items: NonNullable<MimoTokenPlan['items']> } | undefined {
  if (!isObj(body) || body.code !== 0) return undefined
  const data = isObj(body.data) ? body.data : null
  const usage = isObj(data?.usage) ? data.usage : null
  if (!usage) return undefined
  const items: MimoTokenPlan['items'] = []
  if (Array.isArray(usage.items)) {
    for (const raw of usage.items) {
      if (!isObj(raw) || typeof raw.name !== 'string') continue
      const used = toNum(raw.used)
      const limit = toNum(raw.limit)
      if (used === undefined || limit === undefined) continue
      if (raw.name === 'compensation_total_token' && limit === 0) continue
      items.push({
        name: raw.name,
        used,
        limit,
        percent: limit > 0 ? Math.min(100, (used / limit) * 100) : 0
      })
    }
  }
  if (items.length === 0) return undefined
  const canonical = items.find((i) => i.name === 'plan_total_token') ?? items[0]
  return { percent: canonical.percent, items }
}

// ─── 订阅套餐 / 窗口 / 明细（监控项目对齐 Command Code） ───

/** 兼容 `{ code:0, data }` / `{ success:true, data }` 包裹；无包裹时原样返回 */
function unwrapData(body: unknown): unknown {
  if (isObj(body)) {
    if (body.code === 0 && body.data !== undefined) return body.data
    if (body.success === true && body.data !== undefined) return body.data
  }
  return body
}

function pickStr(objs: Array<Record<string, unknown> | null>, keys: string[]): string | undefined {
  for (const o of objs) {
    if (!o) continue
    for (const k of keys) {
      const v = o[k]
      if (typeof v === 'string' && v.trim() !== '') return v.trim()
      if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    }
  }
  return undefined
}

function pickBool(objs: Array<Record<string, unknown> | null>, keys: string[]): boolean | undefined {
  for (const o of objs) {
    if (!o) continue
    for (const k of keys) {
      const v = o[k]
      if (typeof v === 'boolean') return v
      if (v === 1 || v === 0) return v === 1
      if (v === 'true' || v === 'false') return v === 'true'
    }
  }
  return undefined
}

/** 时间字段归一为 epoch 秒：兼容 epoch 秒 / epoch 毫秒 / 数字字符串 / 日期字符串 */
function pickTimeTs(objs: Array<Record<string, unknown> | null>, keys: string[]): number | undefined {
  for (const o of objs) {
    if (!o) continue
    for (const k of keys) {
      const v = o[k]
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        if (v > 1e12) return Math.round(v / 1000)
        if (v > 1e9) return Math.round(v)
      }
      if (typeof v === 'string' && v.trim() !== '') {
        const s = v.trim()
        if (/^\d+$/.test(s)) {
          const n = Number(s)
          if (n > 1e12) return Math.round(n / 1000)
          if (n > 1e9) return Math.round(n)
          continue
        }
        const t = Date.parse(s)
        if (Number.isFinite(t)) return Math.round(t / 1000)
      }
    }
  }
  return undefined
}

const SUB_PLAN_ID_KEYS = ['planCode', 'plan_code', 'planId', 'plan_id']
const SUB_PLAN_NAME_KEYS = ['planName', 'plan_name', 'packageName']
const SUB_STATUS_KEYS = ['status', 'state', 'subscriptionStatus']
const SUB_EXPIRE_KEYS = ['currentPeriodEnd', 'current_period_end', 'expireTime', 'expireAt', 'endTime', 'validUntil']
const SUB_AUTORENEW_KEYS = ['enableAutoRenew', 'enable_auto_renew', 'autoRenew', 'hasAutoRenewSubscribed']

/**
 * 解析订阅套餐（权威来源 /tokenPlan/detail，实测 data 为扁平结构：
 * planCode / planName / currentPeriodEnd / expired / enableAutoRenew / hasAutoRenewSubscribed）。
 * 状态口径：detail 只有 expired 布尔（无字符串 status）→ expired 是权威状态，status 兼容保留。
 * 返回 recognized=false 表示结构无法识别（sourcesAvailable.subscription 保持 false）；
 * recognized=true 但 subscription 缺省 = 明确的「无订阅」（detail.data 为空对象）。
 */
function parseSubscription(detailBody: unknown): { recognized: boolean; subscription?: MimoSubscription } {
  const data = unwrapData(detailBody)
  if (!isObj(data)) return { recognized: false }

  const planId = pickStr([data], SUB_PLAN_ID_KEYS)
  const planName = pickStr([data], SUB_PLAN_NAME_KEYS)
  const status = pickStr([data], SUB_STATUS_KEYS)
  const expireAtTs = pickTimeTs([data], SUB_EXPIRE_KEYS)
  const autoRenew = pickBool([data], SUB_AUTORENEW_KEYS)
  const expired = pickBool([data], ['expired'])

  const subscription: MimoSubscription = {
    ...(planId ? { planId } : {}),
    ...(planName ? { planName } : {}),
    ...(status ? { status } : {}),
    ...(expireAtTs !== undefined ? { expireAtTs } : {}),
    ...(autoRenew !== undefined ? { autoRenew } : {}),
    ...(expired !== undefined ? { expired } : {})
  }
  if (Object.keys(subscription).length > 0) return { recognized: true, subscription }

  // 无字段命中：200 + {code:0} 但 data 为空对象 → 识别为「无订阅」
  if (Object.keys(data).length === 0) return { recognized: true }
  return { recognized: false }
}

/** 明细行（/usage/detail/list 与 /usage/token-plan/list 单行归一化；金额为账户币种原值） */
interface MimoDetailRow {
  /** 日期键（'YYYY-MM-DD'；缺失时 'unknown'）——本地累计按 (date|model) 去重 */
  dateKey: string
  /** 日期 epoch 毫秒（UTC 当日零点；无法解析时省略） */
  dateTs?: number
  model: string
  requests: number
  tokensIn: number
  tokensOut: number
  tokensTotal: number
  /** 成本（账户币种原值，聚合后再归一 USD）；仅按量通道提供，套餐通道行为 undefined */
  costNative?: number
}

const ROW_ARRAY_KEYS = ['list', 'rows', 'records', 'items', 'details', 'detailList', 'usages', 'data', 'recordsList']

/** 从响应里取出明细行数组（裸数组或常见包裹键） */
function extractRowArray(body: unknown): unknown[] | null {
  const root = unwrapData(body)
  if (Array.isArray(root)) return root
  if (!isObj(root)) return null
  for (const k of ROW_ARRAY_KEYS) {
    const v = root[k]
    if (Array.isArray(v)) return v
    if (isObj(v)) {
      for (const k2 of ROW_ARRAY_KEYS) {
        const v2 = v[k2]
        if (Array.isArray(v2)) return v2
      }
    }
  }
  return null
}

/** 'YYYY-MM-DD' / 20260927 → epoch 毫秒（UTC 当日零点）；无法解析返回 undefined */
function dateKeyToTs(key: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(key)
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const m2 = /^(\d{4})(\d{2})(\d{2})$/.exec(key)
  if (m2) return Date.UTC(Number(m2[1]), Number(m2[2]) - 1, Number(m2[3]))
  return undefined
}

/** 解析明细单行（两接口列名同族：date/model/totalToken/inputHitToken/inputMissToken/outputToken/requestCount；
 *  withAmount=true（/usage/detail/list）额外读 consumedAmount 金额，套餐通道（token-plan/list）无金额字段） */
function parseDetailRow(raw: unknown, withAmount: boolean): MimoDetailRow | undefined {
  if (!isObj(raw)) return undefined
  const dateRaw = raw.date ?? raw.day ?? raw.statDate ?? raw.reportDate
  const dateKey = typeof dateRaw === 'string' && dateRaw.trim() !== '' ? dateRaw.trim() : typeof dateRaw === 'number' && Number.isFinite(dateRaw) ? String(dateRaw) : 'unknown'

  const hit = toNum(raw.inputHitToken ?? raw.input_hit_token)
  const miss = toNum(raw.inputMissToken ?? raw.input_miss_token)
  const tokensIn = toNum(raw.tokensIn ?? raw.tokens_in ?? raw.inputToken ?? raw.input_token) ?? (hit !== undefined || miss !== undefined ? (hit ?? 0) + (miss ?? 0) : undefined)
  const tokensOut = toNum(raw.tokensOut ?? raw.tokens_out ?? raw.outputToken ?? raw.output_token)
  const tokensTotal = toNum(raw.totalToken ?? raw.total_token ?? raw.tokensTotal ?? raw.tokens_total) ?? (tokensIn !== undefined || tokensOut !== undefined ? (tokensIn ?? 0) + (tokensOut ?? 0) : undefined)
  const requests = toNum(raw.requestCount ?? raw.request_count ?? raw.requests ?? raw.count) ?? 1
  const costNative = withAmount ? (toNum(raw.consumedAmount ?? raw.consumed_amount ?? raw.consumptionAmount ?? raw.amount ?? raw.cost) ?? 0) : undefined

  const modelRaw = raw.model ?? raw.modelName ?? raw.model_name
  const model = typeof modelRaw === 'string' ? modelRaw.trim() : ''

  // 一行至少要有一个可识别的用量/日期信号，否则视为非数据行丢弃
  const hasSignal =
    dateKey !== 'unknown' ||
    model !== '' ||
    tokensIn !== undefined ||
    tokensOut !== undefined ||
    tokensTotal !== undefined ||
    (costNative !== undefined && costNative > 0) ||
    raw.requestCount !== undefined ||
    raw.request_count !== undefined
  if (!hasSignal) return undefined

  const dateTs = dateKeyToTs(dateKey)
  return {
    dateKey,
    ...(dateTs !== undefined ? { dateTs } : {}),
    model,
    requests: Math.max(0, requests),
    tokensIn: Math.max(0, tokensIn ?? 0),
    tokensOut: Math.max(0, tokensOut ?? 0),
    tokensTotal: Math.max(0, tokensTotal ?? 0),
    ...(costNative !== undefined ? { costNative: Math.max(0, costNative) } : {})
  }
}

/** 解析按量明细响应（/usage/detail/list）：返回行数组 + 账户币种（响应内 currency 优先，其次余额接口，兜底 CNY） */
function parseUsageDetailList(body: unknown, balance?: MimoBalance): { rows: MimoDetailRow[]; currency: string } | null {
  const arr = extractRowArray(body)
  if (!arr) return null
  const rows: MimoDetailRow[] = []
  for (const raw of arr) {
    const r = parseDetailRow(raw, true)
    if (r) rows.push(r)
  }
  const root = unwrapData(body)
  const currencyRaw = isObj(root) ? pickStr([root, ...(isObj(root.data) ? [root.data] : [])], ['currency', 'currencyCode', 'currency_code']) : undefined
  const currency = currencyRaw === 'USD' || currencyRaw === 'CNY' ? currencyRaw : balance?.currency === 'USD' ? 'USD' : 'CNY'
  return { rows, currency }
}

/** 解析套餐通道明细响应（POST /usage/token-plan/list；行无金额字段，costNative 恒缺省） */
function parseTokenPlanList(body: unknown): MimoDetailRow[] | null {
  const arr = extractRowArray(body)
  if (!arr) return null
  const rows: MimoDetailRow[] = []
  for (const raw of arr) {
    const r = parseDetailRow(raw, false)
    if (r) rows.push(r)
  }
  return rows
}

/** 合并按量与套餐两通道明细：同 (日期, 模型) 相加；成本只由按量行贡献（纯套餐行 costNative 缺省） */
function mergeDetailRows(amountRows: MimoDetailRow[], planRows: MimoDetailRow[]): MimoDetailRow[] {
  const byKey = new Map<string, MimoDetailRow>()
  const merge = (r: MimoDetailRow): void => {
    const key = `${r.dateKey}|${r.model}`
    const cur = byKey.get(key)
    if (!cur) {
      byKey.set(key, { ...r })
      return
    }
    cur.requests += r.requests
    cur.tokensIn += r.tokensIn
    cur.tokensOut += r.tokensOut
    cur.tokensTotal += r.tokensTotal
    if (r.costNative !== undefined) cur.costNative = (cur.costNative ?? 0) + r.costNative
  }
  for (const r of amountRows) merge(r)
  for (const r of planRows) merge(r)
  return [...byKey.values()]
}

/** 币种归一：CNY → USD（展示层再按 settings.currency 换算回去，链路与全应用一致） */
function toUsd(native: number, currency: string): number {
  return currency === 'USD' ? native : native / CNY_TO_USD
}

/** 明细行聚合 → 模型明细行（成本归一 USD 且仅含按量金额；按成本降序、tokensTotal 次之） */
function aggregateDetailRows(
  rows: MimoDetailRow[],
  currency: string
): NonNullable<MimoUsage['monthlyModels']> {
  const byModel = new Map<
    string,
    { requests: number; costNative: number; hasCost: boolean; tokensIn: number; tokensOut: number; tokensTotal: number }
  >()
  let minTs: number | undefined
  let maxTs: number | undefined
  for (const r of rows) {
    const key = r.model || '其他'
    const cur = byModel.get(key) ?? { requests: 0, costNative: 0, hasCost: false, tokensIn: 0, tokensOut: 0, tokensTotal: 0 }
    cur.requests += r.requests
    if (r.costNative !== undefined) {
      cur.costNative += r.costNative
      cur.hasCost = true
    }
    cur.tokensIn += r.tokensIn
    cur.tokensOut += r.tokensOut
    cur.tokensTotal += r.tokensTotal
    byModel.set(key, cur)
    if (r.dateTs !== undefined) {
      minTs = minTs === undefined ? r.dateTs : Math.min(minTs, r.dateTs)
      maxTs = maxTs === undefined ? r.dateTs : Math.max(maxTs, r.dateTs)
    }
  }
  const modelRows = [...byModel.entries()]
    .map(([model, v]) => ({
      model,
      requests: v.requests,
      ...(v.hasCost ? { cost: toUsd(v.costNative, currency) } : {}),
      tokensIn: v.tokensIn,
      tokensOut: v.tokensOut,
      tokensTotal: v.tokensTotal
    }))
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.tokensTotal - a.tokensTotal)
  return {
    rows: modelRows,
    ...(minTs !== undefined && maxTs !== undefined ? { window: { fromTs: minTs, toTs: maxTs } } : {})
  }
}

/** 明细行 → 汇总（成本 = 按量计费金额；MiMo 两接口均无成功率数据，不产出该字段） */
function aggregateSummary(rows: MimoDetailRow[], currency: string): NonNullable<MimoUsage['summary']> {
  let totalCount = 0
  let costNative = 0
  let totalTokens = 0
  let hasCost = false
  for (const r of rows) {
    totalCount += r.requests
    totalTokens += r.tokensTotal
    if (r.costNative !== undefined) {
      costNative += r.costNative
      hasCost = true
    }
  }
  return {
    totalCount,
    ...(hasCost ? { totalCost: toUsd(costNative, currency) } : {}),
    totalTokens,
    periodBasis: 'current-month'
  }
}

export async function refreshMimoUsage(accountId: string): Promise<MimoRefreshResult> {
  const cookie = getUsageCredential(credKey(accountId))
  if (!cookie) return { ok: false, code: 'not_authenticated' }

  const now = new Date()
  const listPayload = { year: now.getFullYear(), month: now.getMonth() + 1 }

  const [balRes, planRes, detailRes, listRes, tpListRes] = await Promise.all([
    mimoGet('/balance', cookie),
    mimoGet('/tokenPlan/usage', cookie),
    // 订阅套餐权威来源；/tokenPlan/subscription/status 实测为空壳端点（{code:0}无 data），已弃用
    mimoGet('/tokenPlan/detail', cookie),
    mimoPost('/usage/detail/list', listPayload, cookie),
    // 套餐通道明细（官方控制台 /console/usage 的「套餐用量」页）：行无金额，与按量明细合并后统一聚合
    mimoPost('/usage/token-plan/list', listPayload, cookie)
  ])
  if (DEBUG) {
    console.log(
      `[Monitor] mimo refresh(${accountId}): balance=${balRes.status} tokenPlan=${planRes.status} detail=${detailRes.status} usageList=${listRes.status} tokenPlanList=${tpListRes.status}`
    )
  }

  const statuses = [balRes.status, planRes.status, detailRes.status, listRes.status, tpListRes.status]
  // 401/403 → 会话失效（cookie 过期，约 24h）
  if (statuses.some((s) => s === 401 || s === 403)) {
    return { ok: false, code: 'session_expired' }
  }
  // 全端点网络类失败（status 0）→ 显式网络错误，UI 显示错误条而非空数据
  if (statuses.every((s) => s === 0)) {
    return { ok: false, code: 'network', error: '所有端点请求失败（网络不通）' }
  }

  const data: MimoUsage = {
    fetchedAt: Date.now(),
    sourcesAvailable: { balance: false, tokenPlan: false, subscription: false, windows: false, summary: false, detailList: false }
  }

  // ① 账户余额
  if (balRes.status === 200) {
    const balance = parseBalance(balRes.body)
    if (balance) {
      data.balance = balance
      data.sourcesAvailable.balance = true
    }
  }

  // ② Token Plan 套餐用量
  if (planRes.status === 200) {
    const tokenPlan = parseTokenPlan(planRes.body)
    if (tokenPlan) {
      data.tokenPlan = tokenPlan
      data.sourcesAvailable.tokenPlan = true
    }
  }

  // ③ 订阅套餐（planCode / currentPeriodEnd / expired / enableAutoRenew）
  if (detailRes.status === 200) {
    const parsed = parseSubscription(detailRes.body)
    if (parsed.recognized) {
      data.sourcesAvailable.subscription = true
      if (parsed.subscription && Object.keys(parsed.subscription).length > 0) {
        data.subscription = parsed.subscription
      }
    }
  }

  // ④ 当月明细：按量（含金额）与套餐（无金额）两通道按「日期 × 模型」合并 → 汇总 + 模型明细 + 本地累计落库
  let persisted = 0
  const amount = listRes.status === 200 ? parseUsageDetailList(listRes.body, data.balance) : null
  const planRows = tpListRes.status === 200 ? parseTokenPlanList(tpListRes.body) : null
  if (amount || planRows) {
    data.sourcesAvailable.detailList = true
    data.sourcesAvailable.summary = true
    const merged = mergeDetailRows(amount?.rows ?? [], planRows ?? [])
    // 币种：按量响应内 currency 优先（套餐通道无币种字段）；纯套餐账号兜底余额币种
    const currency = amount?.currency ?? (data.balance?.currency === 'USD' ? 'USD' : 'CNY')
    data.monthlyModels = aggregateDetailRows(merged, currency)
    // 汇总与明细同源同区间（当前自然月）：口径一致，合计应相等
    data.summary = aggregateSummary(merged, currency)

    if (merged.length > 0) {
      try {
        const records: AccumulatedRecordInput[] = merged.map((r) => ({
          id: `${r.dateKey}|${r.model || '__other__'}`,
          ...(r.dateTs !== undefined ? { createdAtMs: r.dateTs } : {}),
          model: r.model || '其他',
          tokensIn: r.tokensIn,
          tokensOut: r.tokensOut,
          tokensTotal: r.tokensTotal,
          cost: toUsd(r.costNative ?? 0, currency),
          requests: r.requests
        }))
        persisted = persistUsageRecords(accountId, records)
      } catch (err) {
        console.warn('[Monitor] MiMo 用量记录落库失败:', err)
      }
    }
  }

  // ⑤ 月度额度窗口：Token Plan 周期已用%（resetAt = 订阅有效期截止，即续费/重置时刻）
  if (data.tokenPlan) {
    data.windows = {
      monthly: {
        usedPercent: Math.min(100, Math.max(0, data.tokenPlan.percent)),
        ...(data.subscription?.expireAtTs !== undefined ? { resetAt: data.subscription.expireAtTs } : {})
      }
    }
    data.sourcesAvailable.windows = true
  }

  return { ok: true, data, persisted }
}