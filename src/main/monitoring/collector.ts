// ─── Command Code 用量后台采集 ───
// 目的：服务端列表接口对部分套餐只给最近 100 条（实测跨度约 20 分钟），「本地累计」只有在
// 采集足够频繁时才有意义。这里在应用运行期间按设置间隔自动拉取并累积落库，
// 使累计不依赖「云监控页是否打开」。
//
// 说明：
//   - 仅处理 commandcode 类型的已启用源（其余源的接口结构不同，累积逻辑不可复用）
//   - 每分钟检查一次是否需要采集，间隔从设置读取 → 改设置无需重启应用
//   - 与手动刷新共用 refreshCommandCodeUsage，因此同样走 fetchProxy（尊重网络代理设置）

import { getDatabase } from '../db/database'
import { getUsageCredential } from '../store/key-store'
import { refreshCommandCodeUsage, usageTokenKey } from './commandCode'
import { getCumulativeUsage, recordCollectorRun } from './usageAccumulator'
import { DEFAULT_MONITORING } from '../../shared/defaults'
import type { AppSettings, MonitoringSettings, RemoteUsageSource } from '../../shared/types'

/** 缺省采集间隔（分钟）；设置项缺失或非法时使用 */
const DEFAULT_INTERVAL_MINUTES = 15
/** 检查周期（毫秒）：每分钟判断一次是否到点 */
const CHECK_PERIOD_MS = 60_000
/** 启动后首次采集的延迟（毫秒）：避开启动高峰 */
const FIRST_RUN_DELAY_MS = 15_000

const DEBUG = process.env.MOA_MONITOR_DEBUG === '1'

interface CollectorStatus {
  /** 是否启用（间隔 > 0 且有已登录的 commandcode 源） */
  enabled: boolean
  /** 生效的采集间隔（分钟），0 = 关闭 */
  intervalMinutes: number
  /** 最近一次采集完成时间（epoch 毫秒），0 = 尚未采集 */
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

/** 从 DB 读取应用设置（与 fetchProxy 相同的读取方式） */
function readSettings(): AppSettings | null {
  try {
    const row = getDatabase().queryOne<{ value: string }>(
      "SELECT value FROM moa_config WHERE key = 'app_settings'"
    )
    if (!row?.value) return null
    return JSON.parse(row.value) as AppSettings
  } catch {
    return null
  }
}

/**
 * 合并默认值后的 monitoring 设置。
 * 关键：DB 里的 app_settings 只保存用户改过的字段（实测 monitoring 常常整体缺失，
 * 渲染层是靠 DEFAULT_SETTINGS 补齐才显示三个监控源的），后台采集必须做同样的合并，
 * 否则 sources 为空 → 采集器永不启用。
 * 注意：显式空数组视为用户主动清空，不再回退默认（只有字段缺失才用默认）。
 */
function mergedMonitoring(settings: AppSettings | null): MonitoringSettings {
  const raw = settings?.monitoring
  if (!raw) return DEFAULT_MONITORING
  return {
    sources: Array.isArray(raw.sources) ? raw.sources : DEFAULT_MONITORING.sources,
    autoRefreshMinutes: raw.autoRefreshMinutes ?? DEFAULT_MONITORING.autoRefreshMinutes,
    collectIntervalMinutes: raw.collectIntervalMinutes ?? DEFAULT_MONITORING.collectIntervalMinutes
  }
}

/** 生效的采集间隔（分钟）：设置缺失/非法 → 默认值；<0 → 0（关闭） */
export function effectiveIntervalMinutes(settings?: AppSettings | null): number {
  const raw = mergedMonitoring(settings ?? null).collectIntervalMinutes
  if (raw === undefined || raw === null || !Number.isFinite(Number(raw))) return DEFAULT_INTERVAL_MINUTES
  const n = Math.floor(Number(raw))
  return n < 0 ? 0 : n
}

function commandCodeSources(settings?: AppSettings | null): RemoteUsageSource[] {
  return mergedMonitoring(settings ?? null).sources.filter((s) => s.enabled && s.type === 'commandcode')
}

/** 执行一轮采集（同一时刻只允许一轮；失败只记录错误码，不影响应用其余功能） */
async function collectOnce(trigger: 'first' | 'timer'): Promise<void> {
  if (running) return
  running = true
  try {
    const settings = readSettings()
    const sources = commandCodeSources(settings)
    for (const source of sources) {
      if (!getUsageCredential(usageTokenKey(source.id))) continue
      const before = getCumulativeUsage(source.id).records
      const res = await refreshCommandCodeUsage(source)
      const inserted = Math.max(0, getCumulativeUsage(source.id).records - before)
      lastCollectedAt = Date.now()
      // 持久化运行记录：即使本轮没有新记录，也能在 UI 上看到"采集器还在跑"
      try {
        recordCollectorRun(source.id, {
          ok: res.ok,
          inserted,
          ...(res.ok ? {} : { error: res.code ?? 'unknown' })
        })
      } catch {
        // 状态写入失败不影响采集本身
      }
      if (res.ok) {
        lastError = null
      } else if (res.code === 'not_authenticated' || res.code === 'session_expired') {
        lastError = res.code
      } else {
        lastError = res.code
      }
      if (DEBUG) {
        console.log(
          `[Monitor] 后台采集(${trigger}) ${source.id}: ${res.ok ? `ok pages=${res.data.modelsCoverage?.records ?? 0} 条记录 · 新增 ${inserted} 条` : `失败 code=${res.code ?? 'unknown'}`}`
        )
      }
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    if (DEBUG) console.warn('[Monitor] 后台采集异常:', err)
  } finally {
    running = false
  }
}

/** 启动后台采集（幂等）。应用运行期间常驻；间隔从设置读取，改设置无需重启 */
export function startUsageCollector(): void {
  if (timer || firstRunTimer) return

  firstRunTimer = setTimeout(() => {
    firstRunTimer = null
    void collectOnce('first')
  }, FIRST_RUN_DELAY_MS)

  timer = setInterval(() => {
    const minutes = effectiveIntervalMinutes(readSettings())
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
  const settings = readSettings()
  const intervalMinutes = effectiveIntervalMinutes(settings)
  const hasSource = commandCodeSources(settings).length > 0
  return { enabled: intervalMinutes > 0 && hasSource, intervalMinutes, lastCollectedAt, lastError, running }
}
