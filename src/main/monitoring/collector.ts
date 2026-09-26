// ─── 用量后台采集（Command Code / Xiaomi MiMo） ───
// 目的：服务端列表接口对部分套餐只给最近 100 条（实测跨度约 20 分钟），「本地累计」只有在
// 采集足够频繁时才有意义。这里在应用运行期间按设置间隔自动拉取并累积落库，
// 使累计不依赖「云监控页是否打开」。
//
// 说明：
//   - 处理 commandcode / mimo 类型的已启用源（DeepSeek 等其余源接口结构不同，累积逻辑不可复用）
//   - 采集间隔 = 统一自动刷新间隔（monitoring.autoRefreshMinutes，与页面刷新共用；0 = 关闭），
//     每分钟检查一次是否需要采集，间隔从设置读取 → 改设置无需重启应用
//   - 与手动刷新共用 refreshCommandCodeUsage / refreshMimoUsage，因此同样走 fetchProxy（尊重网络代理设置）；
//     页面刷新会调用 markUsageCollected 占位，同一间隔内本采集器不再重复拉取

import { readAppSettings } from '../config/appSettings'
import { getUsageCredential } from '../store/key-store'
import { refreshCommandCodeUsage, usageTokenKey } from './commandCode'
import { refreshMimoUsage } from './mimo'
import { getCumulativeUsage, recordCollectorRun } from './usageAccumulator'
import { saveUsageSnapshot } from './snapshotStore'
import type { AppSettings, MonitorUsage, RemoteUsageSource } from '../../shared/types'

/** 检查周期（毫秒）：每分钟判断一次是否到点 */
const CHECK_PERIOD_MS = 60_000
/** 启动后首次采集的延迟（毫秒）：避开启动高峰 */
const FIRST_RUN_DELAY_MS = 15_000

const DEBUG = process.env.MOA_MONITOR_DEBUG === '1'

interface CollectorStatus {
  /** 是否启用（统一自动刷新间隔 > 0 且有已登录的 commandcode/mimo 源） */
  enabled: boolean
  /** 生效的采集间隔（分钟），0 = 关闭 */
  intervalMinutes: number
  /** 最近一次数据采集完成时间（epoch 毫秒；含页面刷新触发的采集），0 = 尚未采集 */
  lastCollectedAt: number
  /** 最近一次采集的错误码（成功后清空） */
  lastError: string | null
  /** 是否正在采集 */
  running: boolean
}

let timer: ReturnType<typeof setInterval> | null = null
let firstRunTimer: ReturnType<typeof setTimeout> | null = null
let lastCollectedAt = 0
let lastError: string | null = null
let running = false

/** 生效的采集间隔（分钟）：读取统一的自动刷新间隔（0 = 关闭）。
 * 合并前是独立的 collectIntervalMinutes，现与页面「自动刷新」共用 monitoring.autoRefreshMinutes。 */
