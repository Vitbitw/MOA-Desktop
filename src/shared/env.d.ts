interface MoaAPI {
  // Config / Providers
  getProviders: () => Promise<{ success: boolean; data: unknown }>
  addProvider: (data: { name: string; baseUrl: string; apiKey: string }) => Promise<{ success: boolean; data: unknown }>
  removeProvider: (id: string) => Promise<{ success: boolean }>
  getModels: (providerId: string) => Promise<{ success: boolean; data: unknown }>

  // Conversations
  getConversations: () => Promise<{ success: boolean; data: unknown }>
  createConversation: (data: { title: string; mode: string }) => Promise<{ success: boolean; data: unknown }>
  deleteConversation: (id: string) => Promise<{ success: boolean }>
  getMessages: (conversationId: string) => Promise<{ success: boolean; data: unknown }>
  addMessage: (msg: { conversationId: string; role: string; content: string; mode: string }) => Promise<{ success: boolean; data: unknown }>

  // Settings
  getSettings: () => Promise<{ success: boolean; data: unknown }>
  setSetting: (key: string, value: unknown) => Promise<{ success: boolean }>

  // MoA Config
  getMoaConfig: () => Promise<unknown>
  setMoaConfig: (config: unknown) => unknown

  // App
  getVersion: () => Promise<string>
}

declare global {
  interface Window {
    moaAPI: MoaAPI
  }
}
