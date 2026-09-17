// ─── Command Code 云端用量监控客户端 ───
// 职责：
//   1. 应用内登录窗：加载 Studio 页面，轮询捕获 session cookie 并安全存储
//   2. 用量拉取：调 Command Code 内部 API（/internal/* 用 Cookie；/alpha/billing/credits 用 Provider API Key）
//   3. 归一化为 CommandCodeUsage，区块级优雅降级
// 网络请求统一走 fetchProxy（尊重用户的网络代理设置）。

import { BrowserWindow, session } from 'electron'
import { fetchProxy } from '../local/fetchProxy'
import { persistUsageRecords } from './usageAccumulator'
import {
  saveUsageCredential,
  getUsageCredential,
  removeUsageCredential
} from '../store/key-store'
import type {
  CommandCodeUsage,
  CommandCodeSubscription,
  MonitorStatus,
  RemoteUsageSource,
  UsageWindowInfo
} from '../../shared/types'

const API_BASE = 'https://api.commandcode.ai'
/** Studio 登录态 cookie 名（.commandcode.ai 域） */
const SESSION_TOKEN_NAME = '__Secure-commandcode_prod_.session_token'
/** 登录窗使用的独立 session partition（隔离登录态，不污染主窗口会话） */
const LOGIN_PARTITION = 'persist:commandcode'

let loginWin: BrowserWindow | null = null

// ─── 凭证 key 约定 ───
export function usageTokenKey(sourceId: string): string {
  return sourceId
}
export function usageApiKeyKey(sourceId: string): string {
  return `${sourceId}.apiKey`
}

// ─── 登录窗 ───

/** 捕获登录 cookie（轮询与关窗兜底共用）。命中则保存 token 并返回 true */
async function tryCaptureToken(ses: Electron.Session, sourceId: string): Promise<boolean> {
  try {
    const cookies = await ses.cookies.get({ name: SESSION_TOKEN_NAME })
    const hit = cookies.find((c) => (c.domain ?? '').includes('commandcode.ai') && c.value)
    if (hit?.value) {
      saveUsageCredential(usageTokenKey(sourceId), hit.value)
      return true
    }
  } catch {
    // cookie 查询瞬时失败 → 视为未命中
  }
  return false
}

/**
 * 打开登录窗加载 Studio 页面；用户在窗内登录后捕获 session cookie 并保存。
 * 轮询每 1.5s 检查 cookie；命中即保存、关窗、resolve success。
 * 轮询差一拍时观众秒关窗：close 时兜底再查一次分区 cookie，仍命中则视为成功。
 * 窗口被用户直接关闭且无 cookie → resolve { cancelled: true }（静默）。
 */
export function loginToCommandCode(
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

    // 分区已持久化过登录态（此前登录成功）→ 直接复用，无需再开登录窗
    if (await tryCaptureToken(ses, source.id)) {
      captured = true
      finish({ success: true })
      return
    }
    loginWin = new BrowserWindow({
      width: 960,
      height: 720,
      parent: parent ?? undefined,
      modal: !!parent,
      autoHideMenuBar: true,
      title: '登录 Command Code',
      webPreferences: {
        // 关键：必须复用同一 partition，登录 cookie 才会落在轮询的那个 session 里
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    // 轮询查找登录态 cookie
    const pollTimer = setInterval(async () => {
      if (captured) return
      if (await tryCaptureToken(ses, source.id)) {
        captured = true
        clearInterval(pollTimer)
        finish({ success: true })
        loginWin?.close()
      }
    }, 1500)

    loginWin.on('closed', () => {
      clearInterval(pollTimer)
      loginWin = null
      if (!captured) {
        // 宽限期：cookie 可能刚写入/正在落盘，关窗后 4s 内每隔 500ms 再查分区
        let attempts = 0
        const graceTimer = setInterval(async () => {
          if (captured || settled) {
            clearInterval(graceTimer)
            return
          }
          attempts++
          if (await tryCaptureToken(ses, source.id)) {
            captured = true
            clearInterval(graceTimer)
            finish({ success: true })
            return
          }
          if (attempts >= 8) {
            clearInterval(graceTimer)
            finish({ success: false, cancelled: true })
            // 诊断：仍未捕获时打印分区内 cookie 名
            ses.cookies
              .get({})
              .then((all) => {
                const names = all.map((c) => `${c.name}@${c.domain}`).join(', ')
                console.warn(`[Monitor] login window closed and session cookie still not captured after grace period. current partitions: ${names || '(none)'}`)
              })
              .catch(() => {})
          }
        }, 500)
        return
      }
      finish({ success: false, cancelled: true })
    })

    loginWin.webContents.on('did-fail-load', () => {
      // 加载失败时不立即终止，用户可手动刷新；避免网络抖动直接误杀登录窗
    })

    loginWin.loadURL(source.studioUrl || 'https://commandcode.ai/studio').catch(() => {
      // loadURL 抛错（如无效 URL）→ 结束登录流程
      finish({ success: false, error: '无法打开登录页面' })
    })
  })
}

/** 清除某监控源的登录态与 API Key */
export function logoutCommandCode(sourceId: string): void {
  removeUsageCredential(usageTokenKey(sourceId))
  removeUsageCredential(usageApiKeyKey(sourceId))
}

/** 查询某监控源的认证状态 */
export function getMonitorStatus(sourceId: string): MonitorStatus {
  return {
    loggedIn: !!getUsageCredential(usageTokenKey(sourceId)),
    hasApiKey: !!getUsageCredential(usageApiKeyKey(sourceId))
  }
}

// ─── API 客户端 ───

interface CcResponse {
  status: number
  body: unknown
}

async function ccGet(path: string, opts: { token?: string; apiKey?: string }): Promise<CcResponse> {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'moa-desktop' }
  if (opts.token) headers['Cookie'] = `${SESSION_TOKEN_NAME}=${opts.token}`
  if (opts.apiKey) headers['Authorization'] = `Bearer ${opts.apiKey}`

  // 超时与重试统一由 fetchProxy 处理（配置见「云端用量监控」页的 API 请求设置）
  const resp = await fetchProxy(`${API_BASE}${path}`, { headers })
  const body = await resp.json().catch(() => null)
  return { status: resp.status, body }
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

/** 兼容 `{ success: true, data: {...} }` 的响应包裹：有该结构时返回内层 data，否则原样返回 */
function unwrapSuccess(body: unknown): unknown {
  if (isObj(body) && body.success === true && body.data !== undefined) {
    return body.data
  }
  return body
}

function parseWindow(w: unknown): UsageWindowInfo | undefined {
  if (!isObj(w)) return undefined
  // 形态A: { used, cap }（$值+额度上限，如 windowLimits.fiveHour）
  const used = toNum(w.used)
  const cap = toNum(w.cap)
  const usedPercent =
    used !== undefined && cap !== undefined && cap > 0
      ? (used / cap) * 100
      : toNum(w.used_percent ?? w.usedPercent ?? w.percent)
  // 形态B: 直接百分比 + reset 时间（reset_at 可能为 epoch 秒或毫秒，统一归一为秒）
  const resetAt = toNum(w.reset_at ?? w.resets_at ?? w.resetAt ?? w.resetsAt)
  const info: UsageWindowInfo = {}
  if (usedPercent !== undefined) info.usedPercent = Math.min(100, Math.max(0, usedPercent))
  if (resetAt !== undefined) {
    info.resetAt = resetAt > 1e12 ? Math.round(resetAt / 1000) : resetAt
  }
  return Object.keys(info).length > 0 ? info : undefined
}

interface WindowsParse {
  fiveHour?: UsageWindowInfo
  weekly?: UsageWindowInfo
  monthlyCredits?: number
}

/** 解析 5h/7d 窗口响应。
 * 真实结构（已实测）：
 *   { credits: { monthlyCredits, purchasedCredits, ... },
 *     windowLimits: { fiveHour: { used, cap, exceeded, resetAt(ms) }, weekly: {...} } }
 * 另兼容历史/第三方形态：
 *   { rate_limit: { primary_window, secondary_window } }
 *   { usage: { five_hour, weekly } } 等
 */
function parseWindows(body: unknown): WindowsParse | null {
  const root = unwrapSuccess(body)
  if (!isObj(root)) return null

  const rateLimit = isObj(root.rate_limit) ? root.rate_limit : null
  const usage = isObj(root.usage) ? root.usage : null
  const creditsObj = isObj(root.credits) ? root.credits : null
  const windowLimits = isObj(root.windowLimits) ? root.windowLimits : null

  const fiveHour =
    parseWindow(windowLimits?.fiveHour) ??
    parseWindow(windowLimits?.['5h'] ?? windowLimits?.five_hour) ??
    parseWindow(rateLimit?.primary_window) ??
    parseWindow(usage?.five_hour ?? usage?.fiveHour) ??
    parseWindow(root.five_hour ?? root.fiveHour) ??
    parseWindow(root.primary_window ?? root.primary)
  const weekly =
    parseWindow(windowLimits?.weekly ?? windowLimits?.seven_day ?? windowLimits?.sevenDay) ??
    parseWindow(rateLimit?.secondary_window) ??
    parseWindow(usage?.weekly) ??
    parseWindow(root.weekly) ??
    parseWindow(root.secondary_window ?? root.secondary)

  const monthlyCredits = toNum(creditsObj?.monthlyCredits ?? creditsObj?.monthly_credits ?? root.monthlyCredits ?? root.monthly_credits)

  const hasWindow = fiveHour || weekly
  const hasCredits = monthlyCredits !== undefined
  return hasWindow || hasCredits ? { ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}), ...(monthlyCredits !== undefined ? { monthlyCredits } : {}) } : null
}

