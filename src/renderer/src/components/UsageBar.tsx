import React from 'react'
import { useEffect, useState } from 'react'
import { useSettingsStore } from '../store/settingsStore'
import type { UsageToday } from '../../../shared/types'

// ── moaAPI 用量接口（并行任务正在补全 env.d.ts，此处先做本地类型声明过渡）──
const usageApi = window.moaAPI as unknown as {
  getUsageToday: () => Promise<{ success: boolean; data: UsageToday; error?: string }>
  onUsageUpdated: (cb: () => void) => () => void
}

// tokens 缩写：>=1000 显示 x.xk
function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

interface Props {
  onOpenUsage: () => void
}

export default function UsageBar({ onOpenUsage }: Props) {
  const currency = useSettingsStore((s) => s.settings.currency)
  const [today, setToday] = useState<UsageToday | null>(null)

  const refresh = () => {
    usageApi
      .getUsageToday()
      .then((res) => {
        if (res.success && res.data) setToday(res.data)
      })
      .catch(() => {})
  }

  // 初次拉取 + 监听用量更新事件刷新
  useEffect(() => {
    refresh()
    const unsub = usageApi.onUsageUpdated(refresh)
    return unsub
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const rate = currency === 'CNY' ? 7.2 : 1
  const symbol = currency === 'CNY' ? '¥' : '$'
  const cost = today ? `${symbol}${(today.cost * rate).toFixed(2)}` : `${symbol}—`

  return (
    <button
      onClick={onOpenUsage}
      title="查看用量统计"
      className="flex items-center gap-2 w-full h-7 px-4 bg-muted/50 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors flex-shrink-0"
    >
      {today?.running && <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse flex-shrink-0" />}
      <span>今日</span>
      <span className="tabular-nums">↑{today ? formatTokens(today.prompt) : '—'}</span>
      <span className="tabular-nums">↓{today ? formatTokens(today.completion) : '—'}</span>
      <span className="tabular-nums ml-auto">{cost}</span>
    </button>
  )
}
