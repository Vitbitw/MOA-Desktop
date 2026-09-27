import type { SubModelRole } from './types'

export const IPC = {
  // Config / Providers
  CONFIG_GET_PROVIDERS: 'config:getProviders',
  CONFIG_ADD_PROVIDER: 'config:addProvider',
  CONFIG_REMOVE_PROVIDER: 'config:removeProvider',
  CONFIG_GET_MODELS: 'config:getModels',
  /** 编辑厂商来源级字段（名称 / API 地址；仅传入字段更新） */
  PROVIDERS_UPDATE: 'providers:update',
  /** 改某账号的 API 密钥（入参为 accountId） */
  PROVIDERS_UPDATE_KEY: 'providers:updateKey',
  /** 新增厂商账号（同来源可无限添加；新账号不自动成为当前账号） */
  PROVIDERS_ADD_ACCOUNT: 'providers:addAccount',
  /** 编辑厂商账号（备注名 / 计费通道 / Plan 三件套；仅传入字段更新） */
  PROVIDERS_UPDATE_ACCOUNT: 'providers:updateAccount',
  /** 删除厂商账号（来源至少保留一个账号；删当前账号会自动接任下一个） */
  PROVIDERS_REMOVE_ACCOUNT: 'providers:removeAccount',
  /** 切换来源的当前账号：此后该来源的调用与成本记账都用它 */
  PROVIDERS_SET_ACTIVE_ACCOUNT: 'providers:setActiveAccount',

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
  // 主席团专家团生成（AI 规划专家）
  MOA_GENERATE_EXPERTS: 'moa:generateExperts',

  // MoA Execution
  MOA_SEND_MESSAGE: 'moa:sendMessage',

  // Title
  TITLE_GENERATE: 'title:generate',
  DB_UPDATE_CONVERSATION_TITLE: 'db:updateConversationTitle',

  // Usage Monitoring
  USAGE_GET_SUMMARY: 'usage:getSummary',
  USAGE_GET_TODAY: 'usage:getToday',

  // Cloud Usage Monitoring
  // 入参一律是 **accountId**（不是 sourceId）：主进程按账号解析所属源，
  // 凭据 / 快照 / 本地累计全部按账号读写，杜绝同源不同账号串号
  MONITOR_GET_STATUS: 'monitor:getStatus',
  MONITOR_LOGIN: 'monitor:login',
  MONITOR_LOGOUT: 'monitor:logout',
  MONITOR_SET_API_KEY: 'monitor:setApiKey',
  MONITOR_REFRESH: 'monitor:refresh',
  MONITOR_GET_CUMULATIVE: 'monitor:getCumulative',
  MONITOR_COLLECTOR_STATUS: 'monitor:collectorStatus',
  MONITOR_GET_SNAPSHOT: 'monitor:getSnapshot',

  // Pricing Probe
  PRICING_PROBE_RUN: 'pricing:probeRun',
  /** 查询当前探查运行状态（渲染进程挂载时同步，覆盖订阅注册前已开始的后台自动刷新） */
  PRICING_PROBE_STATUS: 'pricing:probeStatus',
} as const

export const IPC_EVENT = {
  MOA_SUB_OUTPUT_UPDATE: 'moa:subOutputUpdate',
  MOA_AGGREGATION_START: 'moa:aggregationStart',
  MOA_AGGREGATION_CHUNK: 'moa:aggregationChunk',
  MOA_ALL_DONE: 'moa:allDone',

  // 定价探查进度
  PRICING_PROBE_PROGRESS: 'pricing:probeProgress',
  // 定价探查运行状态变更（开始/结束；手动与后台自动刷新共用，UI 据此显示「正在刷新」）
  PRICING_PROBE_STATE: 'pricing:probeState',

  // 厂商模型列表变更（主进程 /models 拉取后广播：定价探查 fetchModelsBeforeProbe 与手动「获取模型列表」共用）
  // 渲染进程据此重拉 providers，设置页厂商卡片 / 定价源模型列表实时同步
  CONFIG_PROVIDERS_CHANGED: 'config:providersChanged',

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
  /** 专家名（AI 生成专家团；旧配置缺省） */
  expertName?: string
}

export interface GatewayRoundStartPayload {
  roundId: string
  /** MoA 聚合轮固定 'aggregate'；'direct' = 未配置子模型时的单模型透传兜底轮（模式不可配置） */
  mode: 'aggregate' | 'direct'
  /** 透传兜底轮仅第 1 个（实际调用的单模型） */
  subModels: GatewaySubModelRef[]
  /** 聚合模型（透传兜底轮无）；仅为身份标注，不含密钥 */
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
  /** 专家名（AI 生成专家团；旧配置缺省） */
  expertName?: string
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
