import React from 'react'
import { useConversationStore } from '../store/conversationStore'
import SubModelPanel from './SubModelPanel'
import AggregatorPanel from './AggregatorPanel'
import type { LiveSubOutput } from '../store/conversationStore'
import { ChevronLeft, ChevronRight } from 'lucide-react'

export default function MonitorView() {
  const messages = useConversationStore((s) => s.messages)
  const mode = useConversationStore((s) => s.mode)
  const loading = useConversationStore((s) => s.loading)
  const error = useConversationStore((s) => s.error)
  const liveSubOutputs = useConversationStore((s) => s.liveSubOutputs)
  const aggregatorText = useConversationStore((s) => s.aggregatorText)
  const aggregatorRunning = useConversationStore((s) => s.aggregatorRunning)

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
          tokenUsage: o.tokenUsage
        }))
      : []

  const displayAggregatorContent = hasLive ? aggregatorText : historyContent

  // Pending grid while loading but no data yet
  const subModelCount = Math.max(displayOutputs.length || assistantMessages.length > 0 ? displayOutputs.length : 3, 2)

  const canGoPrev = !hasLive && activeRoundIndex > 0
  const canGoNext = !hasLive && activeRoundIndex < latestRoundIndex

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      {/* Error banner */}
      {error && (
        <div className="px-4 py-2 text-sm text-destructive bg-destructive/10 border-b border-destructive/30">
          {error}
        </div>
      )}

      {/* ── TOP: Sub-model output grid ── */}
      <div className="flex-1 overflow-y-auto border-b border-border min-h-0">
        <div className="p-3">
          {/* Header bar */}
          <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
            <span className="font-semibold uppercase tracking-wider">Sub-Model Outputs</span>
            <span className="text-muted-foreground/40">|</span>
            <span>
              {mode === 'aggregate' ? 'A Mode' : mode === 'compare' ? 'D Mode' : 'Direct'}
            </span>

            {/* Round navigation */}
            {!hasLive && assistantMessages.length > 1 && (
              <div className="flex items-center gap-1 ml-auto">
                <button
                  onClick={() => setActiveRoundIndex(activeRoundIndex - 1)}
                  disabled={!canGoPrev}
                  className="p-0.5 rounded hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <span className="text-xs tabular-nums">
                  Round {activeRoundIndex + 1}/{assistantMessages.length}
                </span>
                <button
                  onClick={() => setActiveRoundIndex(activeRoundIndex + 1)}
                  disabled={!canGoNext}
                  className="p-0.5 rounded hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {hasLive && (
              <span className="text-blue-500 animate-pulse ml-auto">● Running</span>
            )}
          </div>

          {/* Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {displayOutputs.length === 0 && !loading && (
              <div className="col-span-full text-xs text-muted-foreground text-center py-12">
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

      {/* ── BOTTOM: Aggregator output ── */}
      <div className="flex-shrink-0 bg-card border-t border-border"
        style={{ height: '35%', minHeight: '160px', maxHeight: '50%' }}>
        <AggregatorPanel
          content={displayAggregatorContent}
          running={aggregatorRunning || (loading && hasLive)}
          mode={mode}
          roundLabel={!hasLive && assistantMessages.length > 1
            ? `Round ${activeRoundIndex + 1}/${assistantMessages.length}`
            : undefined
          }
        />
      </div>
    </div>
  )
}
