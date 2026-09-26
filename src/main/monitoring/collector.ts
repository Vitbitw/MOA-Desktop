// ─── 用量后台采集（Command Code / Xiaomi MiMo） ───
// 目的：服务端列表接口对部分套餐只给最近 100 条（实测跨度约 20 分钟），「本地累计」只有在
// 采集足够频繁时才有意义。这里在应用运行期间按设置间隔自动拉取并累积落库，
// 使累计不依赖「云监控页是否打开」。
//
// 说明：
//   - 处理 commandcode / mimo 类型的已启用源下**每一个账号**（DeepSeek 等其余源接口结构不同，累积逻辑不可复用）
//   - 采集间隔 = 统一自动刷新间隔（monitoring.autoRefreshMinutes，与页面刷新共用；0 = 关闭），
//     每分钟检查一次是否需要采集，间隔从设置读取 → 改设置无需重启应用
//   - 与手动刷新共用 refreshCommandCodeUsage / refreshMimoUsage，因此同样走 fetchProxy（尊重网络代理设置）；
//     页面刷新会调用 markUsageCollected(accountId) 占位——**按账号隔离**，
//     A 账号的页面刷新不会抑制 B 账号同一间隔内的后台采集

import { readAppSettings } from '../config/appSettings'
import { getUsageCredential } from '../store/key-store'
import { refreshCommandCodeUsage, usageTokenKey } from './commandCode'
import { refreshMimoUsage } from './mimo'
import { getCumulativeUsage, recordCollectorRun } from './usageAccumulator'
import { saveUsageSnapshot } from './snapshotStore'
import type { AppSettings, MonitorAccount, MonitorUsage, RemoteUsageSource } from '../../shared/types'

/** 检查周期（毫秒）：每分钟判断一次是否到点 */
const CHECK_PERIOD_MS = 60_000
/** 启动后首次采集的延迟（毫秒）：避开启动高峰 */
const FIRST_RUN_DELAY_MS = 15_000

const DEBUG = process.env.MOA_MONITOR_DEBUG === '1'

interface CollectorStatus {
  /** 是否启用（统一自动刷新间隔 > 0 且有已登录的 commandcode/mimo 账号） */
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
/** 每账号最近一次采集时间（页面刷新也占位；按账号隔离，A 的刷新不抑制 B 的采集） */
const lastCollectedByAccount = new Map<string, number>()
let lastError: string | null = null
let running = false

/** 生效的采集间隔（分钟）：读取统一的自动刷新间隔（0 = 关闭）。
 * 合并前是独立的 collectIntervalMinutes，现与页面「自动刷新」共用 monitoring.autoRefreshMinutes。 */
export function effectiveIntervalMinutes(settings: AppSettings): number {
  const n = Math.floor(Number(settings.monitoring.autoRefreshMinutes))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 记录某账号的一次「数据采集」发生（页面刷新/自动刷新调用，非后台采集器）。
 * 页面刷新与后台采集共用同一间隔，调用方在拉取前占位 → 采集器跳过该账号同一间隔内的重复拉取。
 * 只占位本账号：同源其它账号的后台采集照常进行。
 */
export function markUsageCollected(accountId: string): void {
  lastCollectedByAccount.set(accountId, Date.now())
}

/** 全部账号中最近一次采集时间（供状态展示与调度判断） */
function latestCollectedAt(): number {
  let max = 0
  for (const t of lastCollectedByAccount.values()) if (t > max) max = t
  return max
}

/** 参与后台采集的账号：已启用的 commandcode / mimo 源 × 该源全部账号 */
function collectibleAccounts(settings: AppSettings): Array<{ source: RemoteUsageSource; account: MonitorAccount }> {
  const out: Array<{ source: RemoteUsageSource; account: MonitorAccount }> = []
  for (const source of settings.monitoring.sources) {
    if (!source.enabled || (source.type !== 'commandcode' && source.type !== 'mimo')) continue
    for (const account of settings.monitoring.accounts) {
      if (account.sourceId === source.id) out.push({ source, account })
    }
  }
  return out
}

/** 一轮账号刷新的归一化结果（两源 refresh 返回类型不同，在此收敛，避免联合类型交叉访问） */
interface AccountRefreshOutcome {
  ok: boolean
  code?: string
  /** 本轮累计表受影响行数（新增或数值变化） */
  inserted: number
  data: MonitorUsage | null
  /** DEBUG 日志摘要 */
  debug: string
}

/** 按源类型执行刷新并归一化（刷新内部完成记录落库，凭据 / 快照 / 累计一律按 accountId） */
async function refreshAccountForCollect(
  source: RemoteUsageSource,
  accountId: string
): Promise<AccountRefreshOutcome> {
  if (source.type === 'mimo') {
    const res = await refreshMimoUsage(accountId)
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
  const before = getCumulativeUsage(accountId).records
  const res = await refreshCommandCodeUsage(accountId)
  if (res.ok) {
    const inserted = Math.max(0, getCumulativeUsage(accountId).records - before)
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
    const intervalMs = effectiveIntervalMinutes(settings) * 60_000
    for (const { source, account } of collectibleAccounts(settings)) {
      // 同一账号同一间隔内只采一次（页面刷新已占位则跳过）
      const last = lastCollectedByAccount.get(account.id) ?? 0
      if (last > 0 && intervalMs > 0 && Date.now() - last < intervalMs) continue
      if (!getUsageCredential(usageTokenKey(account.id))) continue
      const outcome = await refreshAccountForCollect(source, account.id)
      lastCollectedByAccount.set(account.id, Date.now())
      // 持久化运行记录：即使本轮没有新记录，也能在 UI 上看到"采集器还在跑"
      try {
        recordCollectorRun(account.id, {
          ok: outcome.ok,
          inserted: outcome.inserted,
          ...(outcome.ok ? {} : { error: outcome.code ?? 'unknown' })
        })
      } catch {
        // 状态写入失败不影响采集本身
      }
      if (outcome.ok && outcome.data) {
        // 后台采集同样更新落盘快照：页面未打开时也在刷新，重启后首进可直接恢复
        saveUsageSnapshot(account.id, outcome.data)
        lastError = null
      } else {
        lastError = outcome.code ?? 'unknown'
      }
      if (DEBUG) {
        console.log(`[Monitor] 后台采集(${trigger}) ${account.id}: ${outcome.debug}`)
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
    // 不做全局预跳过：逐账号的「间隔内已采」判断在 collectOnce 内完成（按账号隔离，
    // A 的刷新不抑制 B）。任何「任一账号新鲜就整轮 return」的口径都会让其余账号轮不到。
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
  const hasAccount = collectibleAccounts(settings).length > 0
  return {
    enabled: intervalMinutes > 0 && hasAccount,
    intervalMinutes,
    lastCollectedAt: latestCollectedAt(),
    lastError,
    running
  }
}
