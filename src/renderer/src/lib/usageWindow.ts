// ─── 云端额度窗口（5小时/7天）展示辅助 ───
// 独立纯函数模块：倒计时文案 + 「已过重置时刻」判定，便于单独做行为测试。

import type { UsageWindowInfo } from '../../../shared/types'

/**
 * 距窗口重置的剩余时间文案。
 * nowMs 必须由调用方按秒推进 —— 只在组件重渲染时算一次的话，文案会冻在旧值上。
 * 会重置为负：<60s 显示秒（让「到点」可见），已过点显示「窗口已重置」。
 */
export function fmtRemaining(resetAtSec: number, nowMs: number = Date.now()): string {
  const remainMs = resetAtSec * 1000 - nowMs
  if (remainMs <= 0) return '窗口已重置'
  const remainSec = Math.floor(remainMs / 1000)
  if (remainSec < 60) return `${remainSec} 秒后重置`
  const totalMin = Math.ceil(remainMs / 60_000)
  const d = Math.floor(totalMin / 1440)
  const h = Math.floor((totalMin % 1440) / 60)
  const m = totalMin % 60
  if (d > 0) return `${d}天${h}小时后重置`
  if (h > 0) return `${h}小时${m}分钟后重置`
  return `${m}分钟后重置`
}

/**
 * 数据快照是否早于该窗口的重置时刻 —— 是则当前展示的是「上一个窗口」的用量：
 * 数值已作废，UI 应置灰提示，同时触发一次补拉（见 expiredWindows）。
 * 快照晚于重置时刻（fetchedAt >= resetAt）说明服务端已给出新窗口，不再视为过期。
 */
export function isStaleAfterReset(
  info: UsageWindowInfo | undefined,
  nowMs: number,
  fetchedAt: number | undefined
): boolean {
  if (info?.resetAt === undefined) return false
  const resetAtMs = info.resetAt * 1000
  if (resetAtMs > nowMs) return false
  return fetchedAt === undefined || fetchedAt < resetAtMs
}

/**
 * 挑出「已过重置时刻且数据快照早于该时刻」的窗口 = 需要立刻补拉的窗口。
 * 调用方按 resetAt 去重，避免补拉失败时反复重试。
 */
export function expiredWindows(
  windows: Array<UsageWindowInfo | undefined>,
  nowMs: number,
  fetchedAt: number | undefined
): UsageWindowInfo[] {
  const out: UsageWindowInfo[] = []
  for (const w of windows) {
    if (w !== undefined && isStaleAfterReset(w, nowMs, fetchedAt)) out.push(w)
  }
  return out
}
