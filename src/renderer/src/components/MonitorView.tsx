import React from 'react'
import { useConversationStore } from '../store/conversationStore'
import SubModelPanel from './SubModelPanel'
import AggregatorPanel from './AggregatorPanel'
import type { LiveSubOutput } from '../store/conversationStore'

export default function MonitorView() {
  const messages = useConversationStore((s) => s.messages)
  const mode = useConversationStore((s) => s.mode)
  const loading = useConversationStore((s) => s.loading)
  const error = useConversationStore((s) => s.error)
  const liveSubOutputs = useConversationStore((s) => s.liveSubOutputs)
  const aggregatorText = useConversationStore((s) => s.aggregatorText)
  const aggregatorRunning = useConversationStore((s) => s.aggregatorRunning)

  // History replay: use last assistant message's sub-model outputs
  const lastAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant')
  const historySubOutputs = lastAssistantMsg?.subModelOutputs || []

  // Determine which outputs to display
  const displayOutputs: LiveSubOutput[] = liveSubOutputs.length > 0
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

  const displayAggregatorContent = aggregatorText || lastAssistantMsg?.content || ''

  // Sub-model count for pending grid
  const subModelCount = Math.max(displayOutputs.length, 3)

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      {/* ── Error banner ── */}
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
            {loading && displayOutputs.length === 0 && (
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
          running={aggregatorRunning || loading}
          mode={mode}
        />
      </div>
    </div>
  )
}
