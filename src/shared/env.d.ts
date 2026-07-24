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
  sendMessage: (msg: { conversationId?: string; content: string; mode: string }) =>
    Promise<{ success: boolean; data?: unknown; error?: string }>

  // App
  getVersion: () => Promise<string>
}

declare global {
  interface Window {
    moaAPI: MoaAPI
  }
}

// Make this a module so declare global works in bundler mode
export {}
