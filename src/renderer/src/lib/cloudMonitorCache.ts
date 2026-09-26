// ─── 云监控页面数据快照缓存（渲染层） ───
// 页面切走时 CloudMonitorView 随条件渲染整体卸载（App.tsx），组件内 state 随之丢失，
// 重进会白屏并重新拉取一遍远端接口。这里按 **accountId** 保存最近一次成功拉取的快照
// （模块级内存，随渲染进程存活）：
//   - 重进时先渲染快照 + 「上次刷新」时间（不再白屏）
//   - 快照仍新鲜（未超过统一自动刷新间隔）时不打接口；过期则静默刷新
// 仅存内存：应用重启后首进仍会重新拉取。
// 按账号键控 = 同源多个账号各自一份快照，互不覆盖；
// 注意：登出时必须 clearCloudSnapshot，否则换账号后重进会残留上一账号的数据。

import type { CumulativeModelUsage, MonitorStatus, MonitorUsage } from '../../../shared/types'

/** 后台采集器状态（与主进程 getCollectorStatus 返回一致） */
export interface CollectorStatusInfo {
  enabled: boolean
  intervalMinutes: number
  lastCollectedAt: number
  lastError: string | null
  running: boolean
}

/** 单个监控账号的页面快照 */
export interface CloudSnapshot {
  /** 最近一次成功拉取的归一化用量（其 fetchedAt 即该数据的拉取时间，本地时钟） */
  usage: MonitorUsage | null
  /** 登录态（loadStatus 结果；用于切视图重进时首帧直接渲染正确外观，避免先闪「登录」按钮） */
  status: MonitorStatus | null
  /** 本地累计（Command Code） */
  cumulative: CumulativeModelUsage | null
  /** 采集器状态（Command Code） */
  collector: CollectorStatusInfo | null
  /** 模型明细口径选择（Command Code：服务端聚合 / 本地累计） */
  detailMode: 'monthly' | 'cumulative' | null
}

const EMPTY: CloudSnapshot = { usage: null, status: null, cumulative: null, collector: null, detailMode: null }

const snapshots = new Map<string, CloudSnapshot>()

/** 读快照（无记录时 undefined） */
export function getCloudSnapshot(accountId: string): CloudSnapshot | undefined {
  return snapshots.get(accountId)
}

/** 局部更新快照（未提及的字段保持原值） */
export function patchCloudSnapshot(accountId: string, patch: Partial<CloudSnapshot>): void {
  snapshots.set(accountId, { ...(snapshots.get(accountId) ?? EMPTY), ...patch })
}

/** 清除快照（登出时调用：换账号后不得残留旧账号数据；只清本账号） */
export function clearCloudSnapshot(accountId: string): void {
  snapshots.delete(accountId)
}

/** 自动刷新关闭（仅手动刷新）时的最小去重窗：避免频繁切换视图反复打接口 */
const MIN_DEDUPE_MS = 5 * 60_000

/**
 * 重进页面时是否需要打远端接口（决定「先渲染快照」后是否静默刷新）：
 * - 无快照 → 拉
 * - 快照年龄 < 统一自动刷新间隔 → 跳过（等价于「页面没离开过」的刷新节律：
 *   若一直开着，下一次拉取也还没到点）
 * - 自动刷新关闭时以最小去重窗（5 分钟）为准，避免频繁切视图反复拉取
 */
export function shouldFetchOnMount(usage: MonitorUsage | null, refreshMinutes: number, now: number = Date.now()): boolean {
  if (!usage) return true
  const ttlMs = refreshMinutes > 0 ? refreshMinutes * 60_000 : MIN_DEDUPE_MS
  return now - usage.fetchedAt >= ttlMs
}
