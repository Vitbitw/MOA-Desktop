import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import './usage.css'
import type { UsageToday } from '../../../shared/types'

// ── 桌面用量悬浮窗（极简数字徽章）──
// 两行显示：今日 ↑/↓/$、总计 ↑/↓/$；running 时左上角显示蓝色脉冲点；
// 整窗可拖动（-webkit-app-region: drag）；右键菜单由主进程提供。
// 数据策略：主进程广播 USAGE_UPDATED（无参信号）后自行重新拉取数据。

// tokens 缩写：>=1000 显示 x.xk
function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

interface OverlayState {
  today: UsageToday | null
  total: UsageToday | null
}

function UsageOverlay() {
  const [state, setState] = useState<OverlayState>({ today: null, total: null })
  const [currency, setCurrency] = useState<'USD' | 'CNY'>('USD')

  const refresh = () => {
    window.moaAPI.getUsageToday().then((res) => {
      if (res.success && res.data) setState((s) => ({ ...s, today: res.data }))
    })
    // 总计 = 全部时间范围汇总 totals
    window.moaAPI.getUsageSummary({ range: 'all', groupBy: 'model' }).then((res) => {
      if (res.success && res.data) {
        const t = res.data.totals
        setState((s) => ({
          ...s,
          total: { prompt: t.prompt, completion: t.completion, cost: t.cost, running: false }
        }))
      }
    })
  }

  useEffect(() => {
    // 读取货币设置（CNY ×7.2 显示 ¥）
    window.moaAPI.getSettings().then((res) => {
      const s = res.data as { currency?: 'USD' | 'CNY' } | null
      if (s?.currency) setCurrency(s.currency)
    })
    refresh()
    const unsub = window.moaAPI.onUsageUpdated(refresh)
    return unsub
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const rate = currency === 'CNY' ? 7.2 : 1
  const symbol = currency === 'CNY' ? '¥' : '$'
  const fmtCost = (c: number | undefined) => `${symbol}${((c ?? 0) * rate).toFixed(2)}`

  return (
    <div
      className="relative flex h-full w-full select-none flex-col justify-center rounded-lg border border-white/10 bg-black/50 px-1 py-1.5 pl-1.5 font-mono text-[9.5px] leading-none text-white"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* running 脉冲点（第一行前缀） */}
      {state.today?.running && (
        <span className="absolute left-1 top-1 h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
      )}

      {/* 今日 */}
      <div className="flex items-baseline gap-[2px] whitespace-nowrap">
        <span className="text-white/60">今日</span>
        <span className="tabular-nums">↑{state.today ? formatTokens(state.today.prompt) : '—'}</span>
        <span className="tabular-nums">↓{state.today ? formatTokens(state.today.completion) : '—'}</span>
      </div>
      <div className="text-right tabular-nums text-white/70">
        {state.today ? fmtCost(state.today.cost) : `${symbol}—`}
      </div>

      {/* 总计 */}
      <div className="mt-1 flex items-baseline gap-[2px] whitespace-nowrap">
        <span className="text-white/60">总计</span>
        <span className="tabular-nums">↑{state.total ? formatTokens(state.total.prompt) : '—'}</span>
        <span className="tabular-nums">↓{state.total ? formatTokens(state.total.completion) : '—'}</span>
      </div>
      <div className="text-right tabular-nums text-white/70">
        {state.total ? fmtCost(state.total.cost) : `${symbol}—`}
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <UsageOverlay />
  </React.StrictMode>
)
