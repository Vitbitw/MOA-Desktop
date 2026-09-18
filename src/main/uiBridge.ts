// UI 广播桥（纯 Node，零 electron 依赖）：主进程业务模块（网关等）向渲染进程推送直播事件的统一出口。
// initUiBridge 由 index.ts 启动时注入既有 safeSendMain；未初始化 / 发送失败一律静默——
// UI 通知属非关键路径，窗口未创建或已销毁不得打断网关执行与记账。
// 设计说明见 .hermes/plans/2026-09-18-moa-live-streaming.md §4.5

import { IPC_EVENT } from '../shared/ipc-channels'

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
// 通道字符串单一来源已上移到 ../shared/ipc-channels（IPC_EVENT.GATEWAY_*，与 preload/renderer 共用）；
// 此处仅做别名导出，server.ts 等既有 `from '../uiBridge'` 引用无需改动。

/** 轮次开始（UI 收到即切监控视图） */
export const GATEWAY_ROUND_START = IPC_EVENT.GATEWAY_ROUND_START
/** 子模型更新（running=累计文本，节流） */
export const GATEWAY_SUB_UPDATE = IPC_EVENT.GATEWAY_SUB_UPDATE
/** 聚合开始 */
export const GATEWAY_AGG_START = IPC_EVENT.GATEWAY_AGG_START
/** 聚合增量（text=累计全文，节流；done=true 终态） */
export const GATEWAY_AGG_CHUNK = IPC_EVENT.GATEWAY_AGG_CHUNK
/** 轮次结束（aborted:true = 客户端断开中止） */
export const GATEWAY_ROUND_DONE = IPC_EVENT.GATEWAY_ROUND_DONE

/** payload 类型同源再导出（server.ts 以 `import type ... from '../uiBridge'` 引用） */
export type {
  GatewaySubModelRef,
  GatewayRoundStartPayload,
  GatewaySubUpdatePayload,
  GatewayAggStartPayload,
  GatewayAggChunkPayload,
  GatewayRoundDonePayload
} from '../shared/ipc-channels'
