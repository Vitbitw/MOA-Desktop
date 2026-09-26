import React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../store/settingsStore'
import { formatCost } from '../lib/usageFormat'
import { expiredWindows, fmtRemaining, isStaleAfterReset } from '../lib/usageWindow'
import { clearCloudSnapshot, getCloudSnapshot, patchCloudSnapshot, shouldFetchOnMount } from '../lib/cloudMonitorCache'
import type { CollectorStatusInfo } from '../lib/cloudMonitorCache'
import { ExternalLink, KeyRound, Loader2, LogOut, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type {
  CommandCodeSubscription,
  CommandCodeUsage,
  CumulativeModelUsage,
  DeepSeekBalanceInfo,
  DeepSeekUsage,
  MimoSubscription,
  MimoUsage,
  MonitorAccount,
  MonitorStatus,
  MonitorErrorCode,
  RemoteUsageSource,
  UsageWindowInfo
} from '../../../shared/types'

// ─── 格式化辅助 ───

/** 大数字缩写：>=1M 显示 x.xM，>=1k 显示 x.xk */
function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function barColor(pct: number): string {
  if (pct >= 90) return 'bg-destructive'
  if (pct >= 70) return 'bg-yellow-500'
  return 'bg-primary'
}

/** 记录时间跨度 → 「09-17 10:02 ~ 10:31」（跨天时带出结束日期） */
function fmtSpan(fromTs?: number, toTs?: number): string | null {
  if (fromTs === undefined || toTs === undefined) return null
  const f = new Date(fromTs)
  const t = new Date(toTs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const dm = (d: Date): string => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const hm = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const end = dm(f) === dm(t) ? hm(t) : `${dm(t)} ${hm(t)}`
  return `${dm(f)} ${hm(f)} ~ ${end}`
}

// ─── 子组件：额度窗口卡 ───

/**
 * 额度窗口卡。
 * - 倒计时每秒自走：只在父级重渲染时算一次的话，文案会冻在旧值（用户看到「即将重置」不再变化）
 * - 数据快照早于窗口重置时刻 → 展示的是上一个窗口的用量：数值置灰并提示
 *   （面板会在到点后补拉一次，见 CommandCodePanel 的「窗口到点补拉」）
 */
function WindowCard({
  title,
  info,
  disabled,
  fetchedAt,
  autoRefreshOn
}: {
  title: string
  info?: UsageWindowInfo
  disabled?: boolean
  /** 该数据的拉取时间（epoch 毫秒）；用于判断展示的是不是重置前的旧窗口 */
  fetchedAt?: number
  /** 自动刷新是否开启（决定到点提示文案：正在刷新 / 请手动刷新） */
  autoRefreshOn?: boolean
}) {
  const used = info?.usedPercent
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const staleAfterReset = isStaleAfterReset(info, now, fetchedAt)
  const countdownText =
    info?.resetAt === undefined
      ? '—'
      : staleAfterReset
        ? autoRefreshOn
          ? '窗口已到重置时刻 · 正在刷新…'
          : '窗口已到重置时刻 · 请手动刷新'
        : fmtRemaining(info.resetAt, now)
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground mb-2">{title}</div>
      {disabled ? (
        <div className="text-sm text-muted-foreground leading-5">配置 Provider API Key 后显示</div>
      ) : info && used !== undefined ? (
        <>
          <div className={`flex items-baseline justify-between mb-1.5 ${staleAfterReset ? 'opacity-40' : ''}`}>
            <span className="text-lg font-semibold tabular-nums text-foreground">{used.toFixed(2)}% 已用</span>
            <span className="text-xs text-muted-foreground">{(100 - used).toFixed(2)}% 剩余</span>
          </div>
          <div className={`h-1.5 rounded-full bg-muted overflow-hidden ${staleAfterReset ? 'opacity-40' : ''}`}>
            <div className={`h-full rounded-full ${barColor(used)}`} style={{ width: `${Math.min(100, used)}%` }} />
          </div>
          <div className={`mt-1.5 text-xs ${staleAfterReset ? 'text-yellow-600' : 'text-muted-foreground'}`}>
            {countdownText}
          </div>
        </>
      ) : (
        <div className="text-sm text-muted-foreground">暂无数据</div>
      )}
    </div>
  )
}

/**
 * 月度额度卡（账单月）。已用% 与官网同口径：1 − 余额 ÷ 套餐月度额度（见主进程 computeMonthlyWindow）；
 * 拿不到百分比（无套餐/未知套餐/扣款失败）时退回只显示余额。
 * MiMo 用法：额度以 Credits 计（非货币）→ 传 creditsText 覆盖右侧余额文案；hint 覆盖口径提示。
 */
function MonthlyCard({
  credits,
  window: win,
  resetAtTs,
  currency,
  creditsText,
  hint,
  title = '月度额度'
}: {
  credits?: number
  window?: UsageWindowInfo
  /** 账单周期结束时间（epoch 秒）——额度重置时刻 */
  resetAtTs?: number
  currency: 'USD' | 'CNY'
  /** 右侧额度文案（如「剩余 3.21 亿 Credits」）；给出时替代货币余额显示 */
  creditsText?: string
  /** 口径提示（title）；缺省用 Command Code 的官方口径说明 */
  hint?: string
  /** 卡片标题；缺省「月度额度」（Command Code 口径） */
  title?: string
}) {
  const used = win?.usedPercent
  const moneyText = credits !== undefined ? formatCost(credits, currency) : undefined
  // 进度行：货币口径带「余额」前缀（Command Code 原样式）；MiMo 的 creditsText 原样展示
  const rightText = creditsText ?? (moneyText !== undefined ? `余额 ${moneyText}` : undefined)
  const fallbackText = creditsText ?? moneyText ?? '暂无数据'
  return (
    <div
      className="rounded-lg border border-border bg-card px-4 py-3"
      title={hint ?? '已用% = 1 − 余额 ÷ 套餐月度额度（与官网口径一致）；额度在账单周期结束时重置'}
    >
      <div className="text-xs text-muted-foreground mb-2">{title}</div>
      {used !== undefined && rightText !== undefined ? (
        <>
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="text-lg font-semibold tabular-nums text-foreground">{used.toFixed(2)}% 已用</span>
            <span className="text-xs text-muted-foreground">{rightText}</span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div className={`h-full rounded-full ${barColor(used)}`} style={{ width: `${Math.min(100, used)}%` }} />
          </div>
          {resetAtTs !== undefined && (
            <div className="mt-1.5 text-xs text-muted-foreground">{fmtMonthDayUtc(resetAtTs)}重置</div>
          )}
        </>
      ) : (
        <div className="text-lg font-semibold tabular-nums text-foreground">{fallbackText}</div>
      )}
    </div>
  )
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3" title={hint}>
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className="text-lg font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  )
}

// ─── Command Code 订阅套餐展示辅助 ───

/** 套餐 ID → 展示名（与 Studio 套餐层级一致；未知 ID 原样显示） */
const CC_PLAN_NAMES: Record<string, string> = {
  'individual-go': 'Go',
  'individual-goat': 'GOAT',
  'individual-pro': 'Pro',
  'individual-pro-v1': 'Pro',
  'individual-provider': 'Provider',
  'individual-max': 'Max 10×',
  'individual-ultra': 'Max 20×',
  'teams-pro': 'Teams Pro'
}

/** 订阅状态 → 展示文案（未知状态原样显示） */
const CC_STATUS_LABELS: Record<string, string> = {
  active: '使用中',
  trialing: '试用中',
  past_due: '逾期未付',
  canceled: '已取消',
  inactive: '未激活'
}

/** epoch 秒 → 日期文案（UTC 口径，与 Studio 显示一致，避免时区导致差一天） */
function fmtDateUtc(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString('zh-CN', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
}

/** epoch 秒 → 「9月26日」短日期（UTC 口径，与 Studio 月度额度 resets 日期一致） */
function fmtMonthDayUtc(sec: number): string {
  const d = new Date(sec * 1000)
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`
}

/** 订阅套餐区：套餐名 / 「状态与到期时间」合并卡（含剩余天数与排定取消提示） */
function SubscriptionSection({ subscription, available }: { subscription?: CommandCodeSubscription; available: boolean }) {
  if (!available && !subscription) {
    return (
      <div className="rounded-lg border border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
        暂无数据
      </div>
    )
  }
  if (!subscription) {
    return (
      <div className="rounded-lg border border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
        当前账号未订阅套餐（免费账号或订阅已结束）
      </div>
    )
  }

  const planName = subscription.planId ? CC_PLAN_NAMES[subscription.planId] ?? subscription.planId : '—'
  const statusLabel = subscription.status ? CC_STATUS_LABELS[subscription.status] ?? subscription.status : '—'
  const statusTone =
    subscription.status === 'active' || subscription.status === 'trialing'
      ? 'text-green-600'
      : subscription.status === 'past_due'
        ? 'text-destructive'
        : 'text-muted-foreground'

  // 到期/续费状态行（优先级：已取消 > 已过期 > 排定取消 > 扣款失败 > 续费开启 > 信息不明）
  const endTs = subscription.currentPeriodEndTs
  const endLabel = endTs !== undefined ? fmtDateUtc(endTs) : null
  const remainDays = endTs !== undefined ? Math.ceil((endTs * 1000 - Date.now()) / 86_400_000) : undefined
  const remainText = remainDays !== undefined && remainDays >= 0 ? `剩余 ${remainDays} 天` : null
  const dueSoon = remainDays !== undefined && remainDays >= 0 && remainDays <= 7
  const endedOrCanceledTs = subscription.endedAtTs ?? subscription.canceledAtTs
  const isCanceled = subscription.status === 'canceled' || endedOrCanceledTs !== undefined
  let endNote: string | null = null
  let endTone = 'text-muted-foreground'
  if (isCanceled) {
    endNote = endedOrCanceledTs !== undefined ? `已于 ${fmtDateUtc(endedOrCanceledTs)} 结束` : '订阅已取消'
  } else if (remainDays !== undefined && remainDays < 0) {
    endNote = '已过期'
    endTone = 'text-destructive'
  } else if (subscription.cancelScheduled === true) {
    endNote = '已排定取消，到期后终止服务'
    endTone = 'text-yellow-600'
  } else if (subscription.status === 'past_due') {
    endNote = '自动续费扣款失败，建议到 Studio 更新支付方式'
    endTone = 'text-destructive'
  } else if (subscription.cancelScheduled === false) {
    endNote = remainText ? `自动续费开启 · ${remainText}` : '自动续费开启'
    if (dueSoon) endTone = 'text-yellow-600'
  } else {
    // 续费状态字段缺失：仅显示剩余天数，不做推断
    endNote = remainText
    if (dueSoon) endTone = 'text-destructive'
  }

  const phaseNote = subscription.pendingPhase
    ? subscription.pendingPhase.effectiveDateTs !== undefined
      ? `套餐将于 ${fmtDateUtc(subscription.pendingPhase.effectiveDateTs)} 变更`
      : '套餐变更已排定'
    : null

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <div className="rounded-lg border border-border bg-card px-4 py-3">
        <div className="text-xs text-muted-foreground mb-1">当前套餐</div>
        <div className="text-lg font-semibold text-foreground">{planName}</div>
        {subscription.planId && <div className="text-xs text-muted-foreground mt-0.5">{subscription.planId}</div>}
      </div>
      {/* 状态 + 到期时间合并卡：状态为主、到期日期右对齐；下方依次为套餐变更与续费状态行 */}
      <div className="rounded-lg border border-border bg-card px-4 py-3">
        <div className="text-xs text-muted-foreground mb-1">订阅状态与到期</div>
        <div className="flex items-baseline justify-between gap-3">
          <span className={`text-lg font-semibold ${statusTone}`}>{statusLabel}</span>
          {endLabel && (
            <span className="text-sm tabular-nums text-foreground whitespace-nowrap">
              <span className="text-xs text-muted-foreground">到期 </span>
              {endLabel}
            </span>
          )}
        </div>
        {phaseNote && <div className="text-xs text-muted-foreground mt-0.5">{phaseNote}</div>}
        {endNote && <div className={`text-xs mt-0.5 ${endTone}`}>{endNote}</div>}
      </div>
    </div>
  )
}

// ─── 统一自动刷新控制（套餐用量页面刷新 + 明细后台采集共用同一间隔） ───

/** 可选间隔（分钟）；关闭由复选框表示（值 0） */
const AUTO_REFRESH_OPTIONS = [5, 10, 15, 30, 60]

/**
 * 统一自动刷新间隔（分钟），0 = 关闭。
 * 面板打开期间按它刷新页面数据，应用后台按它采集 Command Code 明细（合并前的两个独立间隔共用此值）。
 */
function useAutoRefreshMinutes(): number {
  const settings = useSettingsStore((s) => s.settings)
  const n = Math.floor(Number(settings.monitoring?.autoRefreshMinutes ?? 10))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 写统一自动刷新间隔（0 = 关闭；持久化到 monitoring，全监控源共用） */
async function setAutoRefreshMinutes(minutes: number): Promise<void> {
  const store = useSettingsStore.getState()
  const base = store.settings.monitoring ?? { sources: [], autoRefreshMinutes: 10 }
  await store.updateSetting('monitoring', { ...base, autoRefreshMinutes: Math.max(0, Math.floor(minutes)) })
}

/** 面板工具栏控件：[✓] 自动刷新 [N 分钟 ▾]（勾选与间隔写的是同一个持久化设置） */
function AutoRefreshControl() {
  const minutes = useAutoRefreshMinutes()
  // 取消勾选后再勾选时恢复上次选的间隔（默认 10），暂停期间不清零
  const lastMinutesRef = useRef(minutes > 0 ? minutes : 10)
  useEffect(() => {
    if (minutes > 0) lastMinutesRef.current = minutes
  }, [minutes])
  const shown = minutes > 0 ? minutes : lastMinutesRef.current
  // 非常规值（手改配置/迁移而来）也要能显示
  const options = AUTO_REFRESH_OPTIONS.includes(shown)
    ? AUTO_REFRESH_OPTIONS
    : [...AUTO_REFRESH_OPTIONS, shown].sort((a, b) => a - b)
  return (
    <label
      className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none"
      title="统一控制页面自动刷新与 Command Code 后台明细采集（关闭 = 仅手动刷新）"
    >
      <input
        type="checkbox"
        checked={minutes > 0}
        onChange={(e) => void setAutoRefreshMinutes(e.target.checked ? lastMinutesRef.current : 0)}
        className="accent-primary"
      />
      自动刷新
      <select
        value={shown}
        disabled={minutes <= 0}
        onChange={(e) => void setAutoRefreshMinutes(Number(e.target.value))}
        className="rounded border border-input bg-background px-1 py-0.5 text-xs text-foreground disabled:opacity-50"
      >
        {options.map((m) => (
          <option key={m} value={m}>
            {m} 分钟
          </option>
        ))}
      </select>
    </label>
  )
}

// ─── 窗口到点补拉（Command Code / MiMo 共用） ───

/**
 * 5h/7d 越过重置时刻后，页面上的数值仍是重置前拉的旧窗口 → 立即补拉一次
 *（否则最长要等一个轮询间隔才翻新，倒计时则会一直停在"即将重置"）。
 * 每个 resetAt 最多尝试 3 次、两次补拉至少间隔 30s：防止服务端持续返回旧窗口时无休止轮询。
 * usage 走对象身份依赖（刷新成功才换新对象），窗口数组不进依赖——避免每次渲染重置定时器。
 */
function useWindowResetRefresh(opts: {
  /** 自动刷新开启且已登录（关闭时不补拉） */
  active: boolean
  refreshMinutes: number
  usage: {
    windows?: {
      fiveHour?: UsageWindowInfo
      weekly?: UsageWindowInfo
      /** 月度/套餐周期额度（MiMo 的 resetAt = 套餐周期结束时刻） */
      monthly?: UsageWindowInfo
    }
  } | null
  lastFetchedAt: number | null
  refreshRef: React.MutableRefObject<() => Promise<void>>
}): void {
  const { active, refreshMinutes, usage, lastFetchedAt, refreshRef } = opts
  const resetRefreshTriesRef = useRef<Map<number, number>>(new Map())
  const lastResetRefreshAtRef = useRef(0)
  useEffect(() => {
    const timer = setInterval(() => {
      if (!active || lastFetchedAt == null) return
      if (resetRefreshTriesRef.current.size > 100) resetRefreshTriesRef.current.clear()
      const pending = expiredWindows(
        [usage?.windows?.fiveHour, usage?.windows?.weekly, usage?.windows?.monthly],
        Date.now(),
        lastFetchedAt
      ).filter(
        (w): w is UsageWindowInfo & { resetAt: number } =>
          w.resetAt !== undefined && (resetRefreshTriesRef.current.get(w.resetAt) ?? 0) < 3
      )
      if (pending.length === 0) return
      const now = Date.now()
      if (now - lastResetRefreshAtRef.current < 30_000) return
      lastResetRefreshAtRef.current = now
      for (const w of pending) {
        resetRefreshTriesRef.current.set(w.resetAt, (resetRefreshTriesRef.current.get(w.resetAt) ?? 0) + 1)
      }
      refreshRef.current()
    }, 5_000)
    return () => clearInterval(timer)
    // refreshMinutes 仅决定提示语义，不参与触发条件（active 已含「>0」判定）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, usage, lastFetchedAt, refreshRef, refreshMinutes])
}

// ─── 面板：Command Code 云端用量 ───

function CommandCodePanel({ source, account }: { source: RemoteUsageSource; account: MonitorAccount }) {
  const settings = useSettingsStore((s) => s.settings)
  const currency = settings.currency
  // 凭据 / 快照 / 本地累计 / IPC 一律按**账号**键控（默认账号 id = 源 id，历史数据零迁移）
  const accountId = account.id

  const [status, setStatus] = useState<MonitorStatus | null>(
    () => getCloudSnapshot(accountId)?.status ?? null
  )
  const [usage, setUsage] = useState<CommandCodeUsage | null>(
    () => (getCloudSnapshot(accountId)?.usage as CommandCodeUsage | undefined) ?? null
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<MonitorErrorCode | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  const [showApiKeyInput, setShowApiKeyInput] = useState(false)
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  // 本地累计（云端列表对部分套餐只给最近 100 条，累计口径让数字只增不减）
  const [cumulative, setCumulative] = useState<CumulativeModelUsage | null>(
    () => getCloudSnapshot(accountId)?.cumulative ?? null
  )
  const [collector, setCollector] = useState<CollectorStatusInfo | null>(
    () => getCloudSnapshot(accountId)?.collector ?? null
  )
  const [detailMode, setDetailMode] = useState<'monthly' | 'cumulative'>(
    () => getCloudSnapshot(accountId)?.detailMode ?? 'monthly'
  )
  // 上次刷新时间 = 快照的 fetchedAt（与 usage 同源，重进页面随快照一起恢复）
  const lastFetchedAt = usage?.fetchedAt ?? null
  // 快照恢复是否已完成（会话内模块缓存 / 主进程持久化快照）：TTL 判定须等它完成，避免快照未到先误拉
  const [snapshotReady, setSnapshotReady] = useState(() => getCloudSnapshot(accountId)?.usage != null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // 始终指向最新的 refresh，避免定时器闭包持旧函数（拿到过期的 loading/status）
  const refreshRef = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    refreshRef.current = refresh
  })

  const loggedIn = status?.loggedIn ?? false
  // 登录态是否已知：读取中（本地 IPC，瞬时）时按中性渲染，避免先闪「登录」按钮再切「退出登录」
  const statusKnown = status != null
  // 统一自动刷新间隔（分钟；0 = 关闭）：页面刷新与 Command Code 后台明细采集共用
  const refreshMinutes = useAutoRefreshMinutes()

  // ── 数据加载 ──
  const loadStatus = async () => {
    if (!source) return
    try {
      const res = await window.moaAPI.getMonitorStatus(accountId)
      if (res.success && res.data) setStatus(res.data)
    } catch {
      // 状态读取失败不阻塞页面
    }
  }

  // 登录态变化即写回快照：切视图重进时首帧直接渲染正确外观（避免先闪「登录」按钮再切「退出登录」）
  useEffect(() => {
    if (accountId && status) patchCloudSnapshot(accountId, { status })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, status])

  const refresh = async () => {
    if (!source || loading) return
    setLoading(true)
    setError(null)
    setErrorCode(null)
    try {
      const res = await window.moaAPI.monitorRefresh(accountId)
      if (res.success && res.data) {
        setUsage(res.data as CommandCodeUsage)
        // 写回快照：视图切走组件卸载后，重进直接恢复
        patchCloudSnapshot(accountId, { usage: res.data })
      } else {
        const code = res.code ?? 'unknown'
        setErrorCode(code)
        if (code === 'not_authenticated') {
          setStatus((s) => (s ? { ...s, loggedIn: false } : s))
          setError('登录状态已失效，请重新登录')
        } else if (code === 'session_expired') {
          setError('登录已过期，请重新登录')
        } else {
          setError(res.error || '拉取用量数据失败')
          if (code === 'network') {
            setError('拉取用量数据失败（网络不通）。若处于受限网络，请在「设置 → 网络代理」中开启代理后重试')
          }
        }
      }
    } catch (err) {
      setErrorCode('network')
      setError(err instanceof Error ? err.message : '拉取用量数据失败')
    } finally {
      setLoading(false)
    }
  }

  // 本地累计 + 采集器状态（累计口径的数据来源）
  const loadCumulative = async () => {
    if (!accountId) return
    try {
      const [cumRes, stRes] = await Promise.all([
        window.moaAPI.monitorGetCumulative(accountId),
        window.moaAPI.monitorCollectorStatus()
      ])
      if (cumRes.success && cumRes.data) {
        setCumulative(cumRes.data)
        patchCloudSnapshot(accountId, { cumulative: cumRes.data })
      }
      if (stRes.success && stRes.data) {
        setCollector(stRes.data)
        patchCloudSnapshot(accountId, { collector: stRes.data })
      }
    } catch {
      // 累计读取失败不阻塞页面（首次为空属正常）
    }
  }

  // 从主进程读取上次会话（应用重启前）持久化的用量快照；本次会话模块缓存已有则跳过
  const hydrateUsage = async () => {
    if (!accountId) return
    if (getCloudSnapshot(accountId)?.usage != null) return
    try {
      const res = await window.moaAPI.monitorGetSnapshot(accountId)
      if (res.success && res.data) {
        setUsage(res.data as CommandCodeUsage)
        patchCloudSnapshot(accountId, { usage: res.data })
      }
    } catch {
      // 快照读取失败不阻塞页面（按无快照处理）
    } finally {
      setSnapshotReady(true)
    }
  }

  // 挂载：读取状态 + 本地累计；用量本体从快照恢复（会话内模块缓存 / 主进程持久化快照，见 hydrateUsage）
  useEffect(() => {
    if (!accountId) return
    loadStatus()
    void loadCumulative()
    void hydrateUsage()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId])

  // 每次刷新成功后同步累计数据（lastFetchedAt 变化 = 刷新完成）
  useEffect(() => {
    if (lastFetchedAt) void loadCumulative()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastFetchedAt])

  // 页面打开期间轮询本地累计：后台采集写入的新记录自动出现，否则数字看着像"不动"
  useEffect(() => {
    if (!accountId) return
    const timer = setInterval(() => {
      void loadCumulative()
    }, 60_000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId])

  // 登录态与快照恢复都就绪后：无快照或快照已过期（超过统一自动刷新间隔）才打远端；新鲜则直接用快照展示
  useEffect(() => {
    if (accountId && snapshotReady && status?.loggedIn && shouldFetchOnMount(usage, refreshMinutes)) {
      refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.loggedIn, snapshotReady])

  // 明细口径选择写回快照：切视图往返后保持用户选择
  useEffect(() => {
    if (accountId) patchCloudSnapshot(accountId, { detailMode })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, detailMode])

  // 自动刷新定时器（统一间隔；经 refreshRef 调用最新 refresh）
  useEffect(() => {
    if (refreshMinutes <= 0 || !loggedIn || !accountId) return
    timerRef.current = setInterval(() => {
      refreshRef.current()
    }, refreshMinutes * 60_000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [refreshMinutes, loggedIn, accountId])

  // 窗口到点补拉：5h/7d 重置后立即刷新（共用 hook，见 useWindowResetRefresh）
  useWindowResetRefresh({
    active: refreshMinutes > 0 && loggedIn,
    refreshMinutes,
    usage,
    lastFetchedAt,
    refreshRef
  })

  // ── 动作 ──
  const handleLogin = async () => {
    if (!source) return
    setLoggingIn(true)
    try {
      const res = await window.moaAPI.monitorLogin(accountId)
      const inner = res.data
      if (res.success && inner?.success) {
        setError(null)
        setErrorCode(null)
        await loadStatus()
        refresh()
      }
      // cancelled → 用户关闭登录窗，静默
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setLoggingIn(false)
    }
  }

  const handleLogout = async () => {
    if (!accountId) return
    // 快照随登出清空：换账号后不得残留旧账号数据
    clearCloudSnapshot(accountId)
    try {
      await window.moaAPI.monitorLogout(accountId)
    } catch {
      // 登出尽力而为：本地登录态立即复位，失败无需打扰用户
    }
    setStatus({ loggedIn: false, hasApiKey: false })
    setUsage(null)
    setError(null)
    setErrorCode(null)
  }

  const handleSaveApiKey = async () => {
    if (!accountId || !apiKeyDraft.trim()) return
    try {
      await window.moaAPI.monitorSetApiKey(accountId, apiKeyDraft.trim())
      setApiKeyDraft('')
      setShowApiKeyInput(false)
      setStatus((s) => (s ? { ...s, hasApiKey: true } : s))
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存 API Key 失败')
    }
  }

  // ── 渲染 ──
  const windowsAvailable = usage?.sourcesAvailable.windows ?? false
  const summary = usage?.summary
  const credits = usage?.credits
  // 明细口径：服务端聚合（charts 端点，默认）/ 本地累计（本地观测累积）
  // 注意：/internal/usage 的逐条记录不再单独作为展示口径（与本地累计同源、覆盖更短），仅用于本地累计落库
  const monthlyRows = usage?.monthlyModels?.rows ?? []
  const chartsFlag = usage?.sourcesAvailable.chartsEndpoint
  const monthlyAvailable = monthlyRows.length > 0 && chartsFlag !== false
  const cumulativeModels = cumulative?.models ?? []
  const effectiveDetailMode: 'monthly' | 'cumulative' =
    detailMode === 'monthly' && !monthlyAvailable ? 'cumulative' : detailMode
  const shownModels = effectiveDetailMode === 'monthly' ? monthlyRows : cumulativeModels
  const monthlyWindow = usage?.monthlyModels?.window
  // 缓存节省列：仅当当前口径的行里真有该数据（目前只有服务端聚合口径提供）
  const showCacheSavings = shownModels.some((m) => Number((m as { cacheSavings?: number }).cacheSavings) > 0)
  const monthlySpan =
    monthlyWindow?.fromTs !== undefined && monthlyWindow?.toTs !== undefined
      ? fmtSpan(monthlyWindow.fromTs * 1000, monthlyWindow.toTs * 1000)
      : null
  const cumulativeSinceLabel = cumulative?.sinceTs !== undefined ? fmtSpan(cumulative.sinceTs, cumulative.sinceTs) : null
  // 采集器是否还活着：持久化的最近采集时间超过 2×间隔（且至少 10 分钟）即视为可能停止；
  // 自动刷新关闭时不判断（不采集是预期行为，避免误报「采集已停止」）
  const collectorState = cumulative?.collectorState
  const staleThresholdMs = Math.max(2 * (collector?.intervalMinutes ?? refreshMinutes) * 60_000, 10 * 60_000)
  const collectorStale =
    refreshMinutes > 0 &&
    collectorState?.lastRunAt !== undefined &&
    collectorState.lastRunAt > 0 &&
    Date.now() - collectorState.lastRunAt > staleThresholdMs
  // 汇总口径（服务端 periodBasis）：'billing-period' = 当前计费月、'last-30-days' = 最近 30 天
  const summaryBasisLabel =
    summary?.periodBasis === 'billing-period'
      ? '当前计费月'
      : summary?.periodBasis === 'last-30-days'
        ? '最近 30 天'
        : (summary?.periodBasis ?? '服务端口径')

  return (
    <div className="flex flex-col gap-4">
      {/* 顶部：源信息 + 操作 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-foreground flex items-center gap-2">
            {source.name}
            <span
              className={`inline-block w-2 h-2 rounded-full ${loggedIn ? 'bg-green-500' : 'bg-muted'}`}
              title={loggedIn ? '已登录' : '未登录'}
            />
          </h2>
          <a
            href={source.studioUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              // Electron 内新开外链：直接交给系统浏览器（渲染进程本身无法开窗）
              e.preventDefault()
              window.open(source.studioUrl, '_blank', 'noopener')
            }}
            className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:text-foreground mt-0.5"
          >
            {source.studioUrl} <ExternalLink className="w-3 h-3" />
          </a>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {lastFetchedAt && (
            <span className="text-xs text-muted-foreground">上次刷新 {fmtTime(lastFetchedAt)}</span>
          )}
          <AutoRefreshControl />
          <button
            onClick={refresh}
            disabled={loading || !loggedIn}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border bg-card text-foreground hover:bg-accent disabled:opacity-50 transition-colors"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            刷新
          </button>
          {!statusKnown ? (
            // 登录态读取中（本地 IPC，瞬时）：渲染不可见占位保持布局，避免先闪出黑底的「登录」按钮
            <button
              disabled
              aria-hidden="true"
              className="invisible flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border text-muted-foreground"
            >
              <LogOut className="w-3.5 h-3.5" /> 退出登录
            </button>
          ) : loggedIn ? (
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" /> 退出登录
            </button>
          ) : (
            <button
              onClick={handleLogin}
              disabled={loggingIn}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {loggingIn && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              登录 Command Code
            </button>
          )}
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive flex items-center justify-between gap-3">
          <span>{error}</span>
          {(errorCode === 'session_expired' || errorCode === 'not_authenticated') && (
            <button onClick={handleLogin} className="underline whitespace-nowrap">
              重新登录
            </button>
          )}
          {errorCode === 'network' && (
            <button onClick={refresh} className="underline whitespace-nowrap">
              重试
            </button>
          )}
        </div>
      )}

      {/* 未登录空态：仅在登录态已知且未登录时显示（未知时不闪大卡片） */}
      {statusKnown && !loggedIn && (
        <div className="rounded-lg border border-border bg-card px-6 py-14 flex flex-col items-center gap-3">
          <p className="text-sm text-muted-foreground">
            尚未登录 Command Code 云端。登录后将展示 5小时/7天额度、月度余额、用量汇总与模型明细。
          </p>
          <button
            onClick={handleLogin}
            disabled={loggingIn}
            className="flex items-center gap-2 px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {loggingIn && <Loader2 className="w-4 h-4 animate-spin" />}
            登录
          </button>
        </div>
      )}

      {/* 已登录：数据区 */}
      {loggedIn && loading && !usage && (
        <div className="flex-1 flex items-center justify-center py-20 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin mr-2" /> 正在拉取用量数据…
        </div>
      )}

      {loggedIn && usage && (
        <>
          {/* 订阅套餐（含到期时间） */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground mb-2">订阅套餐</h3>
            <SubscriptionSection subscription={usage.subscription} available={usage.sourcesAvailable.subscription} />
          </section>

          {/* 额度区：5h / 7d / 月度余额 */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground mb-2">额度</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <WindowCard
                title="5小时窗口"
                info={usage.windows?.fiveHour}
                disabled={!windowsAvailable}
                fetchedAt={lastFetchedAt ?? undefined}
                autoRefreshOn={refreshMinutes > 0}
              />
              <WindowCard
                title="7天窗口"
                info={usage.windows?.weekly}
                disabled={!windowsAvailable}
                fetchedAt={lastFetchedAt ?? undefined}
                autoRefreshOn={refreshMinutes > 0}
              />
              <MonthlyCard
                credits={credits?.monthlyCredits}
                window={usage.windows?.monthly}
                resetAtTs={usage.subscription?.currentPeriodEndTs}
                currency={currency}
              />
            </div>

            {/* API Key 提示条：拿不到窗口数据时引导配置 */}
            {!windowsAvailable && (
              <div className="mt-2 rounded-lg border border-border bg-card px-4 py-2.5 flex flex-wrap items-center gap-2 text-sm">
                <KeyRound className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <span className="text-xs text-muted-foreground flex-1 min-w-40">
                  5小时/7天窗口额度需要配置 Provider API Key（在 Studio → API Keys 生成），不配置不影响其余数据。
                </span>
                {status?.hasApiKey && !showApiKeyInput ? (
                  <span className="text-xs text-green-600">已配置 API Key</span>
                ) : null}
                {showApiKeyInput ? (
                  <span className="flex items-center gap-1.5 flex-wrap">
                    <input
                      value={apiKeyDraft}
                      onChange={(e) => setApiKeyDraft(e.target.value)}
                      placeholder="sk-..."
                      className="w-56 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <button
                      onClick={handleSaveApiKey}
                      disabled={!apiKeyDraft.trim()}
                      className="px-2.5 py-1 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    >
                      保存
                    </button>
                    <button
                      onClick={() => {
                        setShowApiKeyInput(false)
                        setApiKeyDraft('')
                      }}
                      className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      取消
                    </button>
                  </span>
                ) : (
                  <button onClick={() => setShowApiKeyInput(true)} className="px-2.5 py-1 text-xs rounded-md border border-border hover:bg-accent transition-colors">
                    {status?.hasApiKey ? '更新' : '配置'}
                  </button>
                )}
              </div>
            )}
          </section>

          {/* 汇总卡片：服务端 summary 口径（计费月 / 最近 30 天），与模型明细口径不同 */}
          <section>
            <div className="flex flex-wrap items-baseline gap-x-2 mb-2">
              <h3 className="text-xs font-semibold text-muted-foreground">汇总</h3>
              <span
                className="text-xs text-muted-foreground"
                title="来自服务端 summary 接口，统计口径由服务端给出（periodBasis）；「模型明细」是服务端 charts 聚合或本地累计，覆盖范围与汇总不同，两者数字不应相等"
              >
                {summaryBasisLabel} · 与模型明细口径不同
              </span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard label="总请求数" value={summary ? fmtNum(summary.totalCount) : '—'} />
              <StatCard label="总成本" value={summary ? formatCost(summary.totalCost, currency) : '—'} />
              <StatCard label="总 Tokens" value={summary ? fmtNum(summary.totalTokens) : '—'} />
              <StatCard label="成功率" value={summary ? `${summary.successRate > 1 ? summary.successRate : summary.successRate * 100}%` : '—'} />
            </div>
          </section>

          {/* 模型明细：服务端聚合口径（charts，默认）/ 本地累计 */}
          <section>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-2">
              <h3 className="text-xs font-semibold text-muted-foreground">模型明细</h3>
              <div className="flex items-center gap-1">
                {(
                  [
                    [
                      'monthly',
                      '服务端聚合',
                      '服务端预聚合（模型 × 时间桶），覆盖服务端固定返回的最近约 28 个桶；数据源 /internal/usage/charts'
                    ],
                    [
                      'cumulative',
                      '本地累计',
                      '本地按记录 id 去重累积（自首次采集起，只增不减）；两次采集之间的突发可能漏采'
                    ]
                  ] as const
                ).map(([mode, label, hint]) => {
                  const disabled = mode === 'monthly' && !monthlyAvailable
                  return (
                    <button
                      key={mode}
                      onClick={() => setDetailMode(mode)}
                      disabled={disabled}
                      title={disabled ? '该账号的 charts 端点未返回数据，服务端聚合口径不可用' : hint}
                      className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                        effectiveDetailMode === mode
                          ? 'border-primary/50 bg-primary/10 text-foreground'
                          : 'border-border text-muted-foreground hover:bg-accent'
                      } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* 口径说明行 */}
            {effectiveDetailMode === 'monthly' ? (
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 mb-2 text-xs text-muted-foreground">
                <span>服务端按「模型 × 时间桶」聚合</span>
                {usage?.monthlyModels && <span>· {usage.monthlyModels.buckets} 个时间桶</span>}
                {monthlySpan && <span>· 覆盖 {monthlySpan}</span>}
                <span className="text-yellow-600/90" title="实测：from / periodBasis 等查询参数被服务端忽略，固定返回最近约 28 个时间桶（约 5 分钟/桶），覆盖范围短于整月，故与「汇总」卡片不会相等">
                  · 范围由服务端固定（短于整月）
                </span>
                <span
                  className="cursor-help"
                  title="来自 /internal/usage/charts（服务端预聚合，字段含缓存成本/节省、按月额度消耗拆分）"
                >
                  · 口径说明
                </span>
              </div>
            ) : (
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 mb-2 text-xs text-muted-foreground">
                {cumulative && cumulative.records > 0 ? (
                  <>
                    <span>本地累计 {cumulative.records.toLocaleString()} 条记录</span>
                    {cumulativeSinceLabel && <span>· 自 {cumulativeSinceLabel} 起</span>}
                    {cumulative.toTs !== undefined && <span>· 最近记录 {fmtSpan(cumulative.toTs, cumulative.toTs)}</span>}
                    {collectorState && collectorState.lastRunAt !== undefined && (
                      <span className={collectorStale ? 'text-yellow-600' : undefined}>
                        · 最近采集 {fmtTime(collectorState.lastRunAt)}（已 {collectorState.runs} 轮
                        {collectorState.runs > collectorState.okRuns ? ` · 失败 ${collectorState.runs - collectorState.okRuns}` : ''}）
                      </span>
                    )}
                    {collectorStale && <span className="text-yellow-600">· 采集可能已停止</span>}
                    {collectorState === undefined && cumulative.lastCollectedAt !== undefined && (
                      <span>· 最近采集 {fmtTime(cumulative.lastCollectedAt)}</span>
                    )}
                    {collector && !collector.enabled && (
                      <span className="text-yellow-600">· 自动刷新已关闭（仅手动刷新时累积）</span>
                    )}
                    {collector?.enabled && collector.intervalMinutes > 0 && (
                      <span>· 每 {collector.intervalMinutes} 分钟自动采集</span>
                    )}
                    {collector?.lastError && <span className="text-yellow-600">· 最近一次采集失败（{collector.lastError}）</span>}
                    <span
                      className="cursor-help"
                      title="本地累计由每次采集到的服务端记录按 id 去重累加；两次采集之间的突发（>100 条）或界面未运行时的用量会漏采，故仅代表“已观测到的用量”"
                    >
                      · 口径说明
                    </span>
                  </>
                ) : (
                  <span>暂无本地累计数据（自动刷新或手动刷新后会逐条累积）</span>
                )}
              </div>
            )}
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border">
                    <th className="text-left px-4 py-2 font-medium">模型</th>
                    <th className="text-right px-4 py-2 font-medium">请求数</th>
                    <th className="text-right px-4 py-2 font-medium">↑ 输入</th>
                    <th className="text-right px-4 py-2 font-medium">↓ 输出</th>
                    <th className="text-right px-4 py-2 font-medium">总 Tokens</th>
                    {showCacheSavings && (
                      <th
                        className="text-right px-4 py-2 font-medium"
                        title="缓存命中省下的费用（服务端聚合口径提供；= 未命中时的名义成本 − 实际成本）"
                      >
                        缓存节省
                      </th>
                    )}
                    <th className="text-right px-4 py-2 font-medium">成本</th>
                  </tr>
                </thead>
                <tbody>
                  {shownModels.length === 0 ? (
                    <tr>
                      <td colSpan={showCacheSavings ? 7 : 6} className="px-4 py-12 text-center text-sm text-muted-foreground">
                        {effectiveDetailMode === 'monthly'
                          ? '暂无服务端聚合数据（charts 端点未返回数据）'
                          : '暂无本地累计数据（自动刷新或手动刷新后会逐条累积）'}
                      </td>
                    </tr>
                  ) : (
                    shownModels.map((m) => (
                      <tr key={m.model} className="border-b border-border/50 last:border-b-0 hover:bg-accent/30">
                        <td className="px-4 py-2 text-foreground">{m.model}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtNum(m.requests)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtNum(m.tokensIn)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtNum(m.tokensOut)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtNum(m.tokensTotal)}</td>
                        {showCacheSavings && (
                          <td className="px-4 py-2 text-right tabular-nums text-green-600">
                            {(() => {
                              const v = Number((m as { cacheSavings?: number }).cacheSavings)
                              return v > 0 ? formatCost(v, currency) : '—'
                            })()}
                          </td>
                        )}
                        <td className="px-4 py-2 text-right tabular-nums">{formatCost(m.cost, currency)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

// ─── 面板：Xiaomi MiMo 云端用量 ───

const MIMO_PLAN_LABELS: Record<string, string> = {
  plan_total_token: '套餐积分',
  compensation_total_token: '补偿积分'
}

/** Credit 原值（1e8 = 1 亿）转「亿 Credits」展示 */
function fmtYi(v: number): string {
  return `${(v / 1e8).toFixed(2)} 亿`
}

// ─── MiMo 订阅套餐展示辅助（监控项目与 Command Code 订阅区对齐） ───

/** 套餐代码 → 展示名（与控制台 planNames 一致；未知代码原样显示） */
const MIMO_SUB_PLAN_NAMES: Record<string, string> = {
  lite: 'Lite 月度套餐',
  standard: 'Standard 月度套餐',
  pro: 'Pro 月度套餐',
  max: 'Max 月度套餐',
  lite_year: 'Lite 年度套餐',
  standard_year: 'Standard 年度套餐',
  pro_year: 'Pro 年度套餐',
  max_year: 'Max 年度套餐'
}

/** 订阅状态 → 展示文案（服务端值形态未公开：已知映射，未知原样显示） */
const MIMO_SUB_STATUS_LABELS: Record<string, string> = {
  ACTIVE: '使用中',
  active: '使用中',
  VALID: '有效',
  valid: '有效',
  TRIAL: '试用中',
  TRIALING: '试用中',
  EXPIRED: '已过期',
  expired: '已过期',
  CANCELED: '已取消',
  CANCELLED: '已取消',
  canceled: '已取消',
  INACTIVE: '未激活',
  inactive: '未激活'
}

/** 订阅状态 → 文案色调（绿色=生效中 / 红=失效类 / 灰=其余，按包含匹配容错大小写与变体） */
function mimoStatusTone(status?: string): string {
  if (!status) return 'text-muted-foreground'
  const s = status.toUpperCase()
  if (['ACTIVE', 'VALID', 'IN_EFFECT', 'NORMAL', 'RENEW', 'TRIAL'].some((k) => s.includes(k))) return 'text-green-600'
  if (['EXPIRED', 'CANCEL', 'INACTIVE', 'FROZEN', 'SUSPEND', 'CLOSED', 'FAILED'].some((k) => s.includes(k)))
    return 'text-destructive'
  return 'text-muted-foreground'
}

/** 订阅套餐区：套餐名 / 「状态与到期」合并卡（与 Command Code 订阅区同布局） */
function MimoSubscriptionSection({
  subscription,
  available,
  className
}: {
  subscription?: MimoSubscription
  available: boolean
  /** 外层定位类（如 md:col-span-2，与套餐额度卡同网格一行） */
  className?: string
}) {
  if (!available && !subscription) {
    return (
      <div
        className={`rounded-lg border border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground ${className ?? ''}`}
      >
        暂无数据
      </div>
    )
  }
  if (!subscription) {
    return (
      <div
        className={`rounded-lg border border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground ${className ?? ''}`}
      >
        当前账号未查询到订阅信息（可能未订阅套餐）
      </div>
    )
  }

  const planName = subscription.planName
    ? subscription.planName
    : subscription.planId
      ? (MIMO_SUB_PLAN_NAMES[subscription.planId.replace(':', '_')] ?? subscription.planId)
      : '—'
  // 状态口径：detail.expired 布尔是权威（实测无字符串 status）；缺失时退回 status 映射
  const expired = subscription.expired
  const statusLabel =
    expired === true
      ? '已过期'
      : expired === false
        ? '生效中'
        : subscription.status
          ? (MIMO_SUB_STATUS_LABELS[subscription.status] ?? subscription.status)
          : '—'
  const statusTone =
    expired === true ? 'text-destructive' : expired === false ? 'text-green-600' : mimoStatusTone(subscription.status)
  const endTs = subscription.expireAtTs
  const endLabel = endTs !== undefined ? fmtDateUtc(endTs) : null

  return (
    <div className={`grid grid-cols-1 md:grid-cols-2 gap-3 ${className ?? ''}`}>
      <div className="rounded-lg border border-border bg-card px-4 py-3">
        <div className="text-xs text-muted-foreground mb-1">当前套餐</div>
        <div className="text-lg font-semibold text-foreground">{planName}</div>
        {subscription.planId && planName.toLowerCase() !== subscription.planId.toLowerCase() && (
          <div className="text-xs text-muted-foreground mt-0.5">{subscription.planId}</div>
        )}
      </div>
      <div className="rounded-lg border border-border bg-card px-4 py-3">
        <div className="text-xs text-muted-foreground mb-1">订阅状态与到期</div>
        <div className="flex items-baseline justify-between gap-3">
          <span className={`text-lg font-semibold ${statusTone}`}>{statusLabel}</span>
          {endLabel && (
            <span className="text-sm tabular-nums text-foreground whitespace-nowrap">
              <span className="text-xs text-muted-foreground">到期 </span>
              {endLabel}
            </span>
          )}
        </div>
        {subscription.autoRenew !== undefined && (
          <div className={`text-xs mt-0.5 ${subscription.autoRenew ? 'text-muted-foreground' : 'text-yellow-600'}`}>
            {subscription.autoRenew ? '自动续费开启' : '自动续费关闭'}
          </div>
        )}
      </div>
    </div>
  )
}

function MimoPanel({ source, account }: { source: RemoteUsageSource; account: MonitorAccount }) {
  const settings = useSettingsStore((s) => s.settings)
  const currency = settings.currency
  // 凭据 / 快照 / 本地累计 / IPC 一律按**账号**键控（默认账号 id = 源 id，历史数据零迁移）
  const accountId = account.id

  const [status, setStatus] = useState<MonitorStatus | null>(
    () => getCloudSnapshot(accountId)?.status ?? null
  )
  const [usage, setUsage] = useState<MimoUsage | null>(
    () => (getCloudSnapshot(accountId)?.usage as MimoUsage | undefined) ?? null
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<MonitorErrorCode | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  // 本地累计（云端列表是「日期×模型」聚合行，累计口径让跨月数字只增不减）
  const [cumulative, setCumulative] = useState<CumulativeModelUsage | null>(
    () => getCloudSnapshot(accountId)?.cumulative ?? null
  )
  const [collector, setCollector] = useState<CollectorStatusInfo | null>(
    () => getCloudSnapshot(accountId)?.collector ?? null
  )
  const [detailMode, setDetailMode] = useState<'monthly' | 'cumulative'>(
    () => getCloudSnapshot(accountId)?.detailMode ?? 'monthly'
  )
  // 上次刷新时间 = 快照的 fetchedAt（与 usage 同源，重进页面随快照一起恢复）
  const lastFetchedAt = usage?.fetchedAt ?? null
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // 始终指向最新的 refresh，避免定时器闭包持旧函数
  const refreshRef = useRef<() => Promise<void>>(async () => {})
  // 快照恢复是否已完成（会话内模块缓存 / 主进程持久化快照）：TTL 判定须等它完成，避免快照未到先误拉
  const [snapshotReady, setSnapshotReady] = useState(() => getCloudSnapshot(accountId)?.usage != null)
  useEffect(() => {
    refreshRef.current = refresh
  })

  const loggedIn = status?.loggedIn ?? false
  // 登录态是否已知：读取中（本地 IPC，瞬时）时按中性渲染，避免先闪「登录」按钮再切「退出登录」
  const statusKnown = status != null
  // 统一自动刷新间隔（分钟；0 = 关闭）：页面刷新与 Command Code 后台明细采集共用
  const refreshMinutes = useAutoRefreshMinutes()

  // ── 数据加载 ──
  const loadStatus = async () => {
    if (!source) return
    try {
      const res = await window.moaAPI.getMonitorStatus(accountId)
      if (res.success && res.data) setStatus(res.data)
    } catch {
      // 状态读取失败不阻塞页面
    }
  }

  // 登录态变化即写回快照：切视图重进时首帧直接渲染正确外观（避免先闪「登录」按钮再切「退出登录」）
  useEffect(() => {
    if (accountId && status) patchCloudSnapshot(accountId, { status })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, status])

  const refresh = async () => {
    if (!source || loading) return
    setLoading(true)
    setError(null)
    setErrorCode(null)
    try {
      const res = await window.moaAPI.monitorRefresh(accountId)
      if (res.success && res.data) {
        setUsage(res.data as MimoUsage)
        // 写回快照：视图切走组件卸载后，重进直接恢复
        patchCloudSnapshot(accountId, { usage: res.data })
      } else {
        const code = res.code ?? 'unknown'
        setErrorCode(code)
        if (code === 'not_authenticated') {
          setStatus((s) => (s ? { ...s, loggedIn: false } : s))
          setError('登录状态已失效，请重新登录')
        } else if (code === 'session_expired') {
          setError('登录已过期（Cookie 约 24h 有效），请重新登录')
        } else {
          setError(res.error || '拉取用量数据失败')
          if (code === 'network') {
            setError('拉取用量数据失败（网络不通）。若处于受限网络，请在「设置 → 网络代理」中开启代理后重试')
          }
        }
      }
    } catch (err) {
      setErrorCode('network')
      setError(err instanceof Error ? err.message : '拉取用量数据失败')
    } finally {
      setLoading(false)
    }
  }

  // 本地累计 + 采集器状态（累计口径的数据来源）
  const loadCumulative = async () => {
    if (!accountId) return
    try {
      const [cumRes, stRes] = await Promise.all([
        window.moaAPI.monitorGetCumulative(accountId),
        window.moaAPI.monitorCollectorStatus()
      ])
      if (cumRes.success && cumRes.data) {
        setCumulative(cumRes.data)
        patchCloudSnapshot(accountId, { cumulative: cumRes.data })
      }
      if (stRes.success && stRes.data) {
        setCollector(stRes.data)
        patchCloudSnapshot(accountId, { collector: stRes.data })
      }
    } catch {
      // 累计读取失败不阻塞页面（首次为空属正常）
    }
  }

  // 从主进程读取上次会话（应用重启前）持久化的用量快照；本次会话模块缓存已有则跳过
  const hydrateUsage = async () => {
    if (getCloudSnapshot(accountId)?.usage != null) return
    try {
      const res = await window.moaAPI.monitorGetSnapshot(accountId)
      if (res.success && res.data) {
        setUsage(res.data as MimoUsage)
        patchCloudSnapshot(accountId, { usage: res.data })
      }
    } catch {
      // 快照读取失败不阻塞页面（按无快照处理）
    } finally {
      setSnapshotReady(true)
    }
  }

  // 挂载：读取状态 + 本地累计；用量本体从快照恢复（会话内模块缓存 / 主进程持久化快照，见 hydrateUsage）
  useEffect(() => {
    loadStatus()
    void loadCumulative()
    void hydrateUsage()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId])

  // 每次刷新成功后同步累计数据（lastFetchedAt 变化 = 刷新完成）
  useEffect(() => {
    if (lastFetchedAt) void loadCumulative()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastFetchedAt])

  // 页面打开期间轮询本地累计：后台采集写入的新记录自动出现，否则数字看着像"不动"
  useEffect(() => {
    if (!accountId) return
    const timer = setInterval(() => {
      void loadCumulative()
    }, 60_000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId])

  // 明细口径选择写回快照：切视图往返后保持用户选择
  useEffect(() => {
    if (accountId) patchCloudSnapshot(accountId, { detailMode })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, detailMode])

  // 登录态与快照恢复都就绪后：无快照或快照已过期（超过统一自动刷新间隔）才打远端；新鲜则直接用快照展示。
  // 旧版快照（升级前保存，无 detailList 标记）不判新鲜，直接重拉到新结构。
  useEffect(() => {
    if (!snapshotReady || !status?.loggedIn) return
    const legacySnapshot = usage != null && usage.sourcesAvailable.detailList === undefined
    if (shouldFetchOnMount(usage, refreshMinutes) || legacySnapshot) {
      refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.loggedIn, snapshotReady])

  // 自动刷新定时器（统一间隔；经 refreshRef 调用最新 refresh）
  useEffect(() => {
    if (refreshMinutes <= 0 || !loggedIn) return
    timerRef.current = setInterval(() => {
      refreshRef.current()
    }, refreshMinutes * 60_000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [refreshMinutes, loggedIn])

  // 窗口到点补拉：5h/7d（或月度 resetAt）重置后立即刷新（共用 hook，见 useWindowResetRefresh）
  useWindowResetRefresh({
    active: refreshMinutes > 0 && loggedIn,
    refreshMinutes,
    usage,
    lastFetchedAt,
    refreshRef
  })

  // ── 动作 ──
  const handleLogin = async () => {
    setLoggingIn(true)
    try {
      const res = await window.moaAPI.monitorLogin(accountId)
      const inner = res.data
      if (res.success && inner?.success) {
        setError(null)
        setErrorCode(null)
        await loadStatus()
        refresh()
      }
      // cancelled → 用户关闭登录窗，静默
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setLoggingIn(false)
    }
  }

  const handleLogout = async () => {
    // 快照随登出清空：换账号后不得残留旧账号数据
    clearCloudSnapshot(accountId)
    try {
      await window.moaAPI.monitorLogout(accountId)
    } catch {
      // 登出尽力而为：本地登录态立即复位，失败无需打扰用户
    }
    setStatus({ loggedIn: false, hasApiKey: false })
    setUsage(null)
    setError(null)
    setErrorCode(null)
  }

  // ── 渲染 ──
  const balance = usage?.balance
  const tokenPlan = usage?.tokenPlan
  const balSym = balance?.currency === 'USD' ? '$' : '¥'
  const summary = usage?.summary
  const subscription = usage?.subscription
  const detailListAvailable = usage?.sourcesAvailable.detailList ?? false
  // 明细口径：服务端聚合（/usage/detail/list 当月行，默认）/ 本地累计（本地观测累积）
  const monthlyRows = usage?.monthlyModels?.rows ?? []
  const monthlyAvailable = monthlyRows.length > 0 && detailListAvailable
  const cumulativeModels = cumulative?.models ?? []
  const effectiveDetailMode: 'monthly' | 'cumulative' =
    detailMode === 'monthly' && !monthlyAvailable ? 'cumulative' : detailMode
  const shownModels = effectiveDetailMode === 'monthly' ? monthlyRows : cumulativeModels
  const monthlyWindow = usage?.monthlyModels?.window
  const monthlySpan =
    monthlyWindow?.fromTs !== undefined && monthlyWindow?.toTs !== undefined
      ? fmtSpan(monthlyWindow.fromTs, monthlyWindow.toTs)
      : null
  const cumulativeSinceLabel = cumulative?.sinceTs !== undefined ? fmtSpan(cumulative.sinceTs, cumulative.sinceTs) : null
  // 采集器是否还活着：持久化的最近采集时间超过 2×间隔（且至少 10 分钟）即视为可能停止；
  // 自动刷新关闭时不判断（不采集是预期行为，避免误报「采集已停止」）
  const collectorState = cumulative?.collectorState
  const staleThresholdMs = Math.max(2 * (collector?.intervalMinutes ?? refreshMinutes) * 60_000, 10 * 60_000)
  const collectorStale =
    refreshMinutes > 0 &&
    collectorState?.lastRunAt !== undefined &&
    collectorState.lastRunAt > 0 &&
    Date.now() - collectorState.lastRunAt > staleThresholdMs
  // 月度额度卡右侧文案：套餐剩余 Credits（各条目 limit−used 求和）
  const planRemainingCredits = tokenPlan
    ? tokenPlan.items.reduce((s, it) => s + Math.max(it.limit - it.used, 0), 0)
    : undefined

  return (
    <div className="flex flex-col gap-4">
      {/* 顶部：源信息 + 操作 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-foreground flex items-center gap-2">
            {source.name}
            <span
              className={`inline-block w-2 h-2 rounded-full ${loggedIn ? 'bg-green-500' : 'bg-muted'}`}
              title={loggedIn ? '已登录' : '未登录'}
            />
          </h2>
          <a
            href={source.studioUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              e.preventDefault()
              window.open(source.studioUrl, '_blank', 'noopener')
            }}
            className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:text-foreground mt-0.5"
          >
            {source.studioUrl} <ExternalLink className="w-3 h-3" />
          </a>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {lastFetchedAt && (
            <span className="text-xs text-muted-foreground">上次刷新 {fmtTime(lastFetchedAt)}</span>
          )}
          <AutoRefreshControl />
          <button
            onClick={refresh}
            disabled={loading || !loggedIn}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border bg-card text-foreground hover:bg-accent disabled:opacity-50 transition-colors"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            刷新
          </button>
          {!statusKnown ? (
            // 登录态读取中（本地 IPC，瞬时）：渲染不可见占位保持布局，避免先闪出黑底的「登录」按钮
            <button
              disabled
              aria-hidden="true"
              className="invisible flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border text-muted-foreground"
            >
              <LogOut className="w-3.5 h-3.5" /> 退出登录
            </button>
          ) : loggedIn ? (
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" /> 退出登录
            </button>
          ) : (
            <button
              onClick={handleLogin}
              disabled={loggingIn}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {loggingIn && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              登录 Xiaomi MiMo
            </button>
          )}
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive flex items-center justify-between gap-3">
          <span>{error}</span>
          {(errorCode === 'session_expired' || errorCode === 'not_authenticated') && (
            <button onClick={handleLogin} className="underline whitespace-nowrap">
              重新登录
            </button>
          )}
          {errorCode === 'network' && (
            <button onClick={refresh} className="underline whitespace-nowrap">
              重试
            </button>
          )}
        </div>
      )}

      {/* 未登录空态：仅在登录态已知且未登录时显示（未知时不闪大卡片） */}
      {statusKnown && !loggedIn && (
        <div className="rounded-lg border border-border bg-card px-6 py-14 flex flex-col items-center gap-3">
          <p className="text-sm text-muted-foreground">
            尚未登录 Xiaomi MiMo。登录后将展示 订阅套餐、套餐额度与账户余额、用量汇总与模型明细。
          </p>
          <button
            onClick={handleLogin}
            disabled={loggingIn}
            className="flex items-center gap-2 px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {loggingIn && <Loader2 className="w-4 h-4 animate-spin" />}
            登录
          </button>
        </div>
      )}

      {/* 已登录：数据区 */}
      {loggedIn && loading && !usage && (
        <div className="flex-1 flex items-center justify-center py-20 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin mr-2" /> 正在拉取用量数据…
        </div>
      )}

      {loggedIn && usage && (
        <>
          {/* 订阅与额度（一行三卡：当前套餐 / 状态与到期 / 套餐额度）+ MiMo 特有明细（账户余额、套餐用量）随卡片展示 */}
          <section>
            <div className="flex flex-wrap items-baseline gap-x-2 mb-2">
              <h3 className="text-xs font-semibold text-muted-foreground">订阅与额度</h3>
              <span className="text-xs text-muted-foreground">MiMo Token Plan 按套餐周期计量，无 5 小时 / 7 天滚动窗口</span>
              <span
                className="cursor-help"
                title="官方 FAQ：Token Plan 为固定周期 Credits 池（no 5-hour cap or weekly usage limit）；额度在套餐周期结束（续费/到期）时整体重置"
              >
                · 口径说明
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <MimoSubscriptionSection
                subscription={subscription}
                available={usage.sourcesAvailable.subscription ?? false}
                className="md:col-span-2"
              />
              <MonthlyCard
                title="套餐额度"
                window={usage.windows?.monthly}
                resetAtTs={subscription?.expireAtTs ?? usage.windows?.monthly?.resetAt}
                currency={currency}
                {...(planRemainingCredits !== undefined
                  ? { creditsText: `剩余 ${fmtYi(planRemainingCredits)} Credits` }
                  : {})}
                hint="已用% 来自 Token Plan 套餐用量（与官网进度条同口径）；额度在套餐周期结束（续费/到期）时重置"
              />
            </div>

            {/* 账户余额（现金/赠送/透支）：MiMo 独有，随额度一并展示 */}
            {balance && (
              <div className="mt-3">
                <div className="text-xs text-muted-foreground mb-1.5">账户余额</div>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                  <div className="rounded-lg border border-border bg-card px-4 py-3">
                    <div className="text-xs text-muted-foreground mb-1">总余额</div>
                    <div className="text-xl font-bold tabular-nums text-foreground">
                      {balSym}
                      {balance.balance.toFixed(2)}
                    </div>
                  </div>
                  <StatCard label="现金余额" value={`${balSym}${balance.cashBalance.toFixed(2)}`} />
                  <StatCard label="赠送余额" value={`${balSym}${balance.giftBalance.toFixed(2)}`} />
                  <StatCard label="冻结金额" value={`${balSym}${balance.frozenBalance.toFixed(2)}`} />
                  <StatCard label="透支额度" value={`${balSym}${balance.overdraftLimit.toFixed(2)}`} />
                  <StatCard label="剩余透支额度" value={`${balSym}${balance.remainingOverdraftLimit.toFixed(2)}`} />
                </div>
              </div>
            )}

            {/* 当前套餐用量（与官网 plan-manage 同名同源：/tokenPlan/usage 的 used/limit/percent） */}
            {tokenPlan && tokenPlan.items.length > 0 && (
              <div className="mt-3">
                <div className="text-xs text-muted-foreground mb-1.5">当前套餐用量</div>
                <div className="rounded-lg border border-border bg-card divide-y divide-border overflow-hidden">
                  {tokenPlan.items.map((it) => {
                    const label = MIMO_PLAN_LABELS[it.name] ?? it.name
                    const pct = Math.min(100, it.percent)
                    return (
                      <div key={it.name} className="px-4 py-3">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-sm font-medium text-foreground">{label}</span>
                          <span className="text-xs text-muted-foreground tabular-nums">{Math.round(pct)}% 已用</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div className={`h-full rounded-full ${barColor(pct)}`} style={{ width: `${pct}%` }} />
                        </div>
                        <div className="mt-1.5 text-xs text-muted-foreground tabular-nums">
                          已用 {fmtYi(it.used)} / 总量 {fmtYi(it.limit)} · 剩余{' '}
                          {fmtYi(Math.max(it.limit - it.used, 0))} Credits
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </section>

          {/* 汇总卡片：由当月明细行聚合（按量 + 套餐双通道），与模型明细（服务端聚合口径）同源同区间 */}
          <section>
            <div className="flex flex-wrap items-baseline gap-x-2 mb-2">
              <h3 className="text-xs font-semibold text-muted-foreground">汇总</h3>
              <span
                className="text-xs text-muted-foreground"
                title="由当月明细行（/usage/detail/list 按量 + /usage/token-plan/list 套餐，按「日期 × 模型」合并）聚合，与「模型明细 · 服务端聚合」同源同区间，两者合计应相等；本地累计口径覆盖更长区间，与汇总不应相等"
              >
                {summary?.periodBasis === 'current-month' ? '当前自然月' : '当月'} · 与模型明细同口径
              </span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <StatCard label="总请求数" value={summary ? fmtNum(summary.totalCount) : '—'} />
              <StatCard
                label="按量成本"
                hint="按量计费金额（账户币种原值折 USD）；套餐通道按 Credits 计量、无金额口径，不计入本数字。当月无按量用量时显示 —"
                value={summary && summary.totalCost !== undefined ? formatCost(summary.totalCost, currency) : '—'}
              />
              <StatCard label="总 Tokens" value={summary ? fmtNum(summary.totalTokens) : '—'} />
            </div>
          </section>

          {/* 模型明细：服务端聚合（当月日期×模型）/ 本地累计 */}
          <section>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-2">
              <h3 className="text-xs font-semibold text-muted-foreground">模型明细</h3>
              <div className="flex items-center gap-1">
                {(
                  [
                    [
                      'monthly',
                      '服务端聚合',
                      '服务端按「日期 × 模型」聚合的当月明细；数据源为按量明细（/usage/detail/list）与套餐明细（/usage/token-plan/list）合并（当前自然月）'
                    ],
                    [
                      'cumulative',
                      '本地累计',
                      '本地按「日期 × 模型」自然键 upsert 累积（自首次采集起，跨月只增不减）；采集停止期间的用量会漏采'
                    ]
                  ] as const
                ).map(([mode, label, hint]) => {
                  const disabled = mode === 'monthly' && !monthlyAvailable
                  return (
                    <button
                      key={mode}
                      onClick={() => setDetailMode(mode)}
                      disabled={disabled}
                      title={disabled ? '当月明细暂无数据（当月无用量或接口未返回行），仅可查看本地累计' : hint}
                      className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                        effectiveDetailMode === mode
                          ? 'border-primary/50 bg-primary/10 text-foreground'
                          : 'border-border text-muted-foreground hover:bg-accent'
                      } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* 口径说明行 */}
            {effectiveDetailMode === 'monthly' ? (
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 mb-2 text-xs text-muted-foreground">
                <span>服务端按「日期 × 模型」聚合 · 当前自然月</span>
                {monthlySpan && <span>· 覆盖 {monthlySpan}</span>}
                <span>· 日期为 UTC 时间，准实时更新（与官网账单口径一致）</span>
                <span className="cursor-help" title="来自 /usage/detail/list（按量，含金额）+ /usage/token-plan/list（套餐，无金额），按「日期 × 模型」合并后按 model 聚合出请求数 / 输入 / 输出 / 总 Tokens / 成本">
                  · 口径说明
                </span>
              </div>
            ) : (
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 mb-2 text-xs text-muted-foreground">
                {cumulative && cumulative.records > 0 ? (
                  <>
                    <span>本地累计 {cumulative.records.toLocaleString()} 行（日期 × 模型）</span>
                    {cumulativeSinceLabel && <span>· 自 {cumulativeSinceLabel} 起</span>}
                    {cumulative.toTs !== undefined && <span>· 最近记录 {fmtSpan(cumulative.toTs, cumulative.toTs)}</span>}
                    {collectorState && collectorState.lastRunAt !== undefined && (
                      <span className={collectorStale ? 'text-yellow-600' : undefined}>
                        · 最近采集 {fmtTime(collectorState.lastRunAt)}（已 {collectorState.runs} 轮
                        {collectorState.runs > collectorState.okRuns ? ` · 失败 ${collectorState.runs - collectorState.okRuns}` : ''}）
                      </span>
                    )}
                    {collectorStale && <span className="text-yellow-600">· 采集可能已停止</span>}
                    {collectorState === undefined && cumulative.lastCollectedAt !== undefined && (
                      <span>· 最近采集 {fmtTime(cumulative.lastCollectedAt)}</span>
                    )}
                    {collector && !collector.enabled && (
                      <span className="text-yellow-600">· 自动刷新已关闭（仅手动刷新时累积）</span>
                    )}
                    {collector?.enabled && collector.intervalMinutes > 0 && (
                      <span>· 每 {collector.intervalMinutes} 分钟自动采集</span>
                    )}
                    {collector?.lastError && <span className="text-yellow-600">· 最近一次采集失败（{collector.lastError}）</span>}
                    <span
                      className="cursor-help"
                      title="本地累计由每次采集到的「日期 × 模型」行按自然键 upsert 累积（数值变化覆盖、恒等不计）；采集未运行期间的用量会漏采，故仅代表“已观测到的用量”"
                    >
                      · 口径说明
                    </span>
                  </>
                ) : (
                  <span>暂无本地累计数据（自动刷新或手动刷新后会逐步累积）</span>
                )}
              </div>
            )}
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border">
                    <th className="text-left px-4 py-2 font-medium">模型</th>
                    <th className="text-right px-4 py-2 font-medium">请求数</th>
                    <th className="text-right px-4 py-2 font-medium">↑ 输入</th>
                    <th className="text-right px-4 py-2 font-medium">↓ 输出</th>
                    <th className="text-right px-4 py-2 font-medium">总 Tokens</th>
                    <th
                      className="text-right px-4 py-2 font-medium"
                      title="成本 = 按量计费金额（账户币种折 USD）；套餐通道按 Credits 计量、无金额口径，纯套餐行显示 —"
                    >
                      成本
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shownModels.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-12 text-center text-sm text-muted-foreground">
                        {effectiveDetailMode === 'monthly'
                          ? '暂无当月明细数据（当月无用量或接口未返回行）'
                          : '暂无本地累计数据（自动刷新或手动刷新后会逐步累积）'}
                      </td>
                    </tr>
                  ) : (
                    shownModels.map((m) => (
                      <tr key={m.model} className="border-b border-border/50 last:border-b-0 hover:bg-accent/30">
                        <td className="px-4 py-2 text-foreground">{m.model}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtNum(m.requests)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtNum(m.tokensIn)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtNum(m.tokensOut)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtNum(m.tokensTotal)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{m.cost !== undefined ? formatCost(m.cost, currency) : '—'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

// ─── 面板：DeepSeek 开放平台用量 ───

function DeepSeekPanel({ source, account }: { source: RemoteUsageSource; account: MonitorAccount }) {
  // 凭据 / 快照 / 本地累计 / IPC 一律按**账号**键控（默认账号 id = 源 id，历史数据零迁移）
  const accountId = account.id

  const [status, setStatus] = useState<MonitorStatus | null>(
    () => getCloudSnapshot(accountId)?.status ?? null
  )
  const [usage, setUsage] = useState<DeepSeekUsage | null>(
    () => (getCloudSnapshot(accountId)?.usage as DeepSeekUsage | undefined) ?? null
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<MonitorErrorCode | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  // 上次刷新时间 = 快照的 fetchedAt（与 usage 同源，重进页面随快照一起恢复）
  const lastFetchedAt = usage?.fetchedAt ?? null
  const [showApiKeyInput, setShowApiKeyInput] = useState(false)
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  // 快照恢复是否已完成（会话内模块缓存 / 主进程持久化快照）：TTL 判定须等它完成，避免快照未到先误拉
  const [snapshotReady, setSnapshotReady] = useState(() => getCloudSnapshot(accountId)?.usage != null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // 始终指向最新的 refresh，避免定时器闭包持旧函数
  const refreshRef = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    refreshRef.current = refresh
  })

  const loggedIn = status?.loggedIn ?? false
  // 登录态是否已知：读取中（本地 IPC，瞬时）时按中性渲染，避免先闪「登录」按钮再切「退出登录」
  const statusKnown = status != null
  // 统一自动刷新间隔（分钟；0 = 关闭）：页面刷新与 Command Code 后台明细采集共用
  const refreshMinutes = useAutoRefreshMinutes()

  // ── 数据加载 ──
  const loadStatus = async () => {
    if (!source) return
    try {
      const res = await window.moaAPI.getMonitorStatus(accountId)
      if (res.success && res.data) setStatus(res.data)
    } catch {
      // 状态读取失败不阻塞页面
    }
  }

  // 登录态变化即写回快照：切视图重进时首帧直接渲染正确外观（避免先闪「登录」按钮再切「退出登录」）
  useEffect(() => {
    if (accountId && status) patchCloudSnapshot(accountId, { status })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, status])

  const refresh = async () => {
    if (!source || loading) return
    setLoading(true)
    setError(null)
    setErrorCode(null)
    try {
      const res = await window.moaAPI.monitorRefresh(accountId)
      if (res.success && res.data) {
        setUsage(res.data as DeepSeekUsage)
        // 写回快照：视图切走组件卸载后，重进直接恢复
        patchCloudSnapshot(accountId, { usage: res.data })
      } else {
        const code = res.code ?? 'unknown'
        setErrorCode(code)
        if (code === 'not_authenticated') {
          setStatus((s) => (s ? { ...s, loggedIn: false } : s))
          setError('尚未配置令牌，请先登录平台或配置 API Key')
        } else if (code === 'session_expired') {
          setError('登录已过期，请重新登录')
        } else {
          setError(res.error || '拉取用量数据失败')
          if (code === 'network') {
            setError('拉取用量数据失败（网络不通）。若处于受限网络，请在「设置 → 网络代理」中开启代理后重试')
          }
        }
      }
    } catch (err) {
      setErrorCode('network')
      setError(err instanceof Error ? err.message : '拉取用量数据失败')
    } finally {
      setLoading(false)
    }
  }

  // 从主进程读取上次会话（应用重启前）持久化的用量快照；本次会话模块缓存已有则跳过
  const hydrateUsage = async () => {
    if (getCloudSnapshot(accountId)?.usage != null) return
    try {
      const res = await window.moaAPI.monitorGetSnapshot(accountId)
      if (res.success && res.data) {
        setUsage(res.data as DeepSeekUsage)
        patchCloudSnapshot(accountId, { usage: res.data })
      }
    } catch {
      // 快照读取失败不阻塞页面（按无快照处理）
    } finally {
      setSnapshotReady(true)
    }
  }

  // 挂载：读取状态；用量本体从快照恢复（会话内模块缓存 / 主进程持久化快照，见 hydrateUsage）
  useEffect(() => {
    loadStatus()
    void hydrateUsage()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, source])

  // 登录态与快照恢复都就绪后：无快照或快照已过期（超过统一自动刷新间隔）才打远端；新鲜则直接用快照展示
  useEffect(() => {
    if (snapshotReady && status?.loggedIn && shouldFetchOnMount(usage, refreshMinutes)) {
      refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.loggedIn, snapshotReady])

  // 自动刷新定时器（统一间隔；经 refreshRef 调用最新 refresh）
  useEffect(() => {
    if (refreshMinutes <= 0 || !loggedIn) return
    timerRef.current = setInterval(() => {
      refreshRef.current()
    }, refreshMinutes * 60_000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [refreshMinutes, loggedIn])

  // ── 动作 ──
  const handleLogin = async () => {
    if (!source) return
    setLoggingIn(true)
    try {
      const res = await window.moaAPI.monitorLogin(accountId)
      const inner = res.data
      if (res.success && inner?.success) {
        setError(null)
        setErrorCode(null)
        await loadStatus()
        refresh()
      }
      // cancelled → 用户关闭登录窗，静默
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setLoggingIn(false)
    }
  }

  const handleLogout = async () => {
    // 快照随登出清空：换账号后不得残留旧账号数据
    clearCloudSnapshot(accountId)
    try {
      await window.moaAPI.monitorLogout(accountId)
    } catch {
      // 登出尽力而为：本地登录态立即复位，失败无需打扰用户
    }
    setStatus({ loggedIn: false, hasApiKey: false })
    setUsage(null)
    setError(null)
    setErrorCode(null)
  }

  const handleSaveApiKey = async () => {
    if (!apiKeyDraft.trim()) return
    try {
      await window.moaAPI.monitorSetApiKey(accountId, apiKeyDraft.trim())
      setApiKeyDraft('')
      setShowApiKeyInput(false)
      setStatus((s) => (s ? { ...s, hasApiKey: true, loggedIn: true } : s))
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存 API Key 失败')
    }
  }

  // ── 渲染 ──
  const balance = usage?.balance
  const currency = usage?.currency ?? balance?.infos[0]?.currency
  const curSym = currency === 'USD' ? '$' : '¥'
  const infos: DeepSeekBalanceInfo[] = balance?.infos ?? []
  const primaryInfo = infos[0]
  const models = usage?.models ?? []
  const daily = usage?.daily ?? []
  const maxDailyTokens = Math.max(...daily.map((d) => d.tokens), 1)

  return (
    <div className="flex flex-col gap-4">
      {/* 顶部：源信息 + 操作 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-foreground flex items-center gap-2">
            {source.name}
            <span
              className={`inline-block w-2 h-2 rounded-full ${loggedIn ? 'bg-green-500' : 'bg-muted'}`}
              title={loggedIn ? '已登录' : '未登录'}
            />
          </h2>
          <a
            href={source.studioUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              e.preventDefault()
              window.open(source.studioUrl, '_blank', 'noopener')
            }}
            className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:text-foreground mt-0.5"
          >
            {source.studioUrl} <ExternalLink className="w-3 h-3" />
          </a>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {lastFetchedAt && (
            <span className="text-xs text-muted-foreground">上次刷新 {fmtTime(lastFetchedAt)}</span>
          )}
          <AutoRefreshControl />
          <button
            onClick={refresh}
            disabled={loading || !loggedIn}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border bg-card text-foreground hover:bg-accent disabled:opacity-50 transition-colors"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            刷新
          </button>
          {!statusKnown ? (
            // 登录态读取中（本地 IPC，瞬时）：渲染不可见占位保持布局，避免先闪出黑底的「登录」按钮
            <button
              disabled
              aria-hidden="true"
              className="invisible flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border text-muted-foreground"
            >
              <LogOut className="w-3.5 h-3.5" /> 退出登录
            </button>
          ) : loggedIn ? (
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" /> 退出登录
            </button>
          ) : (
            <button
              onClick={handleLogin}
              disabled={loggingIn}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {loggingIn && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              登录 DeepSeek 开放平台
            </button>
          )}
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive flex items-center justify-between gap-3">
          <span>{error}</span>
          {(errorCode === 'session_expired' || errorCode === 'not_authenticated') && (
            <button onClick={handleLogin} className="underline whitespace-nowrap">
              重新登录
            </button>
          )}
          {errorCode === 'network' && (
            <button onClick={refresh} className="underline whitespace-nowrap">
              重试
            </button>
          )}
        </div>
      )}

      {/* 未登录空态：仅在登录态已知且未登录时显示（未知时不闪大卡片） */}
      {statusKnown && !loggedIn && (
        <div className="rounded-lg border border-border bg-card px-6 py-14 flex flex-col items-center gap-3">
          <p className="text-sm text-muted-foreground">
            尚未登录 DeepSeek 开放平台。登录后展示账户余额、今日/本月花费与 Token 用量、模型明细及近 7 日趋势。
          </p>
          <button
            onClick={handleLogin}
            disabled={loggingIn}
            className="flex items-center gap-2 px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {loggingIn && <Loader2 className="w-4 h-4 animate-spin" />}
            登录
          </button>
        </div>
      )}

      {/* 已登录：数据区 */}
      {loggedIn && loading && !usage && (
        <div className="flex-1 flex items-center justify-center py-20 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin mr-2" /> 正在拉取用量数据…
        </div>
      )}

      {loggedIn && usage && (
        <>
          {/* 余额提醒条：登录态余额也获取失败时展示 */}
          {!usage.sourcesAvailable.balance && (
            <div className="rounded-lg border border-border bg-card px-4 py-2.5 flex flex-wrap items-center gap-2 text-sm">
              <KeyRound className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <span className="text-xs text-muted-foreground flex-1 min-w-40">
                余额获取失败，可尝试重新登录；也可配置 API Key 作为余额查询的备用通道。
              </span>
              {status?.hasApiKey && !showApiKeyInput ? (
                <span className="text-xs text-green-600">已配置 API Key</span>
              ) : null}
              {showApiKeyInput ? (
                <span className="flex items-center gap-1.5 flex-wrap">
                  <input
                    value={apiKeyDraft}
                    onChange={(e) => setApiKeyDraft(e.target.value)}
                    placeholder="sk-..."
                    className="w-56 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <button
                    onClick={handleSaveApiKey}
                    disabled={!apiKeyDraft.trim()}
                    className="px-2.5 py-1 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    保存
                  </button>
                  <button
                    onClick={() => {
                      setShowApiKeyInput(false)
                      setApiKeyDraft('')
                    }}
                    className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    取消
                  </button>
                </span>
              ) : (
                <button onClick={() => setShowApiKeyInput(true)} className="px-2.5 py-1 text-xs rounded-md border border-border hover:bg-accent transition-colors">
                  {status?.hasApiKey ? '更新' : '配置'}
                </button>
              )}
            </div>
          )}

          {/* 余额 */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground mb-2">账户余额</h3>
            {primaryInfo ? (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="rounded-lg border border-border bg-card px-4 py-3">
                  <div className="text-xs text-muted-foreground mb-1">总余额</div>
                  <div className="text-2xl font-bold tabular-nums text-foreground">
                    {curSym}
                    {primaryInfo.totalBalance.toFixed(2)}
                  </div>
                  <div className={`mt-1 text-xs ${balance?.isAvailable === false ? 'text-destructive' : 'text-muted-foreground'}`}>
                    {balance?.isAvailable === false ? '余额不足，无法调用 API' : '可用'}
                  </div>
                </div>
                <StatCard label="充值余额" value={`${curSym}${primaryInfo.toppedUpBalance.toFixed(2)}`} />
                <StatCard label="赠送余额" value={`${curSym}${primaryInfo.grantedBalance.toFixed(2)}`} />
                <div className="rounded-lg border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
                  币种 {primaryInfo.currency}
                  {infos.length > 1 && <span className="block mt-1">共 {infos.length} 种币种，展示主币种</span>}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
                暂无余额数据（未配置 API Key）
              </div>
            )}
          </section>

          {/* 用量汇总 */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground mb-2">用量</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard label="今日花费" value={`${curSym}${(usage.todayCost ?? 0).toFixed(4)}`} />
              <StatCard label="今日 Tokens" value={fmtNum(usage.todayTokens ?? 0)} />
              <StatCard label="本月花费" value={`${curSym}${(usage.monthCost ?? 0).toFixed(4)}`} />
              <StatCard label="本月 Tokens" value={fmtNum(usage.monthTokens ?? 0)} />
            </div>
          </section>

          {/* 近 7 日趋势 */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground mb-2">近 7 日趋势</h3>
            {daily.length > 0 ? (
              <div className="rounded-lg border border-border bg-card px-4 py-4">
                {/* 柱区：固定高度 + 像素柱高（% 高度在内容撑开的 flex 子项中会失效） */}
                <div className="flex items-end gap-1.5 h-24">
                  {daily.map((d) => (
                    <div key={d.date} className="flex-1 h-full flex flex-col items-center justify-end gap-1 group">
                      <div className="text-[10px] leading-none text-muted-foreground tabular-nums h-3">
                        {d.tokens > 0 ? fmtNum(d.tokens) : ''}
                      </div>
                      <div
                        className={`w-full max-w-7 rounded-t transition-colors ${d.tokens > 0 ? 'bg-primary group-hover:bg-primary/70' : 'bg-muted/40'}`}
                        style={{ height: `${Math.max(Math.round((d.tokens / maxDailyTokens) * 48), d.tokens > 0 ? 4 : 2)}px` }}
                        title={`${d.date}: ${fmtNum(d.tokens)} tokens · ${curSym}${d.cost.toFixed(4)}`}
                      />
                    </div>
                  ))}
                </div>
                {/* 日期轴：与柱区同 gap 对齐 */}
                <div className="flex gap-1.5 mt-1">
                  {daily.map((d) => (
                    <div key={d.date} className="flex-1 text-center text-[10px] text-muted-foreground">
                      {d.date.slice(5)}
                    </div>
                  ))}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">柱高按当日 Tokens 归一化；悬停查看 Tokens 与花费。</div>
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
                暂无趋势数据
              </div>
            )}
          </section>

          {/* 模型明细 */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground mb-2">模型明细（本月）</h3>
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border">
                    <th className="text-left px-4 py-2 font-medium">模型</th>
                    <th className="text-right px-4 py-2 font-medium">请求数</th>
                    <th className="text-right px-4 py-2 font-medium">↑ 输入</th>
                    <th className="text-right px-4 py-2 font-medium">↓ 输出</th>
                    <th className="text-right px-4 py-2 font-medium">总 Tokens</th>
                    <th className="text-right px-4 py-2 font-medium">花费</th>
                  </tr>
                </thead>
                <tbody>
                  {models.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-12 text-center text-sm text-muted-foreground">
                        本月暂无用量数据
                      </td>
                    </tr>
                  ) : (
                    models.map((m) => (
                      <tr key={m.model} className="border-b border-border/50 last:border-b-0 hover:bg-accent/30">
                        <td className="px-4 py-2 text-foreground">{m.model}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtNum(m.requests)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtNum(m.inputTokens)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtNum(m.outputTokens)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtNum(m.totalTokens)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{curSym}{m.cost.toFixed(4)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

// ─── 云监控容器：按启用的监控源渲染对应面板（每源可挂多个账号，按账号切换查看）───

/** 账号备注名：有备注用备注名，否则按通道显示 */
function accountName(acc: MonitorAccount): string {
  return acc.label.trim() || (acc.billing === 'plan' ? 'Plan' : '按量')
}

/** 生成新账号 id（默认账号 id 恒等于源 id；新增账号用随机 id，与历史键不冲突） */
function newAccountId(sourceId: string): string {
  return `${sourceId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

export default function CloudMonitorView() {
  const settings = useSettingsStore((s) => s.settings)
  const updateSetting = useSettingsStore((s) => s.updateSetting)
  const sources = settings.monitoring?.sources?.filter((s) => s.enabled) ?? []
  const accounts = settings.monitoring?.accounts ?? []

  /** 每源当前查看的账号（缺省该源第一个账号） */
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [addingFor, setAddingFor] = useState<string | null>(null)
  const [newLabel, setNewLabel] = useState('')
  const [newBilling, setNewBilling] = useState<'plan' | 'usage'>('usage')

  const persistAccounts = async (next: MonitorAccount[]) => {
    const base = settings.monitoring ?? { sources: [], accounts: [], autoRefreshMinutes: 10 }
    await updateSetting('monitoring', { ...base, accounts: next })
  }

  const accountsOf = (sourceId: string) => accounts.filter((a) => a.sourceId === sourceId)

  const pickAccount = (sourceId: string): MonitorAccount | undefined => {
    const list = accountsOf(sourceId)
    return list.find((a) => a.id === selected[sourceId]) ?? list[0]
  }

  const addAccount = async (source: RemoteUsageSource) => {
    const acc: MonitorAccount = {
      id: newAccountId(source.id),
      sourceId: source.id,
      label: newLabel.trim(),
      billing: newBilling
    }
    await persistAccounts([...accounts, acc])
    setSelected((s) => ({ ...s, [source.id]: acc.id }))
    setAddingFor(null)
    setNewLabel('')
    setNewBilling('usage')
  }

  const removeAccount = async (source: RemoteUsageSource, acc: MonitorAccount) => {
    // 每源至少保留一个账号；删除前先登出 → 该账号的凭据 / 落盘快照 / 本地累计一并清除，
    // 同源其它账号数据保留（不会串号）
    if (accountsOf(source.id).length <= 1) return
    try {
      await window.moaAPI.monitorLogout(acc.id)
    } catch {
      // 凭据清理失败不阻断账号移除
    }
    // 渲染层模块级缓存也要清：登出路径清的是本账号，已删账号不得残留快照
    clearCloudSnapshot(acc.id)
    await persistAccounts(accounts.filter((a) => a.id !== acc.id))
    // selected 的键是**源 id**（不是账号 id）：删掉后回退到该源第一个账号
    setSelected((s) => {
      if (s[source.id] !== acc.id) return s
      const { [source.id]: _drop, ...rest } = s
      return rest
    })
  }

  if (sources.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto p-4">
        <div className="rounded-lg border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
          未配置云端用量监控源，请先在设置中添加
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-6">
      {sources.map((src) => {
        const list = accountsOf(src.id)
        const acc = pickAccount(src.id)
        return (
          <div key={src.id} className="flex flex-col gap-2">
            {/* 账号栏：同源多账号各看各的数据（凭据 / 快照 / 累计全部按账号隔离）；源名见下方面板标题 */}
            <div className="flex items-center justify-end gap-2 flex-wrap">
              <div className="flex items-center gap-1 flex-wrap">
                {list.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => setSelected((s) => ({ ...s, [src.id]: a.id }))}
                    className={`px-2 py-0.5 text-xs rounded-md border transition-colors ${
                      acc?.id === a.id
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border text-muted-foreground hover:border-primary/50'
                    }`}
                    title={a.label || undefined}
                  >
                    {accountName(a)}
                  </button>
                ))}
                <button
                  onClick={() => { setAddingFor((v) => (v === src.id ? null : src.id)); setNewLabel(''); setNewBilling('usage') }}
                  className="flex items-center gap-0.5 px-1.5 py-0.5 text-xs text-primary hover:text-primary/80"
                  title="添加账号（Plan 与按量可各用各的账号）"
                >
                  <Plus className="w-3 h-3" /> 添加账号
                </button>
                {acc && list.length > 1 && (
                  <button
                    onClick={() => removeAccount(src, acc)}
                    className="p-1 text-muted-foreground hover:text-destructive rounded-md"
                    title="删除当前查看的账号（凭据与用量一并清除）"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>

            {/* 添加账号内联表单 */}
            {addingFor === src.id && (
              <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
                <input
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="账号备注（可空），如：工作号"
                  className="flex-1 min-w-0 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <select
                  value={newBilling}
                  onChange={(e) => setNewBilling(e.target.value as 'plan' | 'usage')}
                  className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
                >
                  <option value="usage">按量账号</option>
                  <option value="plan">Plan 账号</option>
                </select>
                <button
                  onClick={() => addAccount(src)}
                  className="px-2 py-1 text-xs bg-primary text-primary-foreground rounded-md hover:opacity-90"
                >
                  添加
                </button>
                <button
                  onClick={() => setAddingFor(null)}
                  className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  取消
                </button>
              </div>
            )}

            {/* key 带 accountId：切账号时面板整体重建，不复用上一账号的 state */}
            {acc &&
              (src.type === 'mimo' ? (
                <MimoPanel key={`${src.id}:${acc.id}`} source={src} account={acc} />
              ) : src.type === 'deepseek' ? (
                <DeepSeekPanel key={`${src.id}:${acc.id}`} source={src} account={acc} />
              ) : (
                <CommandCodePanel key={`${src.id}:${acc.id}`} source={src} account={acc} />
              ))}
          </div>
        )
      })}
    </div>
  )
}