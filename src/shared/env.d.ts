import type { SubOutputUpdate, AggregationChunk, UsageSummary, UsageRange, UsageGroupBy, UsageToday, RemoteUsageSource, MonitorUsage, MonitorStatus, MonitorErrorCode, CumulativeModelUsage, PricingProbeResultItem, PricingProbeSource, PricingProbeState, ProbeProgressEvent, ExpertGenResult, GenerateExpertsRequest, ToastData } from './types'
import type { GatewayRoundStartPayload, GatewaySubUpdatePayload, GatewayAggStartPayload, GatewayAggChunkPayload, GatewayRoundDonePayload } from './ipc-channels'

interface MoaAPI {
  // Config / Providers
  getProviders: () => Promise<{ success: boolean; data: unknown; error?: string }>
  addProvider: (data: { name: string; baseUrl: string; apiKey: string }) => Promise<{ success: boolean; data: unknown; error?: string }>
  removeProvider: (id: string) => Promise<{ success: boolean; error?: string }>
  getModels: (providerId: string) => Promise<{ success: boolean; data: unknown; error?: string }>

  // Conversations
  getConversations: () => Promise<{ success: boolean; data: unknown; error?: string }>
  deleteConversation: (id: string) => Promise<{ success: boolean; error?: string }>
  getMessages: (conversationId: string) => Promise<{ success: boolean; data: unknown; error?: string }>

  // Settings
  getSettings: () => Promise<{ success: boolean; data: unknown; error?: string }>
  setSetting: (key: string, value: unknown) => Promise<{ success: boolean; error?: string }>

  // MoA Config
  getMoaConfig: () => Promise<unknown>
  setMoaConfig: (config: unknown) => unknown

  // 主席团专家团生成（AI 规划专家）
  generateExperts: (req: GenerateExpertsRequest) =>
    Promise<{ success: boolean; data?: ExpertGenResult; error?: string }>

  // MoA Send
  sendMessage: (msg: { conversationId?: string; title?: string; content: string; mode: string }) =>
    Promise<{ success: boolean; data?: unknown; error?: string }>

  // Title
  updateConversationTitle: (conversationId: string, title: string, titleEdited?: boolean) =>
    Promise<{ success: boolean; conversations?: unknown[]; error?: string }>
  generateTitle: (data: {
    conversationId: string
    messages: Array<{ role: string; content: string }>
    providerId: string
    modelId: string
    maxLength: number
    language: 'auto' | 'zh' | 'en'
  }) => Promise<{ success: boolean; title?: string; error?: string }>

  // Usage Monitoring
  getUsageSummary: (params: { range: UsageRange; groupBy: UsageGroupBy }) =>
    Promise<{ success: boolean; data: UsageSummary; error?: string }>
  getUsageToday: () => Promise<{ success: boolean; data: UsageToday; error?: string }>

  // Cloud Usage Monitoring (Command Code)
  getMonitorStatus: (source: RemoteUsageSource) =>
    Promise<{ success: boolean; data: MonitorStatus; error?: string }>
  monitorLogin: (source: RemoteUsageSource) =>
    Promise<{ success: boolean; data: { success: boolean; cancelled?: boolean; error?: string }; error?: string }>
  monitorLogout: (sourceId: string) => Promise<{ success: boolean; error?: string }>
  monitorSetApiKey: (sourceId: string, apiKey: string) => Promise<{ success: boolean; error?: string }>
  monitorRefresh: (source: RemoteUsageSource) =>
    Promise<{ success: boolean; data?: MonitorUsage; error?: string; code?: MonitorErrorCode }>
  /** 本地累计的按模型用量（Command Code；由多次采集去重累积） */
  monitorGetCumulative: (sourceId: string) =>
    Promise<{ success: boolean; data?: CumulativeModelUsage; error?: string }>
  /** 后台采集器状态（是否在采集 / 间隔 / 上次采集时间 / 上次错误） */
  monitorCollectorStatus: () => Promise<{
    success: boolean
    data?: { enabled: boolean; intervalMinutes: number; lastCollectedAt: number; lastError: string | null; running: boolean }
    error?: string
  }>
  /** 上次会话持久化的用量快照（应用重启后先渲染它，再按统一自动刷新间隔决定是否刷新）；无快照时 data 为 null */
  monitorGetSnapshot: (sourceId: string) => Promise<{ success: boolean; data?: MonitorUsage | null; error?: string }>

  // Pricing Probe
  probePricing: (sources: PricingProbeSource[], force?: boolean) =>
    Promise<{ success: boolean; data?: { results: PricingProbeResultItem[] }; error?: string }>
  /** 当前探查运行状态（挂载时同步，覆盖订阅注册前已开始的后台自动刷新） */
  getProbeStatus: () => Promise<{ success: boolean; data?: PricingProbeState; error?: string }>
  onProbeProgress: (callback: (data: ProbeProgressEvent) => void) => () => void
  /** 探查运行状态变更（开始/结束；手动与后台自动刷新共用） */
  onProbeState: (callback: (data: PricingProbeState) => void) => () => void

  /** 厂商模型列表变更（/models 拉取后主进程广播）→ 重拉 providers 同步 UI */
  onProvidersChanged: (callback: (data: { providerId: string }) => void) => () => void

  // MoA Event Listeners (streaming)
  onSubOutputUpdate: (callback: (data: SubOutputUpdate) => void) => () => void
  onAggregationStart: (callback: () => void) => () => void
  onAggregationChunk: (callback: (data: AggregationChunk) => void) => () => void
  onAllDone: (callback: (data: { conversationId: string; conversations: unknown[] }) => void) => () => void

  // 网关代理请求直播事件（T5）
  onGatewayRoundStart: (callback: (data: GatewayRoundStartPayload) => void) => () => void
  onGatewaySubUpdate: (callback: (data: GatewaySubUpdatePayload) => void) => () => void
  onGatewayAggStart: (callback: (data: GatewayAggStartPayload) => void) => () => void
  onGatewayAggChunk: (callback: (data: GatewayAggChunkPayload) => void) => () => void
  onGatewayRoundDone: (callback: (data: GatewayRoundDonePayload) => void) => () => void

  // Menu event listeners
  onMenuNewConversation: (callback: () => void) => () => void
  onMenuCopyGatewayUrl: (callback: (url: string) => void) => () => void
  onMenuOpenSettings: (callback: () => void) => () => void

  // 用量悬浮窗右键「打开用量页」
  onUsageOpen: (callback: () => void) => () => void

  // Title event listeners
  onTitleUpdated: (callback: (data: { conversationId: string; title: string; conversations: unknown[] }) => void) => () => void

  // Usage event listeners
  onUsageUpdated: (callback: () => void) => () => void

  // 主进程 → 渲染进程悬浮通知
  onRendererToast: (callback: (data: ToastData) => void) => () => void
}

declare global {
  interface Window {
    moaAPI: MoaAPI
  }
}

// Make this a module so declare global works in bundler mode
export {}
