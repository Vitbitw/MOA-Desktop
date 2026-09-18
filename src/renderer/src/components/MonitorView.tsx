import React from 'react'
import { useConversationStore } from '../store/conversationStore'
import { useGatewayStore } from '../store/gatewayStore'
import type { GatewayRound } from '../store/gatewayStore'
import SubModelPanel from './SubModelPanel'
import AggregatorPanel from './AggregatorPanel'
import type { LiveSubOutput } from '../store/conversationStore'
import type { MoaArchitecture } from '../../../shared/types'
import { ChevronLeft, ChevronRight } from 'lucide-react'

/** 模式标签（会话视图与代理监视视图共用同一文案） */
function modeLabelOf(mode: string): string {
  return mode === 'aggregate' ? 'A 模式' : mode === 'compare' ? 'D 模式' : '直通'
}

/** 当前 MoA 架构（历史轮次不存架构，统用当前配置文案） */
function useArchitecture(): MoaArchitecture {
  const [architecture, setArchitecture] = React.useState<MoaArchitecture>('election')
  React.useEffect(() => {
    window.moaAPI.getMoaConfig().then((config: any) => {
      if (config?.architecture) setArchitecture(config.architecture)
    })
  }, [])
  return architecture
}

/**
 * 监控视图：展示优先级 —— 网关代理轮次存在且未被 dismiss → 代理监视视图（单槽位）；
 * 否则会话轮次视图（无代理轮次时行为与本改造前完全一致）。
 */
export default function MonitorView() {
  const gatewayRound = useGatewayStore((s) => s.round)
  const gatewayDismissed = useGatewayStore((s) => s.dismissed)

  if (gatewayRound && !gatewayDismissed) {
    return <GatewayMonitorView round={gatewayRound} />
  }
  return <SessionRoundsView showProxyBadge={gatewayRound !== null} />
}

/**
 * 代理监视视图（单槽位：只显示本轮代理请求实时输出；无历史轮次、无翻页器）。
 * dismissed 由用户「返回会话轮次」触发，由外层切换回会话视图。
 */
function GatewayMonitorView({ round }: { round: GatewayRound }) {
  const dismiss = useGatewayStore((s) => s.dismiss)
  const architecture = useArchitecture()

  const status = round.running
    ? { text: '运行中', cls: 'text-blue-500', pulse: true }
    : round.aborted
      ? { text: '已中止（客户端断开）', cls: 'text-red-500', pulse: false }
      : round.success
        ? { text: '已完成', cls: 'text-green-500', pulse: false }
        : { text: '失败', cls: 'text-red-500', pulse: false }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      {/* 头部：身份标签 + 状态 + 返回会话轮次 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-card/50 flex-shrink-0 text-sm">
        <span className="font-semibold text-foreground">代理请求</span>
        <span className="text-muted-foreground/40">|</span>
        <span className="text-muted-foreground">{modeLabelOf(round.mode)}</span>
        <span className="text-muted-foreground/40">|</span>
        <span className="text-muted-foreground">{round.subModels.length} 个子模型</span>
        <span className={`flex items-center gap-1 ${status.cls}`}>
          {status.pulse && <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />}
          {status.text}
        </span>
        <button
          onClick={dismiss}
          className="ml-auto px-3 py-1 text-xs rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          返回会话轮次
        </button>
      </div>

      {/* 失败原因（中止文案在右侧聚合区单独呈现，避免重复） */}
      {!round.running && !round.aborted && !round.success && round.error && (
        <div className="px-4 py-2 text-base text-destructive bg-destructive/10 border-b border-destructive/30">
          {round.error}
        </div>
      )}

      <div className="flex-1 flex flex-row overflow-hidden min-h-0">
        {/* ── LEFT: 子模型输出网格（复用会话视图面板） ── */}
        <div className={`flex-1 overflow-y-auto min-w-0 ${round.mode !== 'compare' ? 'border-r border-border' : ''}`}>
          <div className="p-3">
            <div className="flex items-center gap-2 mb-2 text-sm text-muted-foreground">
              <span className="font-semibold uppercase tracking-wider">子模型输出</span>
              <span className="text-muted-foreground/40">|</span>
              <span>{modeLabelOf(round.mode)}</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {round.subOutputs.map((out) => (
                <SubModelPanel key={`sub-${out.index}`} output={out} />
              ))}
            </div>
          </div>
        </div>

        {/* ── RIGHT: 聚合输出（compare 无；direct 空态；中止提示） ── */}
        {round.mode !== 'compare' && (
          <div className="flex-shrink-0 bg-card flex flex-col overflow-hidden"
            style={{ width: '40%', minWidth: 300, maxWidth: '50%' }}>
            {round.aborted && (
              <div className="px-4 py-2 text-sm text-red-400 bg-red-500/10 border-b border-red-500/30 flex-shrink-0">
                已中止（客户端断开）
              </div>
            )}
            {round.mode === 'direct' ? (
              <div className="flex-1 flex items-center justify-center px-4 text-center text-sm text-muted-foreground">
                直通模式，无聚合输出
              </div>
            ) : (
              <div className="flex-1 min-h-0 flex flex-col">
                <AggregatorPanel
                  content={round.aggText}
                  running={round.aggRunning}
                  mode={round.mode}
                  architecture={architecture}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 会话轮次视图（现状逻辑）；dismissed 后如仍有代理轮次，头部显示回切标记。
 */
function SessionRoundsView({ showProxyBadge }: { showProxyBadge: boolean }) {
  const messages = useConversationStore((s) => s.messages)
  const mode = useConversationStore((s) => s.mode)
  const loading = useConversationStore((s) => s.loading)
  const error = useConversationStore((s) => s.error)
  const liveSubOutputs = useConversationStore((s) => s.liveSubOutputs)
  const aggregatorText = useConversationStore((s) => s.aggregatorText)
  const aggregatorRunning = useConversationStore((s) => s.aggregatorRunning)
  // 代理轮次进行中标记（点击切回代理监视视图）
  const gatewayRunning = useGatewayStore((s) => s.round !== null && s.round.running)
  const restoreGateway = useGatewayStore((s) => s.restore)

  const architecture = useArchitecture()

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
              <span>{modeLabelOf(displayMode)}</span>

              <div className="flex items-center gap-2 ml-auto">
                {/* 代理轮次被 dismiss 后仍有结果/过程：回切监视视图入口（T5） */}
                {showProxyBadge && (
                  <button
                    onClick={restoreGateway}
                    className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-blue-500/40 text-xs text-blue-500 hover:bg-blue-500/10 transition-colors"
                    title="切回代理监视视图"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full bg-blue-500 ${gatewayRunning ? 'animate-pulse' : ''}`} />
                    {gatewayRunning ? '代理请求进行中' : '代理请求已完成'}
                  </button>
                )}

                {/* Round navigation（仅会话视图；代理监视视图无翻页器） */}
                {!hasLive && assistantMessages.length > 1 && (
                  <div className="flex items-center gap-1">
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
                  <span className="text-blue-500 animate-pulse">● 运行中</span>
                )}
              </div>
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
