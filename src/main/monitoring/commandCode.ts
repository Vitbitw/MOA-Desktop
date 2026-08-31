// ─── Command Code 云端用量监控客户端 ───
// 职责：
//   1. 应用内登录窗：加载 Studio 页面，轮询捕获 session cookie 并安全存储
//   2. 用量拉取：调 Command Code 内部 API（/internal/* 用 Cookie；/alpha/billing/credits 用 Provider API Key）
//   3. 归一化为 CommandCodeUsage，区块级优雅降级
// 网络请求统一走 fetchProxy（尊重用户的网络代理设置）。

import { BrowserWindow, session } from 'electron'
import { fetchProxy } from '../local/fetchProxy'
import {
  saveUsageCredential,
  getUsageCredential,
  removeUsageCredential
} from '../store/key-store'
import type {
  CommandCodeUsage,
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

/** 解析 /internal/usage 的单条用量记录（一条记录 = 一次请求；兼容 camelCase / snake_case 与 meta 嵌套） */
function parseUsageRecord(raw: unknown): { model: string; tokensIn: number; tokensOut: number; tokensTotal: number; cost: number } | undefined {
  if (!isObj(raw)) return undefined
  const meta = isObj(raw.meta) ? raw.meta : null
  const tokensIn = toNum(raw.tokensIn ?? raw.tokens_in) ?? 0
  const tokensOut = toNum(raw.tokensOut ?? raw.tokens_out) ?? 0
  const tokensTotal = toNum(raw.tokensTotal ?? raw.tokens_total) ?? tokensIn + tokensOut
  // 成本优先取 creditsTotal，其次 meta.totalCost / meta.planPoolDraw，最后兜底 raw.cost
  const cost =
    toNum(raw.creditsTotal ?? raw.credits_total) ??
    toNum(meta?.totalCost ?? meta?.total_cost) ??
    toNum(meta?.planPoolDraw ?? meta?.plan_pool_draw) ??
    toNum(raw.cost) ??
    0
  // 模型名在 meta.model / meta.modelName（顶层 model 作为兜底）
  const model =
    (typeof raw.model === 'string' && raw.model) ||
    (typeof meta?.model === 'string' && meta.model) ||
    (typeof meta?.modelName === 'string' && meta.modelName) ||
    ''
  if (!model) return undefined
  return { model, tokensIn, tokensOut, tokensTotal, cost }
}

/** 聚合 /internal/usage 的按模型明细行（请求数 / tokens / 成本，按成本降序） */
function aggregateUsage(body: unknown): NonNullable<CommandCodeUsage['models']> | undefined {
  const unwrapped = unwrapSuccess(body)
  // 记录列表可能在根部、.usages / .items / .data，或嵌套在 .data.data / .data.usages
  const arr = Array.isArray(unwrapped)
    ? unwrapped
    : isObj(unwrapped) && Array.isArray(unwrapped.usages)
      ? unwrapped.usages
      : isObj(unwrapped) && Array.isArray(unwrapped.items)
        ? unwrapped.items
        : isObj(unwrapped) && Array.isArray(unwrapped.data)
          ? unwrapped.data
          : isObj(unwrapped) && isObj(unwrapped.data) && Array.isArray(unwrapped.data.data)
            ? unwrapped.data.data
            : isObj(unwrapped) && isObj(unwrapped.data) && Array.isArray(unwrapped.data.usages)
              ? unwrapped.data.usages
              : null
  if (!arr || arr.length === 0) return undefined

  const map = new Map<string, { model: string; requests: number; cost: number; tokensIn: number; tokensOut: number; tokensTotal: number }>()
  for (const raw of arr) {
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
  const rows = Array.from(map.values()).sort((a, b) => b.cost - a.cost)
  return rows.length > 0 ? rows : undefined
}

/** 解析 /internal/usage/summary（totalTokens 可能为字符串，防御性转换） */
function parseSummary(body: unknown): CommandCodeUsage['summary'] {
  const unwrapped = unwrapSuccess(body)
  if (!isObj(unwrapped)) return undefined
  const totalCount = toNum(unwrapped.totalCount)
  const totalCost = toNum(unwrapped.totalCost)
  const totalTokens = toNum(unwrapped.totalTokens)
  const successRate = toNum(unwrapped.successRate)
  if (totalCount === undefined && totalCost === undefined) return undefined
  return {
    totalCount: totalCount ?? 0,
    totalCost: totalCost ?? 0,
    totalTokens: totalTokens ?? 0,
    successRate: successRate ?? 0
  }
}

// ─── 主入口：拉取并归一化 ───

export type RefreshResult =
  | { ok: true; data: CommandCodeUsage }
  | { ok: false; code: 'not_authenticated' | 'session_expired' | 'network' | 'unknown'; error?: string }

/**
 * 拉取某监控源的云端用量。
 * 并行请求 4 个端点，任一 401/403 → session_expired；
 * 网络异常 → network；其余 → unknown。
 */
export async function refreshCommandCodeUsage(source: RemoteUsageSource): Promise<RefreshResult> {
  const token = getUsageCredential(usageTokenKey(source.id))
  if (!token) return { ok: false, code: 'not_authenticated' }
  const apiKey = getUsageCredential(usageApiKeyKey(source.id))

  const requests: Array<Promise<CcResponse | null>> = [
    ccGet('/internal/usage/summary', { token }),
    // 用量明细：Studio 侧按“请求记录”返回，limit 取最近 N 条再按模型聚合
    ccGet('/internal/usage?limit=100', { token }),
    ccGet('/internal/billing/credits', { token }),
    apiKey ? ccGet('/alpha/billing/credits', { apiKey }) : Promise.resolve(null)
  ]

  let results: Array<PromiseSettledResult<CcResponse | null>>
  try {
    results = await Promise.allSettled(requests)
  } catch (err) {
    return { ok: false, code: 'network', error: err instanceof Error ? err.message : String(err) }
  }

  const get = (i: number): CcResponse | null => {
    const r = results[i]
    return r.status === 'fulfilled' ? r.value : null
  }
  const getStatus = (i: number): number | null => get(i)?.status ?? null

  console.log(
    `[Monitor] refresh(${source.id}): summary=${getStatus(0)} usage=${getStatus(1)} credits=${getStatus(2)} windows=${getStatus(3)}`
  )

  // 401/403 → 会话失效
  if ([0, 1, 2, 3].some((i) => getStatus(i) === 401 || getStatus(i) === 403)) {
    return { ok: false, code: 'session_expired' }
  }

  const sourcesAvailable = { summary: false, charts: false, credits: false, windows: false }

  const summaryRes = get(0)
  const usageRes = get(1)
  const creditsRes = get(2)
  const windowsRes = get(3)

  const summary = summaryRes && summaryRes.status === 200 ? parseSummary(summaryRes.body) : undefined
  if (summary) sourcesAvailable.summary = true

  const models = usageRes && usageRes.status === 200 ? aggregateUsage(usageRes.body) : undefined
  if (models) sourcesAvailable.charts = true

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

  const data: CommandCodeUsage = {
    fetchedAt: Date.now(),
    sourcesAvailable,
    ...(summary ? { summary } : {}),
    ...(credits ? { credits } : {}),
    ...(windows ? { windows } : {}),
    ...(models ? { models } : {})
  }

  return { ok: true, data }
}