import type { SubModelRole } from './types'

export const IPC = {
  // Config / Providers
  CONFIG_GET_PROVIDERS: 'config:getProviders',
  CONFIG_ADD_PROVIDER: 'config:addProvider',
  CONFIG_REMOVE_PROVIDER: 'config:removeProvider',
  CONFIG_GET_MODELS: 'config:getModels',

  // Conversations
  DB_GET_CONVERSATIONS: 'db:getConversations',
  DB_DELETE_CONVERSATION: 'db:deleteConversation',
  DB_GET_MESSAGES: 'db:getMessages',

  // Settings
  SETTINGS_GET_ALL: 'settings:getAll',
  SETTINGS_SET: 'settings:set',

  // MoA Config
  MOA_GET_CONFIG: 'moa:getConfig',
  MOA_SET_CONFIG: 'moa:setConfig',

  // MoA Execution
  MOA_SEND_MESSAGE: 'moa:sendMessage',

  // Title
  TITLE_GENERATE: 'title:generate',
  DB_UPDATE_CONVERSATION_TITLE: 'db:updateConversationTitle',

  // Usage Monitoring
  USAGE_GET_SUMMARY: 'usage:getSummary',
  USAGE_GET_TODAY: 'usage:getToday',

  // Cloud Usage Monitoring
  MONITOR_GET_STATUS: 'monitor:getStatus',
  MONITOR_LOGIN: 'monitor:login',
  MONITOR_LOGOUT: 'monitor:logout',
  MONITOR_SET_API_KEY: 'monitor:setApiKey',
  MONITOR_REFRESH: 'monitor:refresh',
  MONITOR_GET_CUMULATIVE: 'monitor:getCumulative',
  MONITOR_COLLECTOR_STATUS: 'monitor:collectorStatus',

  // Pricing Probe
  PRICING_PROBE_RUN: 'pricing:probeRun',
} as const

export const IPC_EVENT = {
  MOA_SUB_OUTPUT_UPDATE: 'moa:subOutputUpdate',
  MOA_AGGREGATION_START: 'moa:aggregationStart',
  MOA_AGGREGATION_CHUNK: 'moa:aggregationChunk',
  MOA_ALL_DONE: 'moa:allDone',

  // 定价探查进度
  PRICING_PROBE_PROGRESS: 'pricing:probeProgress',

  // Menu events
  MENU_NEW_CONVERSATION: 'menu:newConversation',
  MENU_COPY_GATEWAY_URL: 'menu:copyGatewayUrl',
  MENU_OPEN_SETTINGS: 'menu:openSettings',

  // 用量悬浮窗右键「打开用量页」→ 主窗口切换到用量视图
  USAGE_OPEN: 'usage:open',

  // Title events
  TITLE_UPDATED: 'title:updated',

  // Usage events
  USAGE_UPDATED: 'usage:updated',

  // 主进程 → 渲染进程悬浮通知
  RENDERER_TOAST: 'event:rendererToast',

  // 网关代理请求直播（单一来源：main/uiBridge 广播 → preload/renderer 监控视图订阅；
  // 两端均引用本常量，禁止再写字面量副本）
  GATEWAY_ROUND_START: 'gateway:roundStart',
  GATEWAY_SUB_UPDATE: 'gateway:subUpdate',
  GATEWAY_AGG_START: 'gateway:aggStart',
  GATEWAY_AGG_CHUNK: 'gateway:aggChunk',
  GATEWAY_ROUND_DONE: 'gateway:roundDone',
} as const

export type IPCChannel = (typeof IPC)[keyof typeof IPC]

// ─── 网关代理请求直播事件 payload（main ↔ renderer 共用） ───
// 密钥/敏感字段不得进入这些 payload（只含模型身份与输出文本）

/** 子模型清单项（index 与 GatewaySubUpdatePayload.index 对齐） */
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
