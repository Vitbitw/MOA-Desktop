import type { SubOutputUpdate, AggregationChunk, UsageSummary, UsageRange, UsageGroupBy, UsageToday, DetectedEngine, LocalEngine, LocalModel, RuntimeState } from './types'

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

  // Local Model Deployment
  detectLocalEngines: () => Promise<{ success: boolean; data: DetectedEngine[]; error?: string }>
  listLocalEngines: () => Promise<{ success: boolean; data: LocalEngine[]; error?: string }>
  addManualEngine: (baseUrl: string) => Promise<{ success: boolean; data?: unknown; error?: string }>
  removeLocalEngine: (id: string) => Promise<{ success: boolean; error?: string }>
  listLocalModels: () => Promise<{ success: boolean; data: LocalModel[]; error?: string }>
  searchHf: (query: string) => Promise<{ success: boolean; data: unknown; error?: string }>
  startDownload: (params: { repo: string; file: string; sizeBytes?: number; quantization?: string }) => Promise<{ success: boolean; data?: unknown; error?: string }>
  cancelDownload: (jobId: string) => Promise<{ success: boolean; error?: string }>
  deleteLocalModel: (id: string) => Promise<{ success: boolean; error?: string }>
  startEngine: (modelId: string) => Promise<{ success: boolean; data?: unknown; error?: string }>
  stopEngine: () => Promise<{ success: boolean; error?: string }>
  getRuntimeState: () => Promise<{ success: boolean; data: RuntimeState; error?: string }>
  ensureRuntime: (backend?: string) => Promise<{ success: boolean; data: RuntimeState; error?: string }>
  getLaunchConfig: (modelId: string) => Promise<{ success: boolean; data?: unknown; error?: string }>
  setLaunchConfig: (modelId: string, config: unknown) => Promise<{ success: boolean; error?: string }>
  onEngineStatusChanged: (callback: (data: unknown) => void) => () => void
  onDownloadProgress: (callback: (data: unknown) => void) => () => void
}

declare global {
  interface Window {
    moaAPI: MoaAPI
  }
}

// Make this a module so declare global works in bundler mode
export {}
