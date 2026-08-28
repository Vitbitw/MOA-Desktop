import React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../store/settingsStore'
import { formatCost } from '../lib/usageFormat'
import { ExternalLink, KeyRound, Loader2, LogOut, RefreshCw } from 'lucide-react'
import type {
  CommandCodeUsage,
  DeepSeekBalanceInfo,
  DeepSeekUsage,
  MimoUsage,
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

/** 从 epoch 秒计算距重置的剩余时间文案 */
function fmtRemaining(resetAtSec: number): string {
  const remainMs = resetAtSec * 1000 - Date.now()
  if (remainMs <= 0) return '即将重置'
  const totalMin = Math.ceil(remainMs / 60_000)
  const d = Math.floor(totalMin / 1440)
  const h = Math.floor((totalMin % 1440) / 60)
  const m = totalMin % 60
  if (d > 0) return `${d}天${h}小时后重置`
  if (h > 0) return `${h}小时${m}分钟后重置`
  return `${m}分钟后重置`
}

function barColor(pct: number): string {
  if (pct >= 90) return 'bg-destructive'
  if (pct >= 70) return 'bg-yellow-500'
  return 'bg-primary'
}

// ─── 子组件：额度窗口卡 ───

function WindowCard({ title, info, disabled }: { title: string; info?: UsageWindowInfo; disabled?: boolean }) {
  const used = info?.usedPercent
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground mb-2">{title}</div>
      {disabled ? (
        <div className="text-sm text-muted-foreground leading-5">配置 Provider API Key 后显示</div>
      ) : info && used !== undefined ? (
        <>
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="text-lg font-semibold tabular-nums text-foreground">{Math.round(used)}% 已用</span>
            <span className="text-xs text-muted-foreground">{100 - Math.round(used)}% 剩余</span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div className={`h-full rounded-full ${barColor(used)}`} style={{ width: `${Math.min(100, used)}%` }} />
          </div>
          <div className="mt-1.5 text-xs text-muted-foreground">{info.resetAt ? fmtRemaining(info.resetAt) : '—'}</div>
        </>
      ) : (
        <div className="text-sm text-muted-foreground">暂无数据</div>
      )}
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className="text-lg font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  )
}

// ─── 面板：Command Code 云端用量 ───

function CommandCodePanel({ source }: { source: RemoteUsageSource }) {
  const settings = useSettingsStore((s) => s.settings)
  const currency = settings.currency
  const sourceId = source.id

  const [status, setStatus] = useState<MonitorStatus | null>(null)
  const [usage, setUsage] = useState<CommandCodeUsage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<MonitorErrorCode | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)
  const [showApiKeyInput, setShowApiKeyInput] = useState(false)
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // 始终指向最新的 refresh，避免定时器闭包持旧函数（拿到过期的 loading/status）
  const refreshRef = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    refreshRef.current = refresh
  })

  const loggedIn = status?.loggedIn ?? false

  // ── 数据加载 ──
  const loadStatus = async () => {
    if (!source) return
    try {
      const res = await window.moaAPI.getMonitorStatus(source)
      if (res.success && res.data) setStatus(res.data)
    } catch {
      // 状态读取失败不阻塞页面
    }
  }

  const refresh = async () => {
    if (!source || loading) return
    setLoading(true)
    setError(null)
    setErrorCode(null)
    try {
      const res = await window.moaAPI.monitorRefresh(source)
      if (res.success && res.data) {
        setUsage(res.data as CommandCodeUsage)
        setLastFetchedAt(res.data.fetchedAt)
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

  // 挂载：读取状态；已登录则拉一次数据
  useEffect(() => {
    if (!sourceId) return
    loadStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId])

  useEffect(() => {
    if (sourceId && status?.loggedIn && usage == null) {
      refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.loggedIn, usage == null])

  // 自动刷新定时器（经 refreshRef 调用最新 refresh）
  useEffect(() => {
    const minutes = settings.monitoring?.autoRefreshMinutes ?? 0
    if (!autoRefresh || !loggedIn || minutes <= 0 || !sourceId) return
    timerRef.current = setInterval(() => {
      refreshRef.current()
    }, minutes * 60_000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, loggedIn, sourceId, settings.monitoring?.autoRefreshMinutes])

  // ── 动作 ──
  const handleLogin = async () => {
    if (!source) return
    setLoggingIn(true)
    try {
      const res = await window.moaAPI.monitorLogin(source)
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
    if (!sourceId) return
    try {
      await window.moaAPI.monitorLogout(sourceId)
    } catch {
      // 忽略
    }
    setStatus({ loggedIn: false, hasApiKey: false })
    setUsage(null)
    setError(null)
    setErrorCode(null)
  }

  const handleSaveApiKey = async () => {
    if (!sourceId || !apiKeyDraft.trim()) return
    try {
      await window.moaAPI.monitorSetApiKey(sourceId, apiKeyDraft.trim())
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
  const models = usage?.models ?? []

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
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="accent-primary"
            />
            自动刷新（{settings.monitoring?.autoRefreshMinutes ?? 10} 分钟）
          </label>
          <button
            onClick={refresh}
            disabled={loading || !loggedIn}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border bg-card text-foreground hover:bg-accent disabled:opacity-50 transition-colors"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            刷新
          </button>
          {loggedIn ? (
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

      {/* 未登录空态 */}
      {!loggedIn && (
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
          {/* 额度区：5h / 7d / 月度余额 */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground mb-2">额度</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <WindowCard title="5小时窗口" info={usage.windows?.fiveHour} disabled={!windowsAvailable} />
              <WindowCard title="7天窗口" info={usage.windows?.weekly} disabled={!windowsAvailable} />
              <div className="rounded-lg border border-border bg-card px-4 py-3">
                <div className="text-xs text-muted-foreground mb-2">月度额度余额</div>
                <div className="text-lg font-semibold tabular-nums text-foreground">
                  {credits?.monthlyCredits !== undefined ? formatCost(credits.monthlyCredits, currency) : '暂无数据'}
                </div>
              </div>
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

          {/* 汇总卡片 */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground mb-2">汇总</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard label="总请求数" value={summary ? fmtNum(summary.totalCount) : '—'} />
              <StatCard label="总成本" value={summary ? formatCost(summary.totalCost, currency) : '—'} />
              <StatCard label="总 Tokens" value={summary ? fmtNum(summary.totalTokens) : '—'} />
              <StatCard label="成功率" value={summary ? `${summary.successRate > 1 ? summary.successRate : summary.successRate * 100}%` : '—'} />
            </div>
          </section>

          {/* 模型明细 */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground mb-2">模型明细</h3>
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border">
                    <th className="text-left px-4 py-2 font-medium">模型</th>
                    <th className="text-right px-4 py-2 font-medium">请求数</th>
                    <th className="text-right px-4 py-2 font-medium">↑ 输入</th>
                    <th className="text-right px-4 py-2 font-medium">↓ 输出</th>
                    <th className="text-right px-4 py-2 font-medium">总 Tokens</th>
                    <th className="text-right px-4 py-2 font-medium">成本</th>
                  </tr>
                </thead>
                <tbody>
                  {models.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-12 text-center text-sm text-muted-foreground">
                        {summary ? '暂无模型明细数据' : '暂无用量数据'}
                      </td>
                    </tr>
                  ) : (
                    models.map((m) => (
                      <tr key={m.model} className="border-b border-border/50 last:border-b-0 hover:bg-accent/30">
                        <td className="px-4 py-2 text-foreground">{m.model}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtNum(m.requests)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtNum(m.tokensIn)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtNum(m.tokensOut)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtNum(m.tokensTotal)}</td>
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

function MimoPanel({ source }: { source: RemoteUsageSource }) {
  const settings = useSettingsStore((s) => s.settings)
  const sourceId = source.id

  const [status, setStatus] = useState<MonitorStatus | null>(null)
  const [usage, setUsage] = useState<MimoUsage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<MonitorErrorCode | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // 始终指向最新的 refresh，避免定时器闭包持旧函数
  const refreshRef = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    refreshRef.current = refresh
  })

  const loggedIn = status?.loggedIn ?? false

  // ── 数据加载 ──
  const loadStatus = async () => {
    if (!source) return
    try {
      const res = await window.moaAPI.getMonitorStatus(source)
      if (res.success && res.data) setStatus(res.data)
    } catch {
      // 状态读取失败不阻塞页面
    }
  }

  const refresh = async () => {
    if (!source || loading) return
    setLoading(true)
    setError(null)
    setErrorCode(null)
    try {
      const res = await window.moaAPI.monitorRefresh(source)
      if (res.success && res.data) {
        setUsage(res.data as MimoUsage)
        setLastFetchedAt(res.data.fetchedAt)
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

  // 挂载：读取状态；已登录则拉一次数据
  useEffect(() => {
    loadStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId])

  useEffect(() => {
    if (status?.loggedIn && usage == null) {
      refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.loggedIn, usage == null])

  // 自动刷新定时器（经 refreshRef 调用最新 refresh）
  useEffect(() => {
    const minutes = settings.monitoring?.autoRefreshMinutes ?? 0
    if (!autoRefresh || !loggedIn || minutes <= 0) return
    timerRef.current = setInterval(() => {
      refreshRef.current()
    }, minutes * 60_000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, loggedIn, settings.monitoring?.autoRefreshMinutes])

  // ── 动作 ──
  const handleLogin = async () => {
    setLoggingIn(true)
    try {
      const res = await window.moaAPI.monitorLogin(source)
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
    try {
      await window.moaAPI.monitorLogout(sourceId)
    } catch {
      // 忽略
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
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="accent-primary"
            />
            自动刷新（{settings.monitoring?.autoRefreshMinutes ?? 10} 分钟）
          </label>
          <button
            onClick={refresh}
            disabled={loading || !loggedIn}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border bg-card text-foreground hover:bg-accent disabled:opacity-50 transition-colors"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            刷新
          </button>
          {loggedIn ? (
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

      {/* 未登录空态 */}
      {!loggedIn && (
        <div className="rounded-lg border border-border bg-card px-6 py-14 flex flex-col items-center gap-3">
          <p className="text-sm text-muted-foreground">
            尚未登录 Xiaomi MiMo。登录后将展示账户余额与 Token Plan 套餐用量。
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
          {/* 账户余额 */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground mb-2">账户余额</h3>
            {balance ? (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div className="rounded-lg border border-border bg-card px-4 py-3">
                  <div className="text-xs text-muted-foreground mb-1">总余额</div>
                  <div className="text-2xl font-bold tabular-nums text-foreground">
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
            ) : (
              <div className="rounded-lg border border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
                暂无余额数据
              </div>
            )}
          </section>

          {/* Token Plan 套餐 */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground mb-2">Token Plan 套餐</h3>
            <div className="rounded-lg border border-border bg-card divide-y divide-border overflow-hidden">
              {tokenPlan && tokenPlan.items.length > 0 ? (
                tokenPlan.items.map((it) => {
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
                        已用 {fmtYi(it.used)} / 总量 {fmtYi(it.limit)} · 剩余 {fmtYi(Math.max(it.limit - it.used, 0))} Credits
                      </div>
                    </div>
                  )
                })
              ) : (
                <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                  暂无 Token Plan 数据（可能未订阅套餐或接口暂无返回）
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

// ─── 面板：DeepSeek 开放平台用量 ───

function DeepSeekPanel({ source }: { source: RemoteUsageSource }) {
  const settings = useSettingsStore((s) => s.settings)
  const sourceId = source.id

  const [status, setStatus] = useState<MonitorStatus | null>(null)
  const [usage, setUsage] = useState<DeepSeekUsage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<MonitorErrorCode | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)
  const [showApiKeyInput, setShowApiKeyInput] = useState(false)
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // 始终指向最新的 refresh，避免定时器闭包持旧函数
  const refreshRef = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    refreshRef.current = refresh
  })

  const loggedIn = status?.loggedIn ?? false

  // ── 数据加载 ──
  const loadStatus = async () => {
    if (!source) return
    try {
      const res = await window.moaAPI.getMonitorStatus(source)
      if (res.success && res.data) setStatus(res.data)
    } catch {
      // 状态读取失败不阻塞页面
    }
  }

  const refresh = async () => {
    if (!source || loading) return
    setLoading(true)
    setError(null)
    setErrorCode(null)
    try {
      const res = await window.moaAPI.monitorRefresh(source)
      if (res.success && res.data) {
        setUsage(res.data as DeepSeekUsage)
        setLastFetchedAt(res.data.fetchedAt)
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

  // 挂载：读取状态；已登录则拉一次数据
  useEffect(() => {
    loadStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, source])

  useEffect(() => {
    if (status?.loggedIn && usage == null) {
      refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.loggedIn, usage == null])

  // 自动刷新定时器（经 refreshRef 调用最新 refresh）
  useEffect(() => {
    const minutes = settings.monitoring?.autoRefreshMinutes ?? 0
    if (!autoRefresh || !loggedIn || minutes <= 0) return
    timerRef.current = setInterval(() => {
      refreshRef.current()
    }, minutes * 60_000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, loggedIn, settings.monitoring?.autoRefreshMinutes])

  // ── 动作 ──
  const handleLogin = async () => {
    if (!source) return
    setLoggingIn(true)
    try {
      const res = await window.moaAPI.monitorLogin(source)
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
    try {
      await window.moaAPI.monitorLogout(sourceId)
    } catch {
      // 忽略
    }
    setStatus({ loggedIn: false, hasApiKey: false })
    setUsage(null)
    setError(null)
    setErrorCode(null)
  }

  const handleSaveApiKey = async () => {
    if (!apiKeyDraft.trim()) return
    try {
      await window.moaAPI.monitorSetApiKey(sourceId, apiKeyDraft.trim())
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
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="accent-primary"
            />
            自动刷新（{settings.monitoring?.autoRefreshMinutes ?? 10} 分钟）
          </label>
          <button
            onClick={refresh}
            disabled={loading || !loggedIn}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border bg-card text-foreground hover:bg-accent disabled:opacity-50 transition-colors"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            刷新
          </button>
          {loggedIn ? (
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

      {/* 未登录空态 */}
      {!loggedIn && (
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

// ─── 云监控容器：按启用的监控源渲染对应面板 ───

export default function CloudMonitorView() {
  const settings = useSettingsStore((s) => s.settings)
  const sources = settings.monitoring?.sources?.filter((s) => s.enabled) ?? []

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
      {sources.map((src) =>
        src.type === 'mimo' ? (
          <MimoPanel key={src.id} source={src} />
        ) : src.type === 'deepseek' ? (
          <DeepSeekPanel key={src.id} source={src} />
        ) : (
          <CommandCodePanel key={src.id} source={src} />
        )
      )}
    </div>
  )
}