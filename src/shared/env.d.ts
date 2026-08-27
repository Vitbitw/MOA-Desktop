import type { SubOutputUpdate, AggregationChunk, UsageSummary, UsageRange, UsageGroupBy, UsageToday, RemoteUsageSource, CommandCodeUsage, MonitorStatus, MonitorErrorCode } from './types'

interface MoaAPI {
  // Config / Providers
  getProviders: () => Promise<{ success: boolean; data: unknown; error?: string }>
  addProvider: (data: { name: string; baseUrl: string; apiKey: string }) => Promise<{ success: boolean; data: unknown; error?: string }>
  removeProvider: (id: string) => Promise<{ success: boolean; error?: string }>
  getModels: (providerId: string) => Promise<{ success: boolean; data: unknown; error?: string }>

  // Conversations
  getConversations: () => Promise<{ success: boolean; data: unknown; error?: string }>
  createConversation: (data: { title: string; mode: string }) => Promise<{ success: boolean; data: unknown; error?: string }>
  deleteConversation: (id: string) => Promise<{ success: boolean; error?: string }>
  getMessages: (conversationId: string) => Promise<{ success: boolean; data: unknown; error?: string }>
  addMessage: (msg: { conversationId: string; role: string; content: string; mode: string }) => Promise<{ success: boolean; data: unknown; error?: string }>

  // Settings
  getSettings: () => Promise<{ success: boolean; data: unknown; error?: string }>
  setSetting: (key: string, value: unknown) => Promise<{ success: boolean; error?: string }>

  // MoA Config
  getMoaConfig: () => Promise<unknown>
  setMoaConfig: (config: unknown) => unknown

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

  // App
  getVersion: () => Promise<string>

  // Usage Monitoring
  getUsageSummary: (params: { range: UsageRange; groupBy: UsageGroupBy }) =>
    Promise<{ success: boolean; data: UsageSummary; error?: string }>
  getUsageToday: () => Promise<{ success: boolean; data: UsageToday; error?: string }>

  // Cloud Usage Monitoring (Command Code)
  getMonitorStatus: (sourceId: string) =>
    Promise<{ success: boolean; data: MonitorStatus; error?: string }>
  monitorLogin: (source: RemoteUsageSource) =>
    Promise<{ success: boolean; data: { success: boolean; cancelled?: boolean; error?: string }; error?: string }>
  monitorLogout: (sourceId: string) => Promise<{ success: boolean; error?: string }>
  monitorSetApiKey: (sourceId: string, apiKey: string) => Promise<{ success: boolean; error?: string }>
  monitorRefresh: (source: RemoteUsageSource) =>
    Promise<{ success: boolean; data?: CommandCodeUsage; error?: string; code?: MonitorErrorCode }>

  // MoA Event Listeners (streaming)
  onSubOutputUpdate: (callback: (data: SubOutputUpdate) => void) => () => void
  onAggregationStart: (callback: () => void) => () => void
  onAggregationChunk: (callback: (data: AggregationChunk) => void) => () => void
  onAllDone: (callback: (data: { conversationId: string; conversations: unknown[] }) => void) => () => void
  removeAllListeners: () => void

  // Menu event listeners
  onMenuNewConversation: (callback: () => void) => () => void
  onMenuCopyProxyUrl: (callback: (url: string) => void) => () => void
  onMenuOpenSettings: (callback: () => void) => () => void

  // 用量悬浮窗右键「打开用量页」
  onUsageOpen: (callback: () => void) => () => void

  // Title event listeners
  onTitleUpdated: (callback: (data: { conversationId: string; title: string; conversations: unknown[] }) => void) => () => void

  // Usage event listeners
  onUsageUpdated: (callback: () => void) => () => void
}

declare global {
  interface Window {
    moaAPI: MoaAPI
  }
}

// Make this a module so declare global works in bundler mode
export {}