export function effectiveIntervalMinutes(settings: AppSettings): number {
  const n = Math.floor(Number(settings.monitoring.autoRefreshMinutes))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 记录一次「数据采集」发生（页面刷新/自动刷新调用，非后台采集器）。
 * 页面刷新与后台采集共用同一间隔，调用方在拉取前占位 → 采集器跳过同一间隔内的重复拉取。
 */
export function markUsageCollected(): void {
  lastCollectedAt = Date.now()
}

/** 参与后台采集的源：commandcode / mimo（接口结构已归一化为可累积的记录流） */
function collectibleSources(settings: AppSettings): RemoteUsageSource[] {
  return settings.monitoring.sources.filter((s) => s.enabled && (s.type === 'commandcode' || s.type === 'mimo'))
}

/** 一轮源刷新的归一化结果（两源 refresh 返回类型不同，在此收敛，避免联合类型交叉访问） */
interface SourceRefreshOutcome {
  ok: boolean
  code?: string
  /** 本轮累计表受影响行数（新增或数值变化） */
  inserted: number
  data: MonitorUsage | null
  /** DEBUG 日志摘要 */
  debug: string
}

/** 按源类型执行刷新并归一化（刷新内部完成记录落库） */
async function refreshSourceForCollect(source: RemoteUsageSource): Promise<SourceRefreshOutcome> {
  if (source.type === 'mimo') {
    const res = await refreshMimoUsage(source)
    if (res.ok) {
      return {
        ok: true,
        inserted: res.persisted,
        data: res.data,
        debug: `ok 明细模型 ${res.data.monthlyModels?.rows.length ?? 0} 个 · 变更 ${res.persisted} 行`
      }
    }
    return { ok: false, code: res.code, inserted: 0, data: null, debug: `失败 code=${res.code}` }
  }
  const before = getCumulativeUsage(source.id).records
  const res = await refreshCommandCodeUsage(source)
  if (res.ok) {
    const inserted = Math.max(0, getCumulativeUsage(source.id).records - before)
    return {
      ok: true,
      inserted,
      data: res.data,
      debug: `ok pages=${res.data.modelsCoverage?.records ?? 0} 条记录 · 新增 ${inserted}`
    }
  }
  return { ok: false, code: res.code, inserted: 0, data: null, debug: `失败 code=${res.code}` }
}

/** 执行一轮采集（同一时刻只允许一轮；失败只记录错误码，不影响应用其余功能） */
async function collectOnce(trigger: 'first' | 'timer'): Promise<void> {
  if (running) return
  running = true
  try {
    const settings = readAppSettings()
    const sources = collectibleSources(settings)
    for (const source of sources) {
      if (!getUsageCredential(usageTokenKey(source.id))) continue
      const outcome = await refreshSourceForCollect(source)
      lastCollectedAt = Date.now()
      // 持久化运行记录：即使本轮没有新记录，也能在 UI 上看到"采集器还在跑"
      try {
        recordCollectorRun(source.id, {
          ok: outcome.ok,
          inserted: outcome.inserted,
          ...(outcome.ok ? {} : { error: outcome.code ?? 'unknown' })
        })
      } catch {
        // 状态写入失败不影响采集本身
      }
      if (outcome.ok && outcome.data) {
        // 后台采集同样更新落盘快照：页面未打开时也在刷新，重启后首进可直接恢复
        saveUsageSnapshot(source.id, outcome.data)
        lastError = null
      } else {
        lastError = outcome.code ?? 'unknown'
      }
      if (DEBUG) {
        console.log(`[Monitor] 后台采集(${trigger}) ${source.id}: ${outcome.debug}`)
      }
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    if (DEBUG) console.warn('[Monitor] 后台采集异常:', err)
  } finally {
    running = false
  }
}

/** 启动后台采集（幂等）。应用运行期间常驻；间隔从设置读取（统一自动刷新间隔），改设置无需重启 */
export function startUsageCollector(): void {
  if (timer || firstRunTimer) return

  firstRunTimer = setTimeout(() => {
    firstRunTimer = null
    // 关闭状态不采集：首次采集属于「自动刷新」的一部分，不是独立机制
    if (effectiveIntervalMinutes(readAppSettings()) <= 0) return
    void collectOnce('first')
  }, FIRST_RUN_DELAY_MS)

  timer = setInterval(() => {
    const minutes = effectiveIntervalMinutes(readAppSettings())
    if (minutes <= 0) return
    if (lastCollectedAt > 0 && Date.now() - lastCollectedAt < minutes * 60_000) return
    void collectOnce('timer')
  }, CHECK_PERIOD_MS)
}

/** 停止后台采集（应用退出时调用） */
export function stopUsageCollector(): void {
  if (timer) clearInterval(timer)
  if (firstRunTimer) clearTimeout(firstRunTimer)
  timer = null
  firstRunTimer = null
}

/** 当前采集器状态（供 UI 展示"是否在采集/上次采集时间/错误"） */
export function getCollectorStatus(): CollectorStatus {
  const settings = readAppSettings()
  const intervalMinutes = effectiveIntervalMinutes(settings)
  const hasSource = collectibleSources(settings).length > 0
  return { enabled: intervalMinutes > 0 && hasSource, intervalMinutes, lastCollectedAt, lastError, running }
}
