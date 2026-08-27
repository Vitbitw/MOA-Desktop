// ─── Xiaomi MiMo 云端用量监控客户端 ───
// 职责：
//   1. 应用内登录窗：加载 platform.xiaomimimo.com，轮询捕获登录 Cookie（api-platform_serviceToken / userId 等）
//   2. 用量拉取：/api/v1/balance（账户余额）、/api/v1/tokenPlan/usage（Token Plan 套餐用量）
//   3. 归一化为 MimoUsage，区块级优雅降级
// 网络请求统一走 fetchProxy（尊重用户的网络代理设置）。
// 注意：MiMo 无 API Key 通道，余额/套餐查询全部基于登录 Cookie（约 24h 有效期，过期需重新登录）。

import { BrowserWindow, session } from 'electron'
import { fetchProxy } from '../local/fetchProxy'
import { saveUsageCredential, getUsageCredential } from '../store/key-store'
import type { MimoBalance, MimoTokenPlan, MimoUsage, RemoteUsageSource } from '../../shared/types'

const API_BASE = 'https://platform.xiaomimimo.com/api/v1'
const LOGIN_URL = 'https://platform.xiaomimimo.com'
const LOGIN_PARTITION = 'persist:mimo'
const REQUEST_TIMEOUT_MS = 15_000

/** 判定登录有效所需的关键 cookie 名 */
const REQUIRED_COOKIES = ['api-platform_serviceToken', 'userId']

let loginWin: BrowserWindow | null = null

// ─── 凭证 ───

function credKey(sourceId: string): string {
  return sourceId
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

// ─── 登录窗 ───

export function loginToMimo(
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

    // 分区已持久化过登录态 → 直接复用
    const existing = await buildCookieHeader(ses)
    if (existing) {
      captured = true
      saveUsageCredential(credKey(source.id), existing)
      finish({ success: true })
      return
    }

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
        saveUsageCredential(credKey(source.id), header)
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
            saveUsageCredential(credKey(source.id), header)
            finish({ success: true })
            return
          }
          if (attempts >= 8) {
            clearInterval(graceTimer)
            finish({ success: false, cancelled: true })
            console.warn('[Monitor] MiMo 登录窗关闭且宽限期后仍未捕获到凭证 cookie')
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
  | { ok: true; data: MimoUsage }
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
 * 金额单位为 Credit 原数值（如 Standard 套餐总上限 200M），展示层自行换算。 */
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
      items.push({
        name: raw.name,
        used,
        limit,
        percent: toNum(raw.percent) ?? (limit > 0 ? (used / limit) * 100 : 0)
      })
    }
  }
  if (items.length === 0) return undefined
  return { percent: toNum(usage.percent) ?? 0, items }
}

export async function refreshMimoUsage(source: RemoteUsageSource): Promise<MimoRefreshResult> {
  const cookie = getUsageCredential(credKey(source.id))
  if (!cookie) return { ok: false, code: 'not_authenticated' }

  const [balRes, planRes] = await Promise.all([mimoGet('/balance', cookie), mimoGet('/tokenPlan/usage', cookie)])
  console.log(`[Monitor] mimo refresh(${source.id}): balance=${balRes.status} tokenPlan=${planRes.status}`)

  // 401/403 → 会话失效（cookie 过期，约 24h）
  if (balRes.status === 401 || balRes.status === 403 || planRes.status === 401 || planRes.status === 403) {
    return { ok: false, code: 'session_expired' }
  }

  const data: MimoUsage = { fetchedAt: Date.now(), sourcesAvailable: { balance: false, tokenPlan: false } }

  if (balRes.status === 200) {
    const balance = parseBalance(balRes.body)
    if (balance) {
      data.balance = balance
      data.sourcesAvailable.balance = true
    }
  }
  if (planRes.status === 200) {
    const tokenPlan = parseTokenPlan(planRes.body)
    if (tokenPlan) {
      data.tokenPlan = tokenPlan
      data.sourcesAvailable.tokenPlan = true
    }
  }

  return { ok: true, data }
}