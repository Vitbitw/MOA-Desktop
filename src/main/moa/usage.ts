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
  /**
   * 记账账号 ID（写入时快照 = 当时的当前账号）。多账号来源下通道 / 订阅费 / 分组
   * 全部按它读，切账号或改通道不会把历史行重新归到别的账号头上（防串号）。
   * 旧数据无此字段 → 读取端回退 providerId（默认账号 id = providerId）。
   */
  accountId?: string
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
 * T2 通道分支（设计 §3 写入端）：当前账号 billing='plan' 时
 *   manual（settings.pricing）命中 → 用 manual 价（用户显式意图，最高优先级）；
 *   否则 → cost=0 占位，读取端（USAGE_GET_SUMMARY / TODAY）按期内消费比值摊销重算，写入不定值。
 * billing='usage' / providerId 缺失 → 行为与现状完全一致（manual > probed > default）。
 * 同时把**当前账号 id 快照进条目**：该行此后只认这个账号的通道与订阅费。
 */
export function buildUsageEntries(
  entries: Array<{ modelId: string; providerId?: string; accountId?: string; role: UsageEntry['role']; prompt: number; completion: number }>,
  timestamp = Date.now()
): UsageEntry[] {
  const providers = entries.some((e) => e.providerId !== undefined)
    ? new Map(getAllProviders().map((p) => [p.id, p] as const))
    : null
  return entries.map((e) => {
    const provider = e.providerId && providers ? providers.get(e.providerId) : undefined
    const accountId = e.accountId ?? provider?.activeAccountId
    if (provider?.billing === 'plan') {
      const manual = getCustomPrice(e.modelId, timestamp)
      if (manual) return { ...e, accountId, cost: costFromPrice(manual, e.prompt, e.completion) }
      return { ...e, accountId, cost: 0 }
    }
    return { ...e, accountId, cost: computeCost(e.modelId, e.prompt, e.completion, timestamp, e.providerId) }
  })
}

// ─── Plan 通道：期内消费比值摊销（设计 §3，读时重算） ───

/** 摊销输入行：timestamp = 条目写入时间戳（分桶依据）；cost = 写入时的值（usage 原值 / plan 的 manual 值或 0 占位） */
export interface PlanCostRow {
  modelId: string
  providerId?: string
  /** 记账账号（写入时快照）；缺失 = 旧数据，按 providerId 的默认账号解析 */
  accountId?: string
  prompt: number
  completion: number
  timestamp: number
  cost: number
}

/** 账号维度的记账上下文：通道 + 订阅费 + 归属来源（摊销与分组都以它为准） */
export interface AccountBillingInfo {
  accountId: string
  providerId: string
  billing: 'usage' | 'plan'
  plan?: { amount: number; currency: 'USD' | 'CNY'; anchorTs?: number }
}

/**
 * 建立账号索引（一次摊销全程复用）：
 * - byAccount：accountId → 通道/订阅费（多账号来源下每账号各算各的，互不稀释）；
 * - byProvider：providerId → 兜底信息（旧数据无 accountId 时用；优先默认账号，否则当前账号投影）。
 */
export function buildAccountBillingIndex(
  providers: readonly Provider[]
): { byAccount: Map<string, AccountBillingInfo>; byProvider: Map<string, AccountBillingInfo> } {
  const byAccount = new Map<string, AccountBillingInfo>()
  const byProvider = new Map<string, AccountBillingInfo>()
  for (const p of providers) {
    for (const a of p.accounts ?? []) {
      byAccount.set(a.id, { accountId: a.id, providerId: p.id, billing: a.billing, ...(a.plan ? { plan: a.plan } : {}) })
    }
    // 兜底取当前账号投影（accounts 缺失的测试桩 / 旧数据也能算）
    const fallbackId = p.activeAccountId || p.id
    byProvider.set(p.id, {
      accountId: byAccount.has(fallbackId) ? fallbackId : p.id,
      providerId: p.id,
      billing: p.billing,
      ...(p.plan ? { plan: p.plan } : {})
    })
  }
  return { byAccount, byProvider }
}

/**
 * 解析一行明细的记账账号上下文（隔离关键路径）：
 * 1. 有 accountId → 只认该账号；账号已删返回 undefined（**不借用同来源其他账号的通道/订阅费**），
 *    由消费端回退单价链，避免把 A 账号的账算到 B 账号头上；
 * 2. 无 accountId（旧数据）→ providerId 恰是默认账号 id，直接命中；默认账号已删 → 来源投影兜底；
 * 3. providerId 也缺失 → undefined。
 */
export function resolveAccountBilling(
  row: { providerId?: string; accountId?: string },
  idx: { byAccount: Map<string, AccountBillingInfo>; byProvider: Map<string, AccountBillingInfo> }
): AccountBillingInfo | undefined {
  if (row.accountId) return idx.byAccount.get(row.accountId)
  if (!row.providerId) return undefined
  return idx.byAccount.get(row.providerId) ?? idx.byProvider.get(row.providerId)
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
 * 1. 解析不到记账账号（无 providerId / 厂商已删）→ 原 cost 不变（usage 通道行为不变）；
 *    账号已删（有 accountId 但账号不存在）→ 单价链回退：**不借用同来源其他账号的订阅费**；
 * 2. 账号通道为 plan + manual（settings.pricing[modelId]）命中 → 原 cost（写入时已按 manual 计，读写同源复现）；
 * 3. plan + 已配订阅费（amount > 0）：
 *    'read' → 桶内比值摊销 `cost_i = amountUSD × tokens_i / Σtokens(同桶同**账号**)`；
 *    'write' → 保持写入占位值（0）；
 * 4. plan + 未配订阅费（缺 / 0）→ 单价链回退 `computeCost`（probed 按通道 > default），read/write 同。
 *
 * 分桶：`bucket = floor((ts - anchorTs) / 30天)`，anchorTs 缺省 = 当月 1 号（按条目 timestamp 所属自然月）；
 * **同账号同桶聚合**——同一来源的 Plan 账号与按量账号各占各的桶，订阅费不会互相稀释。
 * `amountUSD = amount / (currency === 'CNY' ? 7.2 : 1)`——**方向与 probe.ts 的 CNY→USD 折算一致（除以 7.2）**，
 * 设计文档 §3 写的 `amount × (CNY ? 7.2 : 1)` 与 probe.ts:714-716 矛盾（会让 72 CNY 变成 518.4 USD），此处按维度正确性取除法；
 * `Σtokens = 0` → 该桶全 0（不除零、不抛错）。逐条 6 位舍入后把残差回填到桶内 token 最大的一条，保证桶内 Σcost = amountUSD。
 */
export function computePlanAllocatedCosts(
  rows: PlanCostRow[],
  providers: readonly Provider[],
  mode: PlanCostMode = 'read'
): number[] {
  const idx = buildAccountBillingIndex(providers)
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
    const acc = resolveAccountBilling(r, idx)
    if (!acc) {
      // 账号已删 → 单价链；无 providerId / 厂商已删 → 原值不变
      out[i] = r.accountId
        ? computeCost(r.modelId, r.prompt, r.completion, r.timestamp, r.providerId)
        : r.cost
      continue
    }
    if (acc.billing !== 'plan') {
      out[i] = r.cost
      continue
    }
    // manual 最高优先（与写入端同一 getCustomPrice 判断，可复现）
    if (getCustomPrice(r.modelId, r.timestamp)) {
      out[i] = r.cost
      continue
    }
    const amount = acc.plan?.amount
    if (!(typeof amount === 'number' && amount > 0)) {
      out[i] = computeCost(r.modelId, r.prompt, r.completion, r.timestamp, r.providerId)
      continue
    }
    if (mode === 'write') {
      out[i] = r.cost // 写入端不摊销：保持 0 占位，读取端统一重算
      continue
    }
    const tokens = (r.prompt || 0) + (r.completion || 0)
    const key = `${acc.accountId}|${planBucket(r.timestamp, acc.plan?.anchorTs)}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = {
        amountUSD: amount / (acc.plan?.currency === 'CNY' ? CNY_TO_USD_RATE : 1), // CNY → USD：与 probe.ts 同向（÷7.2）
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

/** 查询范围汇聚重算的输入行：timestamp = 日志行写入时间戳（分桶依据）；models = 该行已解析的明细列 */
export interface PlanCostRangeRow {
  timestamp: number
  models: Array<{ modelId: string; providerId?: string; accountId?: string; prompt?: number; completion?: number; cost?: number }> | null
}

/**
 * 读取端入口（T2.1 评审 MF-1 修复，设计 §3③）：**查询范围汇聚重算 + 按行回填**。
 *
 * 旧的单行入口把分母（桶内 Σtokens map）局部在「单条日志行的 models」里，每行各自吃掉整期 amountUSD
 * → Σ = 行数 × 期内消费（3 行实测 3.00x）。这里把 rows 内**所有行**的 plan 明细摊平成
 * 一次 `computePlanAllocatedCosts` 调用（按 **账号** × 桶跨行聚合，分母 = 本次查询范围的行），
 * 再按 (行, 明细下标) 回填——totals、分组明细、TODAY 全用同一份结果。
 *
 * 口径：range='all' 时桶内 Σcost = 期内消费严格成立；today/week/month 窗口 range 为窗口近似
 * （分母不含范围外历史行，设计 §3③ 已声明）。
 *
 * 返回与 rows 等长的数组：
 * - 该行明细无 plan 条目（usage 行 / providerId 缺失 / 厂商已删 / 无明细或损坏）→ null，
 *   调用方沿用行级写入值 `row.cost`（与旧行为一致，manual 命中行同样由 read 分支保留 manual 值）；
 * - 该行含 plan 条目 → 该行各明细的重算 cost 数组（与明细等长）。
 */
export function computeRangePlanCosts(
  rows: readonly PlanCostRangeRow[],
  providers: readonly Provider[]
): Array<number[] | null> {
  const idx = buildAccountBillingIndex(providers)
  // 该明细是否需要进摊销重算：当前账号是 plan，或其账号已删（需回退单价链而非沿用 0 占位）
  const needsRecompute = (m: { providerId?: string; accountId?: string }): boolean => {
    if (m.accountId && !idx.byAccount.has(m.accountId)) return true
    return resolveAccountBilling(m, idx)?.billing === 'plan'
  }

  const out: Array<number[] | null> = new Array(rows.length).fill(null)
  const flat: PlanCostRow[] = []
  // 回填位：指向所属行的明细数组，避免二次查找
  const slots: Array<{ arr: number[]; col: number }> = []

  for (let ri = 0; ri < rows.length; ri++) {
    const models = rows[ri].models
    if (!models || models.length === 0 || !models.some(needsRecompute)) continue
    const arr: number[] = new Array(models.length).fill(0)
    out[ri] = arr
    for (let mi = 0; mi < models.length; mi++) {
      const m = models[mi]
      slots.push({ arr, col: mi })
      flat.push({
        modelId: m.modelId,
        providerId: m.providerId,
        accountId: m.accountId,
        prompt: m.prompt || 0,
        completion: m.completion || 0,
        timestamp: rows[ri].timestamp,
        cost: m.cost || 0
      })
    }
  }
  if (flat.length === 0) return out // 范围内无 plan 明细 → 全 null（调用方沿用写入值）

  const costs = computePlanAllocatedCosts(flat, providers, 'read')
  for (let i = 0; i < slots.length; i++) slots[i].arr[slots[i].col] = costs[i]
  return out
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
      accountId: e.accountId,
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
