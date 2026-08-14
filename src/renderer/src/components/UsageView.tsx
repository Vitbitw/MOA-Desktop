import React from 'react'
import { useEffect, useState } from 'react'
import { useSettingsStore } from '../store/settingsStore'
import { formatCost, formatTokens } from '../lib/usageFormat'
import type { UsageRange, UsageGroupBy, UsageSummary } from '../../../shared/types'

// ── moaAPI 用量接口（并行任务正在补全 env.d.ts，此处先做本地类型声明过渡）──
const usageApi = window.moaAPI as unknown as {
  getUsageSummary: (params: { range: UsageRange; groupBy: UsageGroupBy }) => Promise<{ success: boolean; data: UsageSummary; error?: string }>
}

const RANGE_TABS: Array<{ value: UsageRange; label: string }> = [
  { value: 'today', label: '今日' },
  { value: 'week', label: '本周' },
  { value: 'month', label: '本月' },
  { value: 'all', label: '全部' },
]

const GROUP_TABS: Array<{ value: UsageGroupBy; label: string }> = [
  { value: 'model', label: '按模型' },
  { value: 'provider', label: '按厂商' },
  { value: 'mode', label: '按模式' },
]

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className="text-lg font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  )
}

export default function UsageView() {
  const currency = useSettingsStore((s) => s.settings.currency)
  const [range, setRange] = useState<UsageRange>('today')
  const [groupBy, setGroupBy] = useState<UsageGroupBy>('model')
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // range / groupBy 变化时重新拉取汇总
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    usageApi
      .getUsageSummary({ range, groupBy })
      .then((res) => {
        if (cancelled) return
        if (res.success && res.data) {
          setSummary(res.data)
        } else {
          setSummary(null)
          setLoadError(res.error || '加载用量数据失败')
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSummary(null)
          setLoadError('加载用量数据失败')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [range, groupBy])

  const totals = summary?.totals
  const totalCost = totals?.cost ?? 0
  const successRate = totals && totals.requests > 0
    ? `${((totals.success / totals.requests) * 100).toFixed(1)}%`
    : '—'
  const rows = summary?.rows ?? []

  return (
    <div className="flex-1 overflow-y-auto p-4">
      {/* 顶部：range Tab + groupBy 切换 */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex items-center gap-1 p-1 rounded-md border border-border bg-card">
          {RANGE_TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => setRange(t.value)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                range === t.value
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 p-1 rounded-md border border-border bg-card">
          {GROUP_TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => setGroupBy(t.value)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                groupBy === t.value
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* 加载错误提示 */}
      {loadError && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {loadError}
        </div>
      )}

      {/* 汇总卡片 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <StatCard label="请求数" value={totals ? String(totals.requests) : '—'} />
        <StatCard label="成功率" value={successRate} />
        <StatCard label="↑ 输入 tokens" value={totals ? formatTokens(totals.prompt) : '—'} />
        <StatCard label="↓ 输出 tokens" value={totals ? formatTokens(totals.completion) : '—'} />
        <StatCard label="总成本" value={totals ? formatCost(totals.cost, currency) : '—'} />
      </div>

      {/* 明细表格 */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border">
              <th className="text-left px-4 py-2 font-medium">归组键</th>
              <th className="text-right px-4 py-2 font-medium">调用次数</th>
              <th className="text-right px-4 py-2 font-medium">成功</th>
              <th className="text-right px-4 py-2 font-medium">↑ 输入</th>
              <th className="text-right px-4 py-2 font-medium">↓ 输出</th>
              <th className="text-right px-4 py-2 font-medium">成本</th>
              <th className="text-right px-4 py-2 font-medium">占比</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-sm text-muted-foreground">
                  {loading
                    ? '加载中…'
                    : totals && totals.requests > 0
                      ? '历史记录缺少模型明细，新的请求将自动统计'
                      : '暂无用量数据，发送消息后开始统计'}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                // 有 token 用量但 cost=0 → 未定价（模型不在价格表）
                const unpriced = row.cost === 0 && (row.prompt > 0 || row.completion > 0)
                const share = totalCost > 0 ? `${((row.cost / totalCost) * 100).toFixed(1)}%` : null
                return (
                  <tr key={row.key} className="border-b border-border/50 last:border-b-0 hover:bg-accent/30">
                    <td className="px-4 py-2 text-foreground">{row.key}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{row.requests}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{row.success}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatTokens(row.prompt)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatTokens(row.completion)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {unpriced ? (
                        <span className="text-muted-foreground">未定价</span>
                      ) : (
                        formatCost(row.cost, currency)
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                      {unpriced || share === null ? '—' : share}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
