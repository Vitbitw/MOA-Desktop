// ─── 用量与费用统计 ───
// 费用优先级：settings.pricing[modelId]（用户自定义覆盖）> DEFAULT_PRICING 前缀匹配 > 0。
// 设置存储于 moa_config 表 key='app_settings'（JSON），与主进程 IPC 读取方式一致。

import { getDatabase } from '../db/database'
import { lookupPrice } from '../../shared/pricing'
import type { AppSettings } from '../../shared/types'

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

/** 读取用户自定义定价（settings.pricing[modelId]），读取失败或未配置时返回 null */
function getCustomPrice(modelId: string): Price | null {
  try {
    const row = getDatabase().queryOne<{ value: string }>(
      "SELECT value FROM moa_config WHERE key = 'app_settings'"
    )
    if (!row?.value) return null
    const settings = JSON.parse(row.value) as Partial<AppSettings>
    const cfg = settings.pricing?.[modelId]
    if (!cfg) return null
    // 仅当 input/output 为有效数值时采用自定义定价
    if (typeof cfg.input === 'number' && Number.isFinite(cfg.input) &&
        typeof cfg.output === 'number' && Number.isFinite(cfg.output)) {
      return { input: cfg.input, output: cfg.output }
    }
    return null
  } catch {
    return null
  }
}

/**
 * 计算一次调用的费用（USD）。
 * 优先级：settings.pricing[modelId] > lookupPrice(modelId) > 0。
 * 金额 = (prompt * input + completion * output) / 1000，保留 6 位小数。
 */
export function computeCost(modelId: string, promptTokens: number, completionTokens: number): number {
  const price = getCustomPrice(modelId) ?? lookupPrice(modelId)
  if (!price) return 0
  const raw = (promptTokens * price.input + completionTokens * price.output) / 1000
  return Math.round(raw * 1_000_000) / 1_000_000
}

/** 为每条用量记录计算 cost */
export function buildUsageEntries(
  entries: Array<{ modelId: string; providerId?: string; role: UsageEntry['role']; prompt: number; completion: number }>
): UsageEntry[] {
  return entries.map((e) => ({
    ...e,
    cost: computeCost(e.modelId, e.prompt, e.completion)
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
