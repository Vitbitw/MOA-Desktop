import React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../store/settingsStore'
import { formatCost } from '../lib/usageFormat'
import { ExternalLink, KeyRound, Loader2, LogOut, RefreshCw } from 'lucide-react'
import type {
  CommandCodeUsage,
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

// ─── 主组件 ───

export default function CloudMonitorView() {
  const settings = useSettingsStore((s) => s.settings)
  const currency = settings.currency
  const source: RemoteUsageSource | undefined = settings.monitoring?.sources?.find((s) => s.enabled)
  const sourceId = source?.id ?? ''

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
    if (!sourceId) return
    try {
      const res = await window.moaAPI.getMonitorStatus(sourceId)
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
        setUsage(res.data)
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
  if (!source) {
    return (
      <div className="flex-1 overflow-y-auto p-4">
        <div className="rounded-lg border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
          未配置云端用量监控源，请先在设置中添加
        </div>
      </div>
    )
  }

  const windowsAvailable = usage?.sourcesAvailable.windows ?? false
  const summary = usage?.summary
  const credits = usage?.credits
  const models = usage?.models ?? []

  return (
    <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
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