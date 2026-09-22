// ─── 用量与费用统计 ───
// 费用优先级：settings.pricing[modelId]（用户自定义覆盖）> settings.probedPricing（官方探查价，含峰谷时段）
//             > DEFAULT_PRICING 前缀匹配 > 0。
// 设置存储于 moa_config 表 key='app_settings'（JSON），与主进程 IPC 读取方式一致。

import { readAppSettings } from '../config/appSettings'
import { lookupPrice } from '../../shared/pricing'
import { getAllProviders } from '../providers/providerManager'
import type { Provider, ProbedPricingEntry, PricingWindow } from '../../shared/types'

/** 币种折算 CNY → USD（与 src/main/pricing/probe.ts 的 CNY_TO_USD_RATE 同值；此处独立常量，避免用量模块反向依赖探查模块） */
export const CNY_TO_USD_RATE = 7.2

/** Plan 摊销周期长度：anchorTs 给定时按「30 天 = 1 期」分桶（bucket = floor((ts - anchorTs) / 本常量)） */
const PLAN_MONTH_MS = 30 * 24 * 3600 * 1000

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
  const cfg = readAppSettings().pricing[modelId]
  // input/output 任一未配置 → 未设置自定义定价
  if (!cfg || cfg.input === undefined || cfg.output === undefined) return null
  // 命中手动配置的峰谷窗口（多时段 + 按星期）则用窗口价，否则用基础价
  if (cfg.windows?.length) {
    const tz = cfg.timezone || 'Asia/Shanghai'
    const tod = minutesOf(timeOfDay(tz, timestamp))
    const wd = dayOfWeek(tz, timestamp)
    const hit = cfg.windows.find((w) => inWindow(tod, w, wd))
    if (hit) return { input: hit.input, output: hit.output }
  }
  return { input: cfg.input, output: cfg.output }
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

/**
 * 读取官方探查定价（settings.probedPricing），最长前缀匹配 + 多源取最新。
 * T2 通道过滤（设计 §5）：条目带 providerId 时仅对同一厂商的调用生效；
 * 无标记条目（源未绑 provider 的通用条目 / 旧数据）对所有通道命中。
 */
