import React from 'react'
import { useConversationStore } from '../store/conversationStore'
import SubModelPanel from './SubModelPanel'
import AggregatorPanel from './AggregatorPanel'
import type { LiveSubOutput } from '../store/conversationStore'
import type { MoaArchitecture } from '../../../shared/types'
import { ChevronLeft, ChevronRight } from 'lucide-react'

export default function MonitorView() {
  const messages = useConversationStore((s) => s.messages)
  const mode = useConversationStore((s) => s.mode)
  const loading = useConversationStore((s) => s.loading)
  const error = useConversationStore((s) => s.error)
  const liveSubOutputs = useConversationStore((s) => s.liveSubOutputs)
  const aggregatorText = useConversationStore((s) => s.aggregatorText)
  const aggregatorRunning = useConversationStore((s) => s.aggregatorRunning)

  // 当前 MoA 架构（历史轮次不存架构，统用当前配置文案）
  const [architecture, setArchitecture] = React.useState<MoaArchitecture>('election')
  React.useEffect(() => {
    window.moaAPI.getMoaConfig().then((config: any) => {
      if (config?.architecture) setArchitecture(config.architecture)
    })
  }, [])

  const hasLive = liveSubOutputs.length > 0

  // ── Compute rounds from history messages ──
  const assistantMessages = messages.filter((m) => m.role === 'assistant')
  const latestRoundIndex = assistantMessages.length - 1

  const [activeRoundIndex, setActiveRoundIndex] = React.useState(latestRoundIndex)

  // Auto-follow when new rounds appear (history loaded, or new message received)
  React.useEffect(() => {
    if (!hasLive && assistantMessages.length > 0) {
      setActiveRoundIndex(assistantMessages.length - 1)
    }
  }, [assistantMessages.length, hasLive])

  // Get the active round's data
  const activeRound = assistantMessages[activeRoundIndex]
  const historySubOutputs = activeRound?.subModelOutputs || []
  const historyContent = activeRound?.content || ''

  // 展示模式：历史轮次用该轮消息自身的 mode（F7），live 期间用当前聊天模式；
  // 旧数据缺 mode 时回退全局 mode，保持与修复前一致
  const displayMode = !hasLive && activeRound?.mode ? activeRound.mode : mode

  // ── Determine what to display ──
  const displayOutputs: LiveSubOutput[] = hasLive
    ? liveSubOutputs
    : historySubOutputs.length > 0
      ? historySubOutputs.map((o, i) => ({
          index: i,
          modelId: o.modelId,
          providerId: o.providerId,
          content: o.content,
          status: o.status as LiveSubOutput['status'],
          error: o.error,
          durationMs: o.durationMs,
          tokenUsage: o.tokenUsage,
          role: o.role
        }))
      : []

  const displayAggregatorContent = hasLive ? aggregatorText : historyContent

  // Pending grid while loading but no data yet
  const subModelCount = Math.max(displayOutputs.length || 3, 2)

  const canGoPrev = !hasLive && activeRoundIndex > 0
  const canGoNext = !hasLive && activeRoundIndex < latestRoundIndex

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      {/* Error banner */}
      {error && (
        <div className="px-4 py-2 text-base text-destructive bg-destructive/10 border-b border-destructive/30">
          {error}
        </div>
      )}

      {/* ── Horizontal split: sub-models (left) + aggregator (right) ── */}
      <div className="flex-1 flex flex-row overflow-hidden min-h-0">
        {/* ── LEFT: Sub-model output grid ── */}
        <div className={`flex-1 overflow-y-auto min-w-0 ${displayMode !== 'compare' ? 'border-r border-border' : ''}`}>
          <div className="p-3">
            {/* Header bar */}
            <div className="flex items-center gap-2 mb-2 text-sm text-muted-foreground">
              <span className="font-semibold uppercase tracking-wider">子模型输出</span>
              <span className="text-muted-foreground/40">|</span>
              <span>
                {displayMode === 'aggregate' ? 'A 模式' : displayMode === 'compare' ? 'D 模式' : '直通'}
              </span>

              {/* Round navigation */}
              {!hasLive && assistantMessages.length > 1 && (
                <div className="flex items-center gap-1 ml-auto">
                  <button
                    onClick={() => setActiveRoundIndex(activeRoundIndex - 1)}
                    disabled={!canGoPrev}
                    className="p-0.5 rounded hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span className="text-sm tabular-nums">
                    第{activeRoundIndex + 1}/{assistantMessages.length}轮
                  </span>
                  <button
                    onClick={() => setActiveRoundIndex(activeRoundIndex + 1)}
                    disabled={!canGoNext}
                    className="p-0.5 rounded hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              )}

              {hasLive && (
                <span className="text-blue-500 animate-pulse ml-auto">● 运行中</span>
              )}
            </div>

            {/* Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {displayOutputs.length === 0 && !loading && (
                <div className="col-span-full text-sm text-muted-foreground text-center py-12">
                  发送问题后将在此显示各子模型的输出
                </div>
              )}
              {displayOutputs.length === 0 && loading && (
                <>
                  {Array.from({ length: subModelCount }).map((_, i) => (
                    <SubModelPanel
                      key={`pending-${i}`}
                      output={{
                        index: i, modelId: '...', providerId: '',
                        content: '', status: 'pending'
                      }}
                    />
                  ))}
                </>
              )}
              {displayOutputs.map((out) => (
                <SubModelPanel key={`sub-${out.index}`} output={out} />
              ))}
            </div>
          </div>
        </div>

        {/* ── RIGHT: Aggregator output (hidden in compare mode) ── */}
        {displayMode !== 'compare' && (
          <div className="flex-shrink-0 bg-card flex flex-col overflow-hidden"
            style={{ width: '40%', minWidth: 300, maxWidth: '50%' }}>
            <AggregatorPanel
              content={displayAggregatorContent}
              running={aggregatorRunning || (loading && hasLive)}
              mode={displayMode}
              roundLabel={!hasLive && assistantMessages.length > 1
                ? `第${activeRoundIndex + 1}/${assistantMessages.length}轮`
                : undefined
              }
              architecture={architecture}
            />
          </div>
        )}
      </div>
    </div>
  )
}