/** mode → 展示名（与 Studio 前端常量一致；不在表内的 mode 缺失模型名时原样兜底） */
const CC_MODE_LABELS: Record<string, string> = {
  learning: 'taste-1',
  'web-search': 'web-search',
  'web-fetch': 'web-fetch'
}

/** 解析出的单条用量记录（含用于本地累计去重的 id） */
interface ParsedUsageRecord {
  /** 记录唯一标识：优先服务端 id，缺失时用「时间|模型|tokens|成本」合成（保证去重可用） */
  id: string
  /** 记录自身时间（epoch 毫秒；无法解析时省略） */
  createdAtMs?: number
  model: string
  tokensIn: number
  tokensOut: number
  tokensTotal: number
  cost: number
}

/** 解析 /internal/usage 的单条用量记录（一条记录 = 一次请求；兼容 camelCase / snake_case 与 meta 嵌套） */
function parseUsageRecord(raw: unknown): ParsedUsageRecord | undefined {
  if (!isObj(raw)) return undefined
  const meta = isObj(raw.meta) ? raw.meta : null
  const tokensIn = toNum(raw.tokensIn ?? raw.tokens_in) ?? 0
  const tokensOut = toNum(raw.tokensOut ?? raw.tokens_out) ?? 0
  const tokensTotal = toNum(raw.tokensTotal ?? raw.tokens_total) ?? tokensIn + tokensOut
  // 成本口径与 Studio 一致（美元）：meta.totalCost 优先；缺失时用 inputCost+outputCost+cacheCost 求和；
  // 再兜底旧字段（creditsTotal / planPoolDraw / cost，单位可能不同，仅作最后手段）
  const metaCost = toNum(meta?.totalCost ?? meta?.total_cost)
  const inputCost = toNum(meta?.inputCost ?? meta?.input_cost)
  const outputCost = toNum(meta?.outputCost ?? meta?.output_cost)
  const cacheCost = toNum(meta?.cacheCost ?? meta?.cache_cost)
  const partsCost =
    inputCost === undefined && outputCost === undefined && cacheCost === undefined
      ? undefined
      : (inputCost ?? 0) + (outputCost ?? 0) + (cacheCost ?? 0)
  const cost =
    metaCost ??
    partsCost ??
    toNum(raw.creditsTotal ?? raw.credits_total) ??
    toNum(meta?.planPoolDraw ?? meta?.plan_pool_draw) ??
    toNum(raw.cost) ??
    0
  // 模型名：meta.model / meta.modelName 优先（顶层 model 兜底），都缺失时按 Studio 口径回退 mode 展示名。
  // 关键：mode 回退让 learning / web-search / web-fetch 这类无 meta.model 的记录不再被整条丢弃。
  const mode = str(raw.mode)
  const model =
    (typeof raw.model === 'string' && raw.model) ||
    (typeof meta?.model === 'string' && meta.model) ||
    (typeof meta?.modelName === 'string' && meta.modelName) ||
    (mode ? (CC_MODE_LABELS[mode] ?? mode) : '') ||
    ''
  if (!model) return undefined
  const createdAtSec = toEpochSec(raw.createdAt ?? raw.created_at)
  const createdAtMs = createdAtSec === undefined ? undefined : createdAtSec * 1000
  const idRaw = str(raw.id ?? raw.recordId ?? raw.record_id)
  return {
    // 服务端记录稳定带 id；缺失时用可稳定复现的组合键，保证「按 id 去重」仍然成立
    id: idRaw ?? `${createdAtMs ?? 0}|${model}|${tokensTotal}|${cost}`,
    ...(createdAtMs !== undefined ? { createdAtMs } : {}),
    model,
    tokensIn,
    tokensOut,
    tokensTotal,
    cost
  }
}