function getProbedPrice(modelId: string, timestamp: number, providerId?: string): Price | null {
  const list = readAppSettings().probedPricing
  if (list.length === 0) return null

  let best: ProbedPricingEntry | null = null
  for (const e of list) {
    if (!e.pattern) continue
    if (e.providerId !== undefined && e.providerId !== providerId) continue
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
}

/** 按单价计算费用（USD），保留 6 位小数 */
function costFromPrice(price: Price, promptTokens: number, completionTokens: number): number {
  const raw = (promptTokens * price.input + completionTokens * price.output) / 1_000_000
  return Math.round(raw * 1_000_000) / 1_000_000
}

/**
 * 计算一次调用的费用（USD）。
 * 优先级：settings.pricing[modelId] > settings.probedPricing（含峰谷时段，按通道过滤）> lookupPrice(modelId) > 0。
 * 金额 = (prompt * input + completion * output) / 1_000_000，保留 6 位小数。
 * 注意：价格单位为 USD / 1M tokens（与 DEFAULT_PRICING 及设置页一致）。
 * @param providerId 调用方厂商 ID：探查条目绑定厂商时（设计 §5）仅同厂商命中；缺省则只命中通用条目。
 */
export function computeCost(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
  timestamp = Date.now(),
  providerId?: string
): number {
  const price = getCustomPrice(modelId, timestamp) ?? getProbedPrice(modelId, timestamp, providerId) ?? lookupPrice(modelId)
  if (!price) return 0
  return costFromPrice(price, promptTokens, completionTokens)
}

/**
 * 为每条用量记录计算 cost（timestamp 用于峰谷时段定价，默认当前时间）。
 * T2 通道分支（设计 §3 写入端）：provider.billing='plan' 时
 *   manual（settings.pricing）命中 → 用 manual 价（用户显式意图，最高优先级）；
 *   否则 → cost=0 占位，读取端（USAGE_GET_SUMMARY / TODAY）按期内消费比值摊销重算，写入不定值。
 * billing='usage' / providerId 缺失 → 行为与现状完全一致（manual > probed > default）。
 */
export function buildUsageEntries(
  entries: Array<{ modelId: string; providerId?: string; role: UsageEntry['role']; prompt: number; completion: number }>,
  timestamp = Date.now()
): UsageEntry[] {
  const providers = entries.some((e) => e.providerId !== undefined)
    ? new Map(getAllProviders().map((p) => [p.id, p] as const))
    : null
  return entries.map((e) => {
    const provider = e.providerId && providers ? providers.get(e.providerId) : undefined
    if (provider?.billing === 'plan') {
      const manual = getCustomPrice(e.modelId, timestamp)
      if (manual) return { ...e, cost: costFromPrice(manual, e.prompt, e.completion) }
      return { ...e, cost: 0 }
    }
    return { ...e, cost: computeCost(e.modelId, e.prompt, e.completion, timestamp, e.providerId) }
  })
}

// ─── Plan 通道：期内消费比值摊销（设计 §3，读时重算） ───

/** 摊销输入行：timestamp = 条目写入时间戳（分桶依据）；cost = 写入时的值（usage 原值 / plan 的 manual 值或 0 占位） */
export interface PlanCostRow {
  modelId: string
  providerId?: string
  prompt: number
  completion: number
  timestamp: number
  cost: number
}

/**
 * 计算模式：
 * - 'read'（默认）：读取端权威重算——已配订阅费的 plan 条目按比值摊销；
 * - 'write'：写入端后处理——不做摊销（单请求作用域会把整期金额记进一条日志），仅补「未配订阅费 → 单价链」回退。
 */
export type PlanCostMode = 'read' | 'write'

/** Plan 分桶：anchorTs 给定 → floor((ts - anchorTs) / 30 天)；缺省 → 条目所属自然月（当月 1 号起） */
function planBucket(timestamp: number, anchorTs?: number): number | string {
  if (typeof anchorTs === 'number' && Number.isFinite(anchorTs)) {
    return Math.floor((timestamp - anchorTs) / PLAN_MONTH_MS)
  }
  const d = new Date(timestamp)
  return `m${d.getFullYear()}-${d.getMonth()}`
}

/**
 * Plan 通道成本：期内消费比值摊销（设计 §3）。返回与 rows 等长的新 cost 数组。
 *
 * 口径（逐行判定，顺序即优先级）：
 * 1. provider 非 plan / providerId 缺失 / 厂商已删 → 原 cost 不变（usage 通道行为不变）；
 * 2. plan + manual（settings.pricing[modelId]）命中 → 原 cost（写入时已按 manual 计，读写同源复现）；
 * 3. plan + 已配订阅费（amount > 0）：
 *    'read' → 桶内比值摊销 `cost_i = amountUSD × tokens_i / Σtokens(同桶同 provider)`；
 *    'write' → 保持写入占位值（0）；
 * 4. plan + 未配订阅费（缺 / 0）→ 单价链回退 `computeCost`（probed 按通道 > default），read/write 同。
 *
 * 分桶：`bucket = floor((ts - anchorTs) / 30天)`，anchorTs 缺省 = 当月 1 号（按条目 timestamp 所属自然月）；
 * 同 provider 同桶聚合。`amountUSD = amount / (currency === 'CNY' ? 7.2 : 1)`——**方向与 probe.ts 的 CNY→USD 折算一致（除以 7.2）**，
 * 设计文档 §3 写的 `amount × (CNY ? 7.2 : 1)` 与 probe.ts:714-716 矛盾（会让 72 CNY 变成 518.4 USD），此处按维度正确性取除法；
 * `Σtokens = 0` → 该桶全 0（不除零、不抛错）。逐条 6 位舍入后把残差回填到桶内 token 最大的一条，保证桶内 Σcost = amountUSD。
 */
export function computePlanAllocatedCosts(
  rows: PlanCostRow[],
  providers: readonly Provider[],
  mode: PlanCostMode = 'read'
): number[] {
  const byId = new Map(providers.map((p) => [p.id, p] as const))
  const out: number[] = new Array(rows.length).fill(0)
  interface Bucket {
    amountUSD: number
    totalTokens: number
    maxTokenIdx: number
    maxTokens: number
    idx: number[]
  }
  const buckets = new Map<string, Bucket>()

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const provider = r.providerId ? byId.get(r.providerId) : undefined
    if (!provider || provider.billing !== 'plan') {
      out[i] = r.cost
      continue
    }
    // manual 最高优先（与写入端同一 getCustomPrice 判断，可复现）
    if (getCustomPrice(r.modelId, r.timestamp)) {
      out[i] = r.cost
      continue
    }
    const amount = provider.plan?.amount
    if (!(typeof amount === 'number' && amount > 0)) {
      out[i] = computeCost(r.modelId, r.prompt, r.completion, r.timestamp, r.providerId)
      continue
    }
    if (mode === 'write') {
      out[i] = r.cost // 写入端不摊销：保持 0 占位，读取端统一重算
      continue
    }
    const tokens = (r.prompt || 0) + (r.completion || 0)
    const key = `${r.providerId}|${planBucket(r.timestamp, provider.plan?.anchorTs)}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = {
        amountUSD: amount / (provider.plan?.currency === 'CNY' ? CNY_TO_USD_RATE : 1), // CNY → USD：与 probe.ts 同向（÷7.2）
        totalTokens: 0,
        maxTokenIdx: i,
        maxTokens: tokens,
        idx: []
      }
      buckets.set(key, bucket)
    }
    bucket.totalTokens += tokens
    bucket.idx.push(i)
    if (tokens > bucket.maxTokens) {
      bucket.maxTokens = tokens
      bucket.maxTokenIdx = i
    }
    out[i] = 0
  }

  for (const bucket of buckets.values()) {
    if (bucket.totalTokens <= 0) continue // Σtokens = 0 → 全 0，不除零
    let sum = 0
    for (const i of bucket.idx) {
      const r = rows[i]
      out[i] = Math.round((bucket.amountUSD * ((r.prompt || 0) + (r.completion || 0))) / bucket.totalTokens * 1_000_000) / 1_000_000
      sum += out[i]
    }
    // 尾差回填：保证桶内 Σcost = amountUSD（残差 ≤ 5e-7）
    const diff = bucket.amountUSD - sum
    if (diff !== 0) {
      out[bucket.maxTokenIdx] = Math.round((out[bucket.maxTokenIdx] + diff) * 1_000_000) / 1_000_000
    }
  }
  return out
}

/**
 * 读取端便捷入口：给定一行的 models 明细，返回摊销重算后的 cost 数组（与明细等长）。
 * 明细内无 plan 通道条目（usage 行 / 厂商已删 / 无 providerId）→ 返回 null，调用方沿用写入值。
 */
export function computePlanEntryCosts(
  models: Array<{ modelId: string; providerId?: string; prompt?: number; completion?: number; cost?: number }>,
  timestamp: number,
  providers: readonly Provider[]
): number[] | null {
  const byId = new Map(providers.map((p) => [p.id, p] as const))
  const hasPlan = models.some((m) => m.providerId !== undefined && byId.get(m.providerId)?.billing === 'plan')
  if (!hasPlan) return null
  return computePlanAllocatedCosts(
    models.map((m) => ({
      modelId: m.modelId,
      providerId: m.providerId,
      prompt: m.prompt || 0,
      completion: m.completion || 0,
      timestamp,
      cost: m.cost || 0
    })),
    providers,
    'read'
  )
}

/**
 * 写入端后处理（网关三处 buildUsageEntries 之后调用）：把 plan 条目的占位 cost 补成
 * 「未配订阅费 → 单价链估算」；已配订阅费的条目保持 0 占位（读取端摊销重算），manual 值原样保留。
 * providers 省略时按需从 providerManager 取（无 providerId 的条目不触发查询）。
 */
export function applyPlanWritePricing(
  entries: UsageEntry[],
  providers?: readonly Provider[],
  timestamp = Date.now()
): UsageEntry[] {
  if (entries.length === 0 || !entries.some((e) => e.providerId !== undefined)) return entries
  const list = providers ?? getAllProviders()
  const costs = computePlanAllocatedCosts(
    entries.map((e) => ({
      modelId: e.modelId,
      providerId: e.providerId,
      prompt: e.prompt,
      completion: e.completion,
      timestamp,
      cost: e.cost
    })),
    list,
    'write'
  )
  return entries.map((e, i) => ({ ...e, cost: costs[i] }))
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
