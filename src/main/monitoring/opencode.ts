// ─── OpenCode Go 云端用量监控客户端 ───
// 职责：
//   1. 用量拉取：GET /zen/go/v1/usage（Authorization: Bearer <Provider API Key>）
//      → 归一化为 OpenCodeUsage（5 小时滚动 / 周 / 月 三个用量窗口）
//   2. 无登录窗：OpenCode Go 无 cookie 通道，凭据唯一路径 = 面板粘贴 API Key
//      （opencode.ai/auth 控制台创建，对应 MONITOR_SET_API_KEY IPC）
// 网络请求统一走 fetchProxy（尊重用户的网络代理设置）。
// 不参与后台采集 / 本地累计（快照式数据无累计语义），故本模块不 import electron / usageAccumulator
// —— 回归测试（test-e2e/opencode-request.cjs）只需 stub fetchProxy + keyStore 两个模块。

import { fetchProxy } from '../local/fetchProxy'
import { getUsageCredential, removeUsageCredential } from '../store/key-store'
import type { MonitorStatus, OpenCodeUsage, OpenCodeWindowInfo } from '../../shared/types'

const API_BASE = 'https://opencode.ai'
/** 用量端点（实测 2026-09-27：GET 200；HEAD 恒 401 → 必须 GET） */
const USAGE_PATH = '/zen/go/v1/usage'

// ─── 凭证 key 约定（与 commandCode 一致；按**账号**键控，默认账号 id = 源 id）───

export function usageApiKeyKey(accountId: string): string {
  return `${accountId}.apiKey`
}

/** 查询某账号的认证状态：无 cookie 概念，两字段同值（UI 只看 hasApiKey） */
export function getOpenCodeStatus(accountId: string): MonitorStatus {
  const hasApiKey = !!getUsageCredential(usageApiKeyKey(accountId))
  return { loggedIn: hasApiKey, hasApiKey }
}

/** 清除某账号的 API Key（只动本账号；同源其它账号不受影响） */
export function logoutOpenCode(accountId: string): void {
  removeUsageCredential(usageApiKeyKey(accountId))
}

// ─── 防御性解析（本文件自带一份，不依赖 commandCode 导出）───

function toNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object'
}

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

/** 解析单个用量窗口（一层结构校验）：status 原样；percent 数值夹取 [0,100]；resetsAt 归一为 epoch 秒 */
function parseWindow(w: unknown): OpenCodeWindowInfo | undefined {
  if (!isObj(w)) return undefined
  const info: OpenCodeWindowInfo = {}
  const status = str(w.status)
  if (status) info.status = status
  const percent = toNum(w.percent)
  if (percent !== undefined) info.usedPercent = Math.min(100, Math.max(0, percent))
  const resetAt = toEpochSec(w.resetsAt)
  if (resetAt !== undefined) info.resetAt = resetAt
  return Object.keys(info).length > 0 ? info : undefined
}

/**
 * 解析用量响应（实测形态 2026-09-27）：
 *   { usage: { rolling: { status, percent, resetsAt }, weekly: {...}, monthly: {...} } }
 * 只做一层结构校验（服务端契约已实测，不做多余嵌套容错）：body.usage 是对象 →
 * 各窗口过 parseWindow；一个窗口都解析不出 → null（调用方按「结构不识别」处理）。
 */
export function parseOpenCodeUsage(body: unknown): OpenCodeUsage['windows'] | null {
  if (!isObj(body)) return null
  const usage = isObj(body.usage) ? body.usage : null
  if (!usage) return null
  const windows: OpenCodeUsage['windows'] = {}
  const rolling = parseWindow(usage.rolling)
  const weekly = parseWindow(usage.weekly)
  const monthly = parseWindow(usage.monthly)
  if (rolling) windows.rolling = rolling
  if (weekly) windows.weekly = weekly
  if (monthly) windows.monthly = monthly
  return Object.keys(windows).length > 0 ? windows : null
}

// ─── 主入口：拉取并归一化 ───

export type OpenCodeRefreshResult =
  | { ok: true; data: OpenCodeUsage }
  | { ok: false; code: 'not_authenticated' | 'session_expired' | 'network' | 'unknown'; error?: string }

/**
 * 拉取某**账号**的 OpenCode Go 用量（凭据 / 日志一律按 accountId）。
 * 无 key → not_authenticated；fetch 抛错 → network；401/403 → session_expired（API Key 失效）；
 * 非 200 → unknown(HTTP n)；200 但结构不识别 → unknown；成功 → { fetchedAt, windows }。
 * 不落库、不写快照（快照由 index.ts 的 MONITOR_REFRESH 统一 saveUsageSnapshot）。
 */
export async function refreshOpenCodeUsage(accountId: string): Promise<OpenCodeRefreshResult> {
  const apiKey = getUsageCredential(usageApiKeyKey(accountId))
  if (!apiKey) return { ok: false, code: 'not_authenticated' }

  let status: number
  let body: unknown
  try {
    const resp = await fetchProxy(`${API_BASE}${USAGE_PATH}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'User-Agent': 'moa-desktop'
      }
    })
    status = resp.status
    body = await resp.json().catch(() => null)
  } catch (err) {
    // 超时与重试统一由 fetchProxy 处理（配置见「云端用量监控」页的 API 请求设置）
    return { ok: false, code: 'network', error: err instanceof Error ? err.message : String(err) }
  }

  if (status === 401 || status === 403) return { ok: false, code: 'session_expired' }
  if (status !== 200) return { ok: false, code: 'unknown', error: `HTTP ${status}` }

  const windows = parseOpenCodeUsage(body)
  if (!windows) {
    console.warn(`[Monitor] refresh(${accountId}) OpenCode 响应结构无法识别`)
    return { ok: false, code: 'unknown', error: '响应结构无法识别' }
  }
  return { ok: true, data: { fetchedAt: Date.now(), windows } }
}