/** 把原始记录数组归一化为可落库的记录（供本地累计使用） */
export function normalizeUsageRecords(records: unknown[]): ParsedUsageRecord[] {
  const out: ParsedUsageRecord[] = []
  for (const raw of records) {
    const rec = parseUsageRecord(raw)
    if (rec) out.push(rec)
  }
  return out
}

/**
 * 从用量列表响应中提取记录数组。
 * 记录列表可能在根部、.usages / .items / .data，或嵌套在 .data.data / .data.usages。
 */
function extractUsageArray(unwrapped: unknown): unknown[] | null {
  if (Array.isArray(unwrapped)) return unwrapped
  if (!isObj(unwrapped)) return null
  if (Array.isArray(unwrapped.usages)) return unwrapped.usages
  if (Array.isArray(unwrapped.items)) return unwrapped.items
  if (Array.isArray(unwrapped.data)) return unwrapped.data
  if (isObj(unwrapped.data) && Array.isArray(unwrapped.data.data)) return unwrapped.data.data
  if (isObj(unwrapped.data) && Array.isArray(unwrapped.data.usages)) return unwrapped.data.usages
  return null
}

interface UsagePage {
  usages: unknown[]
  /** 下一页游标（缺失 = 已到最后一页） */
  nextCursor?: string
  /** 服务端记录保留窗口天数（响应 window.days） */
  windowDays?: number
}

/** 解析 /internal/usage 的单页响应：{ usages, window: { days }, nextCursor }（结构不可识别返回 null） */
function parseUsagePage(body: unknown): UsagePage | null {
  const root = unwrapSuccess(body)
  const usages = extractUsageArray(root)
  if (!usages) return null
  const page: UsagePage = { usages }
  if (isObj(root)) {
    const nextCursor = str(root.nextCursor ?? root.next_cursor)
    if (nextCursor) page.nextCursor = nextCursor
    const win = isObj(root.window) ? root.window : null
    const days = toNum(win?.days ?? win?.windowDays)
    if (days !== undefined) page.windowDays = days
  }
  return page
}

/** 单页记录数（Studio 分页 UI 白名单为 10/25/50/100，取最大值以减少请求数） */
const USAGE_PAGE_SIZE = 100
/**
 * 试探用页大小：当「恰好拿满一页且服务端不给游标」时，用更大的 limit 再试一次。
 * Studio UI 只提供到 100，但服务端本身可能接受更大 limit —— 探测成功即可覆盖更长的记录跨度。
 */
const USAGE_PROBE_PAGE_SIZE = 500
/**
 * 探针冷却（毫秒）：一旦确认服务端不接受更大 limit（如 GOAT 账号恒定 400），
 * 短期内不再重复试探 —— 否则每次刷新都要白打一个注定失败的请求。
 */
const USAGE_PROBE_COOLDOWN_MS = 6 * 60 * 60 * 1000
/** 探针冷却截止时间（进程内状态；到期后自动再试一次，若服务端放宽即可自动受益） */
let probeDisabledUntil = 0
/** 单次刷新最多拉取页数（20 页 × 100 条 = 2000 条记录），避免账号历史过大时刷新过慢 */
const USAGE_MAX_PAGES = 20
/** 分页总耗时预算（ms）：超预算即停止继续翻页，已取记录照常聚合 */
const USAGE_PAGE_BUDGET_MS = 12_000
/** 诊断开关（MOA_MONITOR_DEBUG=1）：逐页打印响应结构，排查服务端分页/字段变化时使用 */
const DEBUG_USAGE_PAGES = process.env.MOA_MONITOR_DEBUG === '1'

interface UsageFetch {
  /** 首页 HTTP 状态（null = 网络异常 / 请求抛错） */
  status: number | null
  records: unknown[]
  pages: number
  /** true = 仍有更早的记录未纳入（页数/耗时上限，或后续页失败/结构异常） */
  truncated: boolean
  windowDays?: number
  /** 本次实际请求的页大小（诊断用：确认试探是否生效） */
  requestedLimit: number
}

/**
 * 游标分页拉取用量记录（服务端契约见 Studio 前端：`?limit=&cursor=`，响应 nextCursor 为 null 表示末页）。
 * 首页失败 → status 返回给调用方处理；后续页失败 → 保留已取记录并标记 truncated（不丢数据、不误报完整）。
 */
async function fetchUsagePages(token: string, pageSize: number): Promise<UsageFetch> {
  const startedAt = Date.now()
  const records: unknown[] = []
  let pages = 0
  let status: number | null = null
  let cursor: string | undefined
  let windowDays: number | undefined
  let truncated = false

  const fail = (s: number | null): UsageFetch => ({ status: s, records: [], pages: 0, truncated: false, requestedLimit: pageSize })

  while (pages < USAGE_MAX_PAGES) {
    const qs = new URLSearchParams({ limit: String(pageSize) })
    if (cursor) qs.set('cursor', cursor)

    let res: CcResponse
    try {
      res = await ccGet(`/internal/usage?${qs.toString()}`, { token })
    } catch {
      if (pages === 0) return fail(null)
      truncated = true
      break
    }

    if (pages === 0) status = res.status
    const page = res.status === 200 ? parseUsagePage(res.body) : null
    if (res.status !== 200 || !page) {
      if (pages === 0) return fail(res.status)
      truncated = true
      break
    }

    pages += 1
    if (DEBUG_USAGE_PAGES) {
      const root = unwrapSuccess(res.body)
      console.log(
        `[Monitor] usage page ${pages} (limit=${pageSize}): usages=${page.usages.length} nextCursor=${page.nextCursor ? 'present' : 'absent'} window=${page.windowDays ?? '?'} rootKeys=${isObj(root) ? Object.keys(root).join(',') : typeof root}`
      )
    }
    records.push(...page.usages)
    if (page.windowDays !== undefined) windowDays = page.windowDays

    if (!page.nextCursor) {
      cursor = undefined
      break
    }
    cursor = page.nextCursor
    if (Date.now() - startedAt > USAGE_PAGE_BUDGET_MS) {
      truncated = true
      break
    }
  }

  // 页数上限到达且末页仍有游标 → 更早的记录未纳入
  if (cursor && pages >= USAGE_MAX_PAGES) truncated = true

  return {
    status,
    records,
    pages,
    truncated,
    requestedLimit: pageSize,
    ...(windowDays !== undefined ? { windowDays } : {})
  }
}

/**
 * 取用量记录（含自适应页大小试探）。
 * 触发条件：恰好一页、拿满 pageSize 条、且服务端不给游标 —— 说明「100 条可能是服务端上限」，
 * 此时用 USAGE_PROBE_PAGE_SIZE 再请求一次：服务端若接受更大 limit，就能拿到更长跨度的记录。
 * 试探只在结果更多时采用；400 / 网络异常一律静默回退（不改变原有行为）。
 */
async function fetchUsageRecords(token: string): Promise<UsageFetch> {
  const base = await fetchUsagePages(token, USAGE_PAGE_SIZE)
  if (base.status !== 200 || base.pages !== 1 || base.records.length < USAGE_PAGE_SIZE || base.truncated) return base
  // 冷却期内跳过试探（探针被拒/无收益时设置）
  if (Date.now() < probeDisabledUntil) return base

  const probe = await fetchUsagePages(token, USAGE_PROBE_PAGE_SIZE)
  if (probe.status === 401 || probe.status === 403) return probe
  if (probe.status !== 200) {
    probeDisabledUntil = Date.now() + USAGE_PROBE_COOLDOWN_MS
    if (DEBUG_USAGE_PAGES) {
      console.log(
        `[Monitor] usage probe limit=${USAGE_PROBE_PAGE_SIZE} → status=${probe.status}，沿用 ${base.records.length} 条（冷却 ${USAGE_PROBE_COOLDOWN_MS / 3600_000} 小时）`
      )
    }
    return base
  }
  if (probe.records.length <= base.records.length) {
    probeDisabledUntil = Date.now() + USAGE_PROBE_COOLDOWN_MS
    if (DEBUG_USAGE_PAGES) {
      console.log(`[Monitor] usage probe limit=${USAGE_PROBE_PAGE_SIZE} → ${probe.records.length} 条（无收益，冷却）`)
    }
    return base
  }
  if (DEBUG_USAGE_PAGES) {
    console.log(`[Monitor] usage probe limit=${USAGE_PROBE_PAGE_SIZE} → ${probe.records.length} 条（base ${base.records.length} 条）`)
  }
  return probe
}

/** 诊断开关（MOA_MONITOR_PROBE=1）：探测 /internal/usage/charts 的真实结构
 *  （该端点在 Studio 常量表中存在、客户端 0 调用点，但无认证探针返回 401 = 服务端存在；
 *   若它返回按模型/时间桶的聚合，就能补上「整月按模型明细」，替代只有最近 100 条的窗口明细） */
const PROBE_CHARTS = process.env.MOA_MONITOR_PROBE === '1'

