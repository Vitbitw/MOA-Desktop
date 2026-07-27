import type { SubOutputUpdate, AggregationChunk } from './types'

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

  // Title event listeners
  onTitleUpdated: (callback: (data: { conversationId: string; title: string; conversations: unknown[] }) => void) => () => void
}

declare global {
  interface Window {
    moaAPI: MoaAPI
  }
}

// Make this a module so declare global works in bundler mode
export {}
