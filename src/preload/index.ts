import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('moaAPI', {
  // Config / Providers
  getProviders: () => ipcRenderer.invoke('config:getProviders'),
  addProvider: (data: unknown) => ipcRenderer.invoke('config:addProvider', data),
  removeProvider: (id: string) => ipcRenderer.invoke('config:removeProvider', id),
  getModels: (providerId: string) => ipcRenderer.invoke('config:getModels', providerId),

  // Conversations
  getConversations: () => ipcRenderer.invoke('db:getConversations'),
  createConversation: (data: { title: string; mode: string }) =>
    ipcRenderer.invoke('db:createConversation', data),
  deleteConversation: (id: string) => ipcRenderer.invoke('db:deleteConversation', id),
  getMessages: (conversationId: string) => ipcRenderer.invoke('db:getMessages', conversationId),
  addMessage: (msg: {
    conversationId: string; role: string; content: string; mode: string
  }) => ipcRenderer.invoke('db:addMessage', msg),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:getAll'),
  setSetting: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),

  // MoA Config
  getMoaConfig: () => ipcRenderer.invoke('moa:getConfig'),
  setMoaConfig: (config: unknown) => ipcRenderer.invoke('moa:setConfig', config),

  // MoA Send
  sendMessage: (msg: { conversationId?: string; content: string; mode: string }) =>
    ipcRenderer.invoke('moa:sendMessage', msg),

  // App
  getVersion: () => ipcRenderer.invoke('app:getVersion')
})
