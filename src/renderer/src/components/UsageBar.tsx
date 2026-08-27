import React from 'react'
import { useEffect, useState } from 'react'
import { useSettingsStore } from '../store/settingsStore'
import { formatCost, formatTokens } from '../lib/usageFormat'
import type { UsageToday } from '../../../shared/types'

interface Props {
  onOpenUsage: () => void
}

export default function UsageBar({ onOpenUsage }: Props) {
  const currency = useSettingsStore((s) => s.settings.currency)
  const [today, setToday] = useState<UsageToday | null>(null)

  const refresh = () => {
    window.moaAPI
      .getUsageToday()
      .then((res) => {
        if (res.success && res.data) setToday(res.data)
      })
      .catch(() => {})
  }

  // 初次拉取 + 监听用量更新事件刷新
  useEffect(() => {
    refresh()
    const unsub = window.moaAPI.onUsageUpdated(refresh)
    return unsub
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cost = today ? formatCost(today.cost, currency) : (currency === 'CNY' ? '¥—' : '$—')

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
