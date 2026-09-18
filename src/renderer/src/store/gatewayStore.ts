// 网关代理请求直播状态机（T5）：单槽位监视器语义 —— 只维护当前一轮，新轮次直接替换旧轮，
// 迟到事件（roundId 不匹配当前轮）一律丢弃；无历史列表/无轮次切换。
// 纯状态模块（零 DOM 依赖），可被 test-e2e/gateway-store.cjs 以纯 Node 方式加载测试；
// 事件订阅注册独立导出（initGatewaySubscriptions），仅由 App 挂载时调用。
// 设计说明见 .hermes/plans/2026-09-18-moa-live-streaming.md §4.6 / §4.8

import { create } from 'zustand'
import type { LiveSubOutput } from './conversationStore'
import type {
  GatewayRoundStartPayload,
  GatewaySubUpdatePayload,
  GatewayAggStartPayload,
  GatewayAggChunkPayload,
  GatewayRoundDonePayload,
  GatewaySubModelRef
} from '../../../shared/ipc-channels'

export type GatewayMode = 'aggregate' | 'compare' | 'direct'

/** 当前代理轮次（监视器只保留本轮） */
export interface GatewayRound {
  roundId: string
  mode: GatewayMode
  subModels: GatewaySubModelRef[]
  subOutputs: LiveSubOutput[]
  aggText: string
  aggRunning: boolean
  /** 轮次进行中（roundStart → roundDone 之间） */
  running: boolean
  success?: boolean
  error?: string
  aborted?: boolean
  startedAt: number
  doneAt?: number
}

interface GatewayState {
  round: GatewayRound | null
  /** 用户点「返回会话轮次」后为 true；新 roundStart 重置为 false */
  dismissed: boolean
  handleRoundStart: (payload: GatewayRoundStartPayload) => void
  handleSubUpdate: (payload: GatewaySubUpdatePayload) => void
  handleAggStart: (payload: GatewayAggStartPayload) => void
  handleAggChunk: (payload: GatewayAggChunkPayload) => void
  handleRoundDone: (payload: GatewayRoundDonePayload) => void
  /** 返回会话轮次（隐藏代理监视视图；轮次本身继续进行，不受影响） */
  dismiss: () => void
  /** 切回代理监视视图 */
  restore: () => void
}

/** 迟到事件判定：无当前轮 / roundId 不匹配 → 丢弃 */
function isCurrent(round: GatewayRound | null, roundId: string): round is GatewayRound {
  return round !== null && round.roundId === roundId
}

/**
 * 子模型更新合并：payload 必带字段整体覆盖（累计文本语义）；
 * 可选字段仅在显式出现时覆盖 —— running 更新不带 role 时不抹掉占位阶段清单里的角色。
 */
function mergeSubUpdate(output: LiveSubOutput, p: GatewaySubUpdatePayload): LiveSubOutput {
  const next: LiveSubOutput = {
    index: output.index,
    modelId: p.modelId,
    providerId: p.providerId,
    content: p.content,
    status: p.status,
    role: p.role !== undefined ? p.role : output.role
  }
  if (p.error !== undefined) next.error = p.error
  if (p.durationMs !== undefined) next.durationMs = p.durationMs
  if (p.tokenUsage !== undefined) next.tokenUsage = p.tokenUsage
  return next
}

/** 由 subUpdate 构造新面板（roundStart 清单未覆盖该 index 时的兜底插入） */
function subOutputOf(p: GatewaySubUpdatePayload): LiveSubOutput {
  const out: LiveSubOutput = {
    index: p.index,
    modelId: p.modelId,
    providerId: p.providerId,
    content: p.content,
    status: p.status,
    role: p.role
  }
  if (p.error !== undefined) out.error = p.error
  if (p.durationMs !== undefined) out.durationMs = p.durationMs
  if (p.tokenUsage !== undefined) out.tokenUsage = p.tokenUsage
  return out
}