async function probeCharts(sourceId: string, token: string): Promise<void> {
  const describe = (v: unknown, depth = 0): string => {
    if (Array.isArray(v)) return `[${v.length}]${v.length > 0 ? describe(v[0], depth + 1) : ''}`
    if (isObj(v)) {
      const keys = Object.keys(v)
      const shown = keys.slice(0, depth === 0 ? 6 : 14)
      const inner = depth < 2 && v[shown[0]] !== undefined ? ` → ${shown[0]}=${describe(v[shown[0]], depth + 1)}` : ''
      return `{${shown.join(',')}${keys.length > shown.length ? ',…' : ''}}${inner}`
    }
    return typeof v
  }
  try {
    // 参照：summary（计费月口径），用于判断哪个参数组合能覆盖整月
    let ref = '参考 summary=—'
    try {
      const sumRes = await ccGet('/internal/usage/summary', { token })
      const sum = sumRes.status === 200 ? parseSummary(sumRes.body) : undefined
      if (sum) ref = `参考 summary: requests=${sum.totalCount} cost=${sum.totalCost.toFixed(4)} basis=${sum.periodBasis ?? '?'}`
    } catch {
      /* 参照失败不影响探测 */
    }

    const now = Date.now()
    const monthStartUtc = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString()
    const days30 = new Date(now - 30 * 86_400_000).toISOString()
    const variants: Array<{ label: string; qs: string }> = [
      { label: '无参', qs: '' },
      { label: 'periodBasis=billing-period', qs: '?periodBasis=billing-period' },
      { label: 'from=本月1日(UTC)', qs: `?from=${encodeURIComponent(monthStartUtc)}&periodBasis=billing-period` },
      { label: 'from=30天前&last-30-days', qs: `?from=${encodeURIComponent(days30)}&periodBasis=last-30-days` }
    ]

    for (const v of variants) {
      const res = await ccGet(`/internal/usage/charts${v.qs}`, { token })
      const parsed = res.status === 200 ? parseUsageCharts(res.body) : null
      const requests = parsed ? parsed.rows.reduce((a, r) => a + r.requests, 0) : 0
      const cost = parsed ? parsed.rows.reduce((a, r) => a + r.cost, 0) : 0
      const parts = [
        `[${v.label}]`,
        `status=${res.status}`,
        `rows=${parsed?.rows.length ?? 0}`,
        `buckets=${parsed?.buckets ?? 0}`,
        `requests=${requests}`,
        `cost=${cost.toFixed(4)}`,
        `window=${parsed?.window ? JSON.stringify(parsed.window).slice(0, 160) : '(none)'}`
      ]
      console.log(`[Monitor] probe charts ${parts.join(' ')}`)
      if (v.label === '无参' && parsed && parsed.rows.length > 0) {
        console.log(`[Monitor] probe charts 无参结构: ${describe((isObj(res.body) ? unwrapSuccess(res.body) : null) ?? res.body)}`)
      }
    }
    console.log(`[Monitor] probe charts ${ref}`)
  } catch (err) {
    console.log(`[Monitor] probe charts(${sourceId}) 失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ─── /internal/usage/charts：服务端「模型 × 时间桶」聚合（与 summary 同区间）───
// 实测（2026-09-17）：GET /internal/usage/charts → 200，根为索引对象（0..N-1，共 28 行），
// 每行 { model, provider, timeBucket, requests, totalCost, inputCost, outputCost, creditsTotal,
//        consumedMonthlyCredits, cacheCost, cacheSavings, tokensIn/Out/Total, cacheReadInputTokens, ... }
// 字段比单条记录更全（含缓存成本/节省、按月额度消耗拆分）；响应可带 window:{from,to,periodBasis}。
// 该端点在 Studio 客户端 0 调用点（服务端在用），因此按"可能变动"处理：解析失败即区块级降级。

/** charts 的单行（模型 × 时间桶） */
export interface UsageChartRow {
  model: string
  requests: number
  cost: number
  tokensIn: number
  tokensOut: number
  tokensTotal: number
  cacheCost: number
  cacheSavings: number
}

export interface UsageChartsParse {
  rows: UsageChartRow[]
  /** 不同 timeBucket 的个数 */
  buckets: number
  window?: { from?: string; to?: string; fromTs?: number; toTs?: number; periodBasis?: string }
}

/** 解析 charts 响应（根可能是数组、索引对象，或嵌套在 data 下；无法识别返回 null） */
export function parseUsageCharts(body: unknown): UsageChartsParse | null {
  const root = unwrapSuccess(body)
  let list: unknown[] | null = null
  if (Array.isArray(root)) {
    list = root
  } else if (isObj(root)) {
    if (Array.isArray(root.data)) list = root.data
    else {
      // 索引对象 { "0": {...}, "1": {...} }（实测形态）
      const idxKeys = Object.keys(root).filter((k) => /^\d+$/.test(k))
      if (idxKeys.length > 0) list = idxKeys.map((k) => root[k])
    }
  }
  if (!list) return null

  const rows: UsageChartRow[] = []
  const bucketSet = new Set<string>()
  for (const raw of list) {
    if (!isObj(raw)) continue
    const model = str(raw.model) ?? str(raw.modelLabel)
    if (!model) continue
    const bucket = str(raw.timeBucket ?? raw.time_bucket)
    if (bucket) bucketSet.add(bucket)
    rows.push({
      model,
      requests: toNum(raw.requests) ?? 0,
      cost: toNum(raw.totalCost ?? raw.cost) ?? 0,
      tokensIn: toNum(raw.tokensIn ?? raw.tokens_in) ?? 0,
      tokensOut: toNum(raw.tokensOut ?? raw.tokens_out) ?? 0,
      tokensTotal: toNum(raw.tokensTotal ?? raw.tokens_total) ?? 0,
      cacheCost: toNum(raw.cacheCost ?? raw.cache_cost) ?? 0,
      cacheSavings: toNum(raw.cacheSavings ?? raw.cache_savings) ?? 0
    })
  }
  if (rows.length === 0) return null

  let window: UsageChartsParse['window']
  // window 与 data 同级（契约 {success, data, error, window}），展开后在 body 上；兼容直接挂在根上的形态
  const w = isObj(root) && isObj(root.window) ? root.window : isObj(body) && isObj(body.window) ? body.window : null
  if (w) {
    const from = str(w.from)
    const to = str(w.to)
    const periodBasis = str(w.periodBasis ?? w.period_basis)
    const fromTs = toEpochSec(from)
    const toTs = toEpochSec(to)
    const parsed: NonNullable<UsageChartsParse['window']> = {}
    if (from) parsed.from = from
    if (to) parsed.to = to
    if (periodBasis) parsed.periodBasis = periodBasis
    if (fromTs !== undefined) parsed.fromTs = fromTs
    if (toTs !== undefined) parsed.toTs = toTs
    if (Object.keys(parsed).length > 0) window = parsed
  }

  return { rows, buckets: bucketSet.size, ...(window ? { window } : {}) }
}

/** 把「模型 × 时间桶」行按模型汇总为展示行（服务端已聚合，这里只做跨桶相加；按成本降序） */
export function aggregateChartRows(rows: UsageChartRow[]): Array<{
  model: string
  requests: number
  cost: number
  tokensIn: number
  tokensOut: number
  tokensTotal: number
  cacheCost: number
  cacheSavings: number
}> {
  const map = new Map<string, { model: string; requests: number; cost: number; tokensIn: number; tokensOut: number; tokensTotal: number; cacheCost: number; cacheSavings: number }>()
  for (const r of rows) {
    const agg = map.get(r.model) ?? {
      model: r.model,
      requests: 0,
      cost: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokensTotal: 0,
      cacheCost: 0,
      cacheSavings: 0
    }
    agg.requests += r.requests
    agg.cost += r.cost
    agg.tokensIn += r.tokensIn
    agg.tokensOut += r.tokensOut
    agg.tokensTotal += r.tokensTotal
    agg.cacheCost += r.cacheCost
    agg.cacheSavings += r.cacheSavings
    map.set(r.model, agg)
  }
  return Array.from(map.values()).sort((a, b) => b.cost - a.cost || b.tokensTotal - a.tokensTotal)
}

/** 记录集合的时间范围（epoch 毫秒）：用于说明明细覆盖的时间跨度，而非只给条数 */
function recordTimeRange(records: unknown[]): { fromTs?: number; toTs?: number } {
  let from: number | undefined
  let to: number | undefined
  for (const raw of records) {
    if (!isObj(raw)) continue
    const sec = toEpochSec(raw.createdAt ?? raw.created_at)
    if (sec === undefined) continue
    const ms = sec * 1000
    if (from === undefined || ms < from) from = ms
    if (to === undefined || ms > to) to = ms
  }
  return {
    ...(from !== undefined ? { fromTs: from } : {}),
    ...(to !== undefined ? { toTs: to } : {})
  }
}

export interface TotalFailureInput {
  /** 是否至少有一个区块拿到了数据（sourcesAvailable 任一为 true） */
  anySection: boolean
  /** 明细首页 HTTP 状态（null = 网络异常） */
  usageStatus: number | null
  /** 必发端点的 HTTP 状态（null = 网络异常） */
  requiredStatuses: Array<number | null>
  /** 必发端点是否存在请求被 reject（网络/超时抛错） */
  requiredRejected: boolean
  /** 全部已发端点的 HTTP 状态 */
  statuses: Array<number | null>
}

/**
 * 判定「全端点失败」：所有区块都没数据时，区分"网络不通"与"服务端异常"。
 * 返回 null = 不算失败（有区块成功，或确实是无数据的正常空态）。
 *
 * 为什么需要：区块级降级（sourcesAvailable）会把网络全挂表现成"成功但各区块为空"，
 * 页面因此显示空数据而不是错误条，用户看不出是网络问题还是真没用量。
 */
export function classifyTotalFailure(input: TotalFailureInput): { code: 'network' | 'unknown'; error: string } | null {
  if (input.anySection) return null

  const requiredRejectedOrNull = input.requiredRejected || input.requiredStatuses.some((s) => s === null)
  if (input.usageStatus === null || requiredRejectedOrNull) {
    return { code: 'network', error: '云端请求全部失败（网络不通或超时），未取得任何数据' }
  }

  const http = input.statuses.filter((s): s is number => s !== null)
  if (http.length > 0 && http.every((s) => s >= 400)) {
    return { code: 'unknown', error: '云端接口全部返回异常状态，未取得任何数据' }
  }
  return null
}

/** 按模型聚合请求记录（请求数 / tokens / 成本，按成本降序、tokens 次之） */
function aggregateRecords(records: unknown[]): NonNullable<CommandCodeUsage['models']> | undefined {
  if (records.length === 0) return undefined
  const map = new Map<string, { model: string; requests: number; cost: number; tokensIn: number; tokensOut: number; tokensTotal: number }>()
  for (const raw of records) {
    const rec = parseUsageRecord(raw)
    if (!rec) continue
    const agg = map.get(rec.model) ?? { model: rec.model, requests: 0, cost: 0, tokensIn: 0, tokensOut: 0, tokensTotal: 0 }
    agg.requests += 1
    agg.cost += rec.cost
    agg.tokensIn += rec.tokensIn
    agg.tokensOut += rec.tokensOut
    agg.tokensTotal += rec.tokensTotal
    map.set(rec.model, agg)
  }
  const rows = Array.from(map.values()).sort((a, b) => b.cost - a.cost || b.tokensTotal - a.tokensTotal)
  return rows.length > 0 ? rows : undefined
}

/** 解析 /internal/usage/summary（totalTokens 可能为字符串，防御性转换）
 *  口径：periodBasis 由服务端给出 —— 'billing-period' = 当前计费月、'last-30-days' = 最近 30 天
 *  （Studio 前端文案 `periodBasis === 'last-30-days' ? 'Last 30 days' : 'Current billing month'`）。
 *  注意：汇总与「模型明细」（最近 100 条记录聚合 / 本地累计）口径不同，数字不该相等。
 */
function parseSummary(body: unknown): CommandCodeUsage['summary'] {
  const unwrapped = unwrapSuccess(body)
  if (!isObj(unwrapped)) return undefined
  const totalCount = toNum(unwrapped.totalCount)
  const totalCost = toNum(unwrapped.totalCost)
  const totalTokens = toNum(unwrapped.totalTokens)
  const successRate = toNum(unwrapped.successRate)
  const periodBasis = str(unwrapped.periodBasis ?? unwrapped.period_basis)
  if (totalCount === undefined && totalCost === undefined) return undefined
  return {
    totalCount: totalCount ?? 0,
    totalCost: totalCost ?? 0,
    totalTokens: totalTokens ?? 0,
    successRate: successRate ?? 0,
    ...(periodBasis ? { periodBasis } : {})
  }
}

// ─── 订阅套餐解析 ───

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

/** 时间字段归一化为 epoch 秒：兼容 ISO 字符串 / epoch 秒 / epoch 毫秒（与 UsageWindowInfo.resetAt 同口径） */
function toEpochSec(v: unknown): number | undefined {
  let n: number | undefined
  if (typeof v === 'number' && Number.isFinite(v)) {
    n = v
  } else if (typeof v === 'string' && v.trim() !== '') {
    const num = Number(v)
    n = Number.isFinite(num) && num > 1e6 ? num : Date.parse(v)
  }
  if (n === undefined || !Number.isFinite(n)) return undefined
  return n > 1e12 ? Math.round(n / 1000) : Math.round(n)
}

interface SubscriptionParse {
  /** 明确无订阅（data 为 null / 空） */
  none: boolean
  subscription?: CommandCodeSubscription
}

/**
 * 解析订阅端点响应。真实结构（Studio 前端已确认，2026-09-17）：
 *   { success: true, data: { planId, status, currentPeriodEnd(ISO), cancelAt, pendingPhase } | null }
 * data 为 null → 无订阅；另兼容数组形态（多订阅取活跃优先）、{ data: { subscription } } 嵌套与 snake_case。
 * 返回 null 表示响应结构无法识别（区块标记为不可用，不展示「无订阅」）。
 */
function parseSubscription(body: unknown): SubscriptionParse | null {
  // body 为 null（响应非 JSON / 解析失败）→ 结构无法识别，区块标记为不可用
  if (body === null || body === undefined) return null
  if (isObj(body) && body.success === false) return null
  const root = unwrapSuccess(body)
  // { success:true, data:null } → 明确无订阅
  if (root === null || root === undefined) return { none: true }

  let obj: Record<string, unknown> | null = null
  if (Array.isArray(root)) {
    const items = root.filter(isObj)
    obj = items.find((o) => str(o.status) === 'active' || str(o.status) === 'trialing') ?? items[0] ?? null
    if (!obj) return { none: true }
  } else if (isObj(root)) {
    obj = isObj(root.subscription) ? root.subscription : root
  } else {
    return null
  }

  const sub: CommandCodeSubscription = {}
  const planId = str(obj.planId ?? obj.plan_id ?? obj.plan)
  if (planId) sub.planId = planId
  const status = str(obj.status)
  if (status) sub.status = status

  const periodEndRaw = obj.currentPeriodEnd ?? obj.current_period_end ?? obj.periodEnd ?? obj.period_end
  if (typeof periodEndRaw === 'string' && periodEndRaw.trim() !== '') sub.currentPeriodEnd = periodEndRaw
  const periodEndTs = toEpochSec(periodEndRaw)
  if (periodEndTs !== undefined) sub.currentPeriodEndTs = periodEndTs

  // 取消/续费状态字段（实测响应含 cancelAtPeriodEnd / cancelAt / canceledAt / endedAt 四件套）
  // 注意用显式 undefined 判断：API 可能同时返回 cancelAt: null 与缺失的 cancel_at，`??` 会把 null 短路掉
  const cancelRaw = obj.cancelAt !== undefined ? obj.cancelAt : obj.cancel_at
  const cancelAtTs = toEpochSec(cancelRaw)
  if (cancelAtTs !== undefined) sub.cancelAtTs = cancelAtTs

  const flagRaw = obj.cancelAtPeriodEnd !== undefined ? obj.cancelAtPeriodEnd : obj.cancel_at_period_end
  const periodEndFlag = typeof flagRaw === 'boolean' ? flagRaw : undefined
  if (periodEndFlag !== undefined) sub.cancelAtPeriodEnd = periodEndFlag

  const canceledTs = toEpochSec(obj.canceledAt ?? obj.canceled_at)
  if (canceledTs !== undefined) sub.canceledAtTs = canceledTs
  const endedTs = toEpochSec(obj.endedAt ?? obj.ended_at)
  if (endedTs !== undefined) sub.endedAtTs = endedTs

  // 推导 cancelScheduled：任一取消信号 → true；两处都明确为否 → false；信息不足 → 不设置（UI 不做推断）
  if (periodEndFlag === true || cancelAtTs !== undefined) sub.cancelScheduled = true
  else if (periodEndFlag === false || cancelRaw === null) sub.cancelScheduled = false

  const phaseRaw = isObj(obj.pendingPhase) ? obj.pendingPhase : isObj(obj.pending_phase) ? obj.pending_phase : null
  if (phaseRaw) {
    const phase: NonNullable<CommandCodeSubscription['pendingPhase']> = {}
    const effectiveTs = toEpochSec(phaseRaw.effectiveDate ?? phaseRaw.effective_date)
    if (effectiveTs !== undefined) phase.effectiveDateTs = effectiveTs
    const unitAmount = toNum(phaseRaw.unitAmount ?? phaseRaw.unit_amount)
    if (unitAmount !== undefined) phase.unitAmount = unitAmount
    const currency = str(phaseRaw.currency)
    if (currency) phase.currency = currency
    if (Object.keys(phase).length > 0) sub.pendingPhase = phase
  }

  if (Object.keys(sub).length === 0) return { none: true }
  return { none: false, subscription: sub }
}

// ─── 主入口：拉取并归一化 ───

export type RefreshResult =
  | { ok: true; data: CommandCodeUsage }
  | { ok: false; code: 'not_authenticated' | 'session_expired' | 'network' | 'unknown'; error?: string }

/**
 * 拉取某监控源的云端用量。
 * 并行请求 5 个端点 + 明细分页（游标翻页，见 fetchUsageRecords），任一 401/403 → session_expired；
 * 网络异常 → network；其余 → unknown。
 */
export async function refreshCommandCodeUsage(source: RemoteUsageSource): Promise<RefreshResult> {
  const token = getUsageCredential(usageTokenKey(source.id))
  if (!token) return { ok: false, code: 'not_authenticated' }
  const apiKey = getUsageCredential(usageApiKeyKey(source.id))

  // 明细分页：游标必须逐页串行，故提前启动、与其余端点并行推进
  const usageFetchPromise = fetchUsageRecords(token)
  // 诊断：探测 charts 端点结构（MOA_MONITOR_PROBE=1，默认关闭，不影响主流程）
  if (PROBE_CHARTS) void probeCharts(source.id, token)

  const hasApiKey = !!apiKey
  const requests: Array<Promise<CcResponse | null>> = [
    ccGet('/internal/usage/summary', { token }),
    ccGet('/internal/billing/credits', { token }),
    apiKey ? ccGet('/alpha/billing/credits', { apiKey }) : Promise.resolve(null),
    // 订阅套餐（含到期时间）；withPending=true 让响应带计划变更过渡信息
    ccGet('/internal/billing/subscriptions?withPending=true', { token }),
    apiKey ? ccGet('/alpha/billing/subscriptions', { apiKey }) : Promise.resolve(null),
    // 服务端「模型 × 时间桶」聚合（与 summary 同区间）：本月按模型明细的数据源
    ccGet('/internal/usage/charts', { token })
  ]

  let results: Array<PromiseSettledResult<CcResponse | null>>
  let usageFetch: UsageFetch
  try {
    ;[results, usageFetch] = await Promise.all([Promise.allSettled(requests), usageFetchPromise])
  } catch (err) {
    return { ok: false, code: 'network', error: err instanceof Error ? err.message : String(err) }
  }

  const get = (i: number): CcResponse | null => {
    const r = results[i]
    return r.status === 'fulfilled' ? r.value : null
  }
  const getStatus = (i: number): number | null => get(i)?.status ?? null

  console.log(
    `[Monitor] refresh(${source.id}): summary=${getStatus(0)} credits=${getStatus(1)} windows=${getStatus(2)} subscription=${getStatus(3)} subAlpha=${getStatus(4)} charts=${getStatus(5)} | usage=${usageFetch.status} limit=${usageFetch.requestedLimit} pages=${usageFetch.pages} records=${usageFetch.records.length}${usageFetch.truncated ? ' truncated' : ''}`
  )

  // 401/403 → 会话失效（含明细首页）
  if (usageFetch.status === 401 || usageFetch.status === 403) {
    return { ok: false, code: 'session_expired' }
  }
  if (results.some((r) => r.status === 'fulfilled' && r.value && (r.value.status === 401 || r.value.status === 403))) {
    return { ok: false, code: 'session_expired' }
  }

  const sourcesAvailable = {
    summary: false,
    listAggregate: false,
    credits: false,
    windows: false,
    subscription: false,
    chartsEndpoint: false
  }

  const summaryRes = get(0)
  const creditsRes = get(1)
  const windowsRes = get(2)

  const summary = summaryRes && summaryRes.status === 200 ? parseSummary(summaryRes.body) : undefined
  if (summary) sourcesAvailable.summary = true

  const models = usageFetch.status === 200 ? aggregateRecords(usageFetch.records) : undefined
  if (models) sourcesAvailable.listAggregate = true

  // 累积落库（本地累计口径）：按记录 id 去重，可安全重复采集；失败不影响本次展示
  if (usageFetch.status === 200 && usageFetch.records.length > 0) {
    try {
      persistUsageRecords(source.id, normalizeUsageRecords(usageFetch.records))
    } catch (err) {
      console.warn('[Monitor] 用量记录落库失败:', err)
    }
  }

  let credits: { monthlyCredits: number } | undefined
  let windows: CommandCodeUsage['windows'] | undefined

  // 从某响应提取 { windows?, monthlyCredits? }（支持 windowLimits，如 /internal 与 /alpha 同构）
  const extract = (res: CcResponse | null) => {
    if (!res || res.status !== 200) return null
    const parsed = parseWindows(res.body)
    if (!parsed) return null
    const w: NonNullable<CommandCodeUsage['windows']> = {}
    if (parsed.fiveHour) w.fiveHour = parsed.fiveHour
    if (parsed.weekly) w.weekly = parsed.weekly
    return { windows: Object.keys(w).length > 0 ? w : undefined, monthlyCredits: parsed.monthlyCredits }
  }

  // ① /internal/billing/credits（纯登录 cookie）→ 月度余额 + 5h/7d 窗口
  const extInternal = extract(creditsRes)
  credits = extInternal?.monthlyCredits !== undefined ? { monthlyCredits: extInternal.monthlyCredits } : undefined
  if (credits) sourcesAvailable.credits = true
  if (extInternal?.windows) {
    windows = extInternal.windows
    sourcesAvailable.windows = true
  }

  // ② /alpha/billing/credits（Provider API Key）仅作兜底：internal 缺窗口时再取
  if (!windows || !extInternal) {
    const extAlpha = extract(windowsRes)
    if (extAlpha) {
      if (extAlpha.windows && !windows) {
        windows = extAlpha.windows
        sourcesAvailable.windows = true
      }
      if (!credits && extAlpha.monthlyCredits !== undefined) {
        credits = { monthlyCredits: extAlpha.monthlyCredits }
        sourcesAvailable.credits = true
      }
    }
  }

  // ③ 订阅套餐（含到期时间）：Cookie 端点为主，API Key 端点兜底（主端点结构无法识别时）
  const subRes = get(3)
  const subAlphaRes = get(4)
  let subscription: CommandCodeSubscription | undefined
  const parsedSub =
    (subRes && subRes.status === 200 ? parseSubscription(subRes.body) : null) ??
    (subAlphaRes && subAlphaRes.status === 200 ? parseSubscription(subAlphaRes.body) : null)
  if (parsedSub) {
    sourcesAvailable.subscription = true
    if (!parsedSub.none && parsedSub.subscription) subscription = parsedSub.subscription
  }

  // ⑤ /internal/usage/charts：服务端「模型 × 时间桶」聚合 → 本月按模型明细（与汇总同口径）
  const chartsRes = get(5)
  const chartsParse = chartsRes && chartsRes.status === 200 ? parseUsageCharts(chartsRes.body) : null
  let monthlyModels: CommandCodeUsage['monthlyModels']
  if (chartsParse) {
    sourcesAvailable.chartsEndpoint = true
    monthlyModels = {
      rows: aggregateChartRows(chartsParse.rows),
      buckets: chartsParse.buckets,
      ...(chartsParse.window ? { window: chartsParse.window } : {})
    }
  }

  // 全端点失败判定：区块级降级会把"网络全挂"伪装成空数据，这里显式返回错误码让 UI 显示错误条
  const requiredIdx = [0, 1, 3]
  const activeIdx = hasApiKey ? [0, 1, 2, 3, 4] : [0, 1, 3]
  const totalFailure = classifyTotalFailure({
    anySection: Object.values(sourcesAvailable).some(Boolean),
    usageStatus: usageFetch.status,
    requiredStatuses: requiredIdx.map((i) => getStatus(i)),
    requiredRejected: requiredIdx.some((i) => results[i]?.status === 'rejected'),
    statuses: activeIdx.map((i) => getStatus(i))
  })
  if (totalFailure) {
    console.warn(`[Monitor] refresh(${source.id}) 全端点失败 → ${totalFailure.code}: ${totalFailure.error}`)
    return { ok: false, code: totalFailure.code, error: totalFailure.error }
  }

  // 明细覆盖信息：让 UI 能说明「基于多少条记录聚合、覆盖哪段时间、是否已拉全」
  // 注意：不要把 `...(cond ? {x} : {})` 直接写进三元分支的对象字面量里（TS 解析器会报 ':' expected）
  const coverageRange = usageFetch.status === 200 ? recordTimeRange(usageFetch.records) : {}
  const coverageWindow = usageFetch.windowDays !== undefined ? { windowDays: usageFetch.windowDays } : {}
  const modelsCoverage: CommandCodeUsage['modelsCoverage'] = models
    ? {
        records: usageFetch.records.length,
        truncated: usageFetch.truncated,
        ...coverageWindow,
        ...coverageRange
      }
    : undefined

  const data: CommandCodeUsage = {
    fetchedAt: Date.now(),
    sourcesAvailable,
    ...(summary ? { summary } : {}),
    ...(credits ? { credits } : {}),
    ...(windows ? { windows } : {}),
    ...(subscription ? { subscription } : {}),
    ...(models ? { models } : {}),
    ...(monthlyModels ? { monthlyModels } : {}),
    ...(modelsCoverage ? { modelsCoverage } : {})
  }

  return { ok: true, data }
}