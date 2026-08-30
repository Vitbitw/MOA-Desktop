// ─── 用量与费用统计 ───
// 费用优先级：settings.pricing[modelId]（用户自定义覆盖）> settings.probedPricing（官方探查价，含峰谷时段）
//             > DEFAULT_PRICING 前缀匹配 > 0。
// 设置存储于 moa_config 表 key='app_settings'（JSON），与主进程 IPC 读取方式一致。

import { getDatabase } from '../db/database'
import { lookupPrice } from '../../shared/pricing'
import type { AppSettings, ProbedPricingEntry, PricingWindow } from '../../shared/types'

export interface UsageEntry {
  modelId: string
  /** 厂商 ID（用于按厂商分组；旧数据可能缺失） */
  providerId?: string
  role: 'sub' | 'agg' | 'title'
  prompt: number
  completion: number
  cost: number
}

interface Price {
  input: number
  output: number
}

/** 读取用户自定义定价（settings.pricing[modelId]），读取失败或未配置时返回 null；命中手动峰谷窗口则用窗口价 */
function getCustomPrice(modelId: string, timestamp: number): Price | null {
  try {
    const row = getDatabase().queryOne<{ value: string }>(
      "SELECT value FROM moa_config WHERE key = 'app_settings'"
    )
    if (!row?.value) return null
    const settings = JSON.parse(row.value) as Partial<AppSettings>
    const cfg = settings.pricing?.[modelId]
    if (!cfg) return null
    // 仅当 input/output 为有效数值时采用自定义定价
    if (typeof cfg.input !== 'number' || !Number.isFinite(cfg.input) ||
        typeof cfg.output !== 'number' || !Number.isFinite(cfg.output)) {
      return null
    }
    // 命中手动配置的峰谷窗口（多时段 + 按星期）则用窗口价，否则用基础价
    if (Array.isArray(cfg.windows) && cfg.windows.length > 0) {
      const tz = cfg.timezone || 'Asia/Shanghai'
      const tod = minutesOf(timeOfDay(tz, timestamp))
      const wd = dayOfWeek(tz, timestamp)
      const hit = cfg.windows.find((w) => inWindow(tod, w, wd))
      if (hit && typeof hit.input === 'number' && typeof hit.output === 'number') {
        return { input: hit.input, output: hit.output }
      }
    }
    return { input: cfg.input, output: cfg.output }
  } catch {
    return null
  }
}

// ─── 峰谷时段定价 ───

/** 计算 ts 在指定时区下的 'HH:mm'（24h）。时区非法时回退本地时间。 */
function timeOfDay(tz: string, ts: number): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(ts))
    const hour = parts.find((p) => p.type === 'hour')?.value ?? '00'
    const minute = parts.find((p) => p.type === 'minute')?.value ?? '00'
    return `${hour}:${minute}`
  } catch {
    const d = new Date(ts)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
}

/** 计算 ts 在指定时区下的星期（0=周日..6=周六，JS Date.getDay() 语义）。时区非法时回退本地时间。 */
function dayOfWeek(tz: string, ts: number): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).formatToParts(new Date(ts))
    const wd = parts.find((p) => p.type === 'weekday')?.value
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
    return wd ? (map[wd] ?? new Date(ts).getDay()) : new Date(ts).getDay()
  } catch {
    return new Date(ts).getDay()
  }
}

function minutesOf(tod: string): number {
  const [h, m] = tod.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

/** 命中窗口：星期匹配（缺省/空 days = 每天）且 [start, end) 不含右端点；start > end 表示跨午夜（[start,24:00) ∪ [00:00,end)） */
function inWindow(todMinutes: number, win: PricingWindow, wd?: number): boolean {
  if (wd !== undefined && Array.isArray(win.days) && win.days.length > 0 && !win.days.includes(wd)) {
    return false
  }
  const start = minutesOf(win.start)
  const end = minutesOf(win.end)
  if (start <= end) return todMinutes >= start && todMinutes < end
  return todMinutes >= start || todMinutes < end
}

/** 命中峰谷窗口则用窗口价，否则用基础价 */
function resolveWindow(entry: ProbedPricingEntry, ts: number): Price {
  if (!entry.windows || entry.windows.length === 0) {
    return { input: entry.input, output: entry.output }
  }
  const tz = entry.timezone || 'Asia/Shanghai'
  const tod = minutesOf(timeOfDay(tz, ts))
  const wd = dayOfWeek(tz, ts)
  const hit = entry.windows.find((w) => inWindow(tod, w, wd))
  if (hit) return { input: hit.input, output: hit.output }
  return { input: entry.input, output: entry.output }
}

/** 读取官方探查定价（settings.probedPricing），最长前缀匹配 + 多源取最新 */
function getProbedPrice(modelId: string, timestamp: number): Price | null {
  try {
    const row = getDatabase().queryOne<{ value: string }>(
      "SELECT value FROM moa_config WHERE key = 'app_settings'"
    )
    if (!row?.value) return null
    const settings = JSON.parse(row.value) as Partial<AppSettings>
    const list = settings.probedPricing
    if (!Array.isArray(list) || list.length === 0) return null

    let best: ProbedPricingEntry | null = null
    for (const e of list) {
      if (!e?.pattern) continue
      if (e.pattern !== modelId && !modelId.startsWith(e.pattern)) continue
      // 最长前缀优先；同前缀取 fetchedAt 最新
      if (
        !best ||
        e.pattern.length > best.pattern.length ||
        (e.pattern.length === best.pattern.length && e.fetchedAt > best.fetchedAt)
      ) {
        best = e
      }
    }
    if (!best) return null
    return resolveWindow(best, timestamp)
  } catch {
    return null
  }
}

/**
 * 计算一次调用的费用（USD）。
 * 优先级：settings.pricing[modelId] > settings.probedPricing（含峰谷时段）> lookupPrice(modelId) > 0。
 * 金额 = (prompt * input + completion * output) / 1_000_000，保留 6 位小数。
 * 注意：价格单位为 USD / 1M tokens（与 DEFAULT_PRICING 及设置页一致）。
 */
export function computeCost(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
  timestamp = Date.now()
): number {
  const price = getCustomPrice(modelId, timestamp) ?? getProbedPrice(modelId, timestamp) ?? lookupPrice(modelId)
  if (!price) return 0
  const raw = (promptTokens * price.input + completionTokens * price.output) / 1_000_000
  return Math.round(raw * 1_000_000) / 1_000_000
}

/** 为每条用量记录计算 cost（timestamp 用于峰谷时段定价，默认当前时间） */
export function buildUsageEntries(
  entries: Array<{ modelId: string; providerId?: string; role: UsageEntry['role']; prompt: number; completion: number }>,
  timestamp = Date.now()
): UsageEntry[] {
  return entries.map((e) => ({
    ...e,
    cost: computeCost(e.modelId, e.prompt, e.completion, timestamp)
  }))
}

/** 汇总多条用量记录 */
export function sumUsage(entries: UsageEntry[]): { prompt: number; completion: number; cost: number } {
  let prompt = 0
  let completion = 0
  let cost = 0
  for (const e of entries) {
    prompt += e.prompt
    completion += e.completion
    cost += e.cost
  }
  return { prompt, completion, cost }
}