export const useGatewayStore = create<GatewayState>((set, get) => ({
  round: null,
  dismissed: false,

  // 轮次开始：新轮次直接替换槽位（单槽位监视器）；按清单生成 pending 占位并按 index 排序
  handleRoundStart: (payload) => {
    const subModels = payload.subModels || []
    set({
      round: {
        roundId: payload.roundId,
        mode: payload.mode,
        subModels,
        subOutputs: subModels
          .map((m) => ({
            index: m.index,
            modelId: m.modelId,
            providerId: '',
            content: '',
            status: 'pending' as const,
            role: m.role
          }))
          .sort((a, b) => a.index - b.index),
        aggText: '',
        aggRunning: false,
        running: true,
        startedAt: Date.now()
      },
      dismissed: false
    })
  },

  // 子模型更新：仅当前轮；已有 index 合并更新，无则按 index 升序插入（乱序到达不串位）
  handleSubUpdate: (p) => {
    const round = get().round
    if (!isCurrent(round, p.roundId)) return
    const subOutputs = round.subOutputs.some((o) => o.index === p.index)
      ? round.subOutputs.map((o) => (o.index === p.index ? mergeSubUpdate(o, p) : o))
      : [...round.subOutputs, subOutputOf(p)].sort((a, b) => a.index - b.index)
    set({ round: { ...round, subOutputs } })
  },

  handleAggStart: (p) => {
    const round = get().round
    if (!isCurrent(round, p.roundId)) return
    set({ round: { ...round, aggRunning: true } })
  },

  // 聚合累计文本覆盖（节流后仍为全量）；done=true 即终态
  handleAggChunk: (p) => {
    const round = get().round
    if (!isCurrent(round, p.roundId)) return
    set({ round: { ...round, aggText: p.text, aggRunning: !p.done } })
  },

  // 轮次结束：running 收口；成功/错误/中止终态与 doneAt 落位；
  // aggRunning 一并归零（聚合中途中止时 done 终态帧可能随断开缺席，避免「生成中」永挂）
  handleRoundDone: (p) => {
    const round = get().round
    if (!isCurrent(round, p.roundId)) return
    set({
      round: {
        ...round,
        running: false,
        aggRunning: false,
        success: p.success,
        error: p.error,
        aborted: p.aborted === true,
        doneAt: Date.now()
      }
    })
  },

  dismiss: () => set({ dismissed: true }),
  restore: () => set({ dismissed: false })
}))

// ── 事件订阅注册（仅 App 调用；与 store 定义分离，便于纯 Node 测试只加载状态机） ──

/**
 * 订阅 5 个网关事件 → store（App 挂载时注册一次）。
 * onRoundStart 可选回调：App 用它实现「新代理轮次自动切监控视图」（不锁定，用户可手动切走）。
 * 返回统一解绑函数；window.moaAPI 缺失（纯 Node 环境）时返回空解绑。
 */
export function initGatewaySubscriptions(onRoundStart?: () => void): () => void {
  const api = typeof window !== 'undefined' ? window.moaAPI : undefined
  if (!api) return () => {}
  const unsubs: (() => void)[] = []

  if (api.onGatewayRoundStart) {
    unsubs.push(api.onGatewayRoundStart((data) => {
      useGatewayStore.getState().handleRoundStart(data)
      onRoundStart?.()
    }))
  }
  if (api.onGatewaySubUpdate) {
    unsubs.push(api.onGatewaySubUpdate((data) => useGatewayStore.getState().handleSubUpdate(data)))
  }
  if (api.onGatewayAggStart) {
    unsubs.push(api.onGatewayAggStart((data) => useGatewayStore.getState().handleAggStart(data)))
  }
  if (api.onGatewayAggChunk) {
    unsubs.push(api.onGatewayAggChunk((data) => useGatewayStore.getState().handleAggChunk(data)))
  }
  if (api.onGatewayRoundDone) {
    unsubs.push(api.onGatewayRoundDone((data) => useGatewayStore.getState().handleRoundDone(data)))
  }

  return () => {
    unsubs.forEach((fn) => fn())
    unsubs.length = 0
  }
}
