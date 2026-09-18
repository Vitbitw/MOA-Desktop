// UI 广播桥（纯 Node，零 electron 依赖）：主进程业务模块（网关等）向渲染进程推送直播事件的统一出口。
// initUiBridge 由 index.ts 启动时注入既有 safeSendMain；未初始化 / 发送失败一律静默——
// UI 通知属非关键路径，窗口未创建或已销毁不得打断网关执行与记账。
// 设计说明见 .hermes/plans/2026-09-18-moa-live-streaming.md §4.5

import type { SubModelRole } from '../shared/types'

/** 注入的发送器（index.ts 传 safeSendMain；测试可注入收集器） */
let sender: ((channel: string, payload?: unknown) => void) | null = null

/** 启动时注入发送器（重复调用以最后一次为准） */
export function initUiBridge(send: (channel: string, payload?: unknown) => void): void {
  sender = send
}

/** 向渲染进程广播一条事件；未初始化/发送失败静默丢弃（与 safeSendMain 同语义） */
export function broadcastToUi(channel: string, payload?: unknown): void {
  try {
    sender?.(channel, payload)
  } catch {
    // 窗口销毁竞态：通知丢失即为预期结果
  }
}

// ── 网关代理请求直播事件通道 ──
// renderer 监控视图订阅同名通道（值即 IPC 通道名，两端改动需同步；T5 渲染端常量以此为准）

/** 轮次开始（UI 收到即切监控视图） */
export const GATEWAY_ROUND_START = 'gateway:roundStart'
/** 子模型更新（running=累计文本，节流） */
export const GATEWAY_SUB_UPDATE = 'gateway:subUpdate'
/** 聚合开始 */
export const GATEWAY_AGG_START = 'gateway:aggStart'
/** 聚合增量（text=累计全文，节流；done=true 终态） */
export const GATEWAY_AGG_CHUNK = 'gateway:aggChunk'
/** 轮次结束（aborted:true = 客户端断开中止） */
export const GATEWAY_ROUND_DONE = 'gateway:roundDone'

/** 子模型清单项（index 与 GATEWAY_SUB_UPDATE.index 对齐） */
export interface GatewaySubModelRef {
  index: number
  modelId: string
  role: SubModelRole
}

export interface GatewayRoundStartPayload {
  roundId: string
  mode: 'aggregate' | 'compare' | 'direct'
  /** direct 轮次仅第 1 个（实际调用的单模型） */
  subModels: GatewaySubModelRef[]
  /** 聚合模型（compare / direct 无）；仅为身份标注，不含密钥 */
  aggregator?: { modelId: string }
}

/** 密钥/敏感字段不得进入本 payload（网关广播只含模型身份与输出文本） */
export interface GatewaySubUpdatePayload {
  roundId: string
  index: number
  modelId: string
  providerId: string
  content: string
  status: 'running' | 'success' | 'error'
  error?: string
  durationMs?: number
  tokenUsage?: { prompt: number; completion: number }
  role?: SubModelRole
}

export interface GatewayAggStartPayload {
  roundId: string
}

export interface GatewayAggChunkPayload {
  roundId: string
  text: string
  done: boolean
}

export interface GatewayRoundDonePayload {
  roundId: string
  success: boolean
  error?: string
  /** true = 客户端断开（abort 链路触发），success 恒为 false */
  aborted?: boolean
  durationMs: number
}
