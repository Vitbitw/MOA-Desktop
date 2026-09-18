// ─── 云监控页面用量快照持久化 ───
// 渲染层页面缓存（lib/cloudMonitorCache.ts）只活在会话内，应用重启即失效；
// 这里把最近一次成功拉取的归一化用量落库（monitor_snapshots），
// 让应用重启后首进也能立即渲染上次数据（再由渲染层按统一自动刷新间隔决定是否静默刷新）。
// 写入点：页面刷新成功（monitor:refresh）/ 后台采集成功；登出时清除（换账号不残留）。
// 快照是缓存性质的数据：读写失败一律降级（读取返回 null、写入仅告警），不影响刷新本身。

import { getDatabase } from '../db/database'
import type { MonitorUsage } from '../../shared/types'

/** 写入/更新某监控源的用量快照（按 source_id 覆盖） */
export function saveUsageSnapshot(sourceId: string, usage: MonitorUsage): void {
  try {
    getDatabase().exec(
      `INSERT OR REPLACE INTO monitor_snapshots (source_id, usage_json, fetched_at) VALUES (?, ?, ?)`,
      [sourceId, JSON.stringify(usage), usage.fetchedAt]
    )
  } catch (err) {
    console.warn('[Monitor] 快照写入失败:', err)
  }
}

/** 读取某监控源的用量快照（无记录或解析失败 → null） */
export function getUsageSnapshot(sourceId: string): MonitorUsage | null {
  try {
    const row = getDatabase().queryOne<{ usage_json: string }>(
      'SELECT usage_json FROM monitor_snapshots WHERE source_id = ?',
      [sourceId]
    )
    if (!row?.usage_json) return null
    return JSON.parse(row.usage_json) as MonitorUsage
  } catch (err) {
    console.warn('[Monitor] 快照读取失败:', err)
    return null
  }
}

/** 清除某监控源的用量快照（登出时调用：换账号后不得残留旧账号数据） */
export function clearUsageSnapshot(sourceId: string): void {
  try {
    getDatabase().exec('DELETE FROM monitor_snapshots WHERE source_id = ?', [sourceId])
  } catch (err) {
    console.warn('[Monitor] 快照清除失败:', err)
  }
}
