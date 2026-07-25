import { contextBridge, ipcRenderer } from 'electron'
import { IPC_EVENT } from '../shared/ipc-channels'
import type { SubOutputUpdate, AggregationChunk } from '../shared/types'

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
  getVersion: () => ipcRenderer.invoke('app:getVersion'),

  // MoA Event Listeners (streaming)
  onSubOutputUpdate: (callback: (data: SubOutputUpdate) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: SubOutputUpdate) => callback(data)
    ipcRenderer.on(IPC_EVENT.MOA_SUB_OUTPUT_UPDATE, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.MOA_SUB_OUTPUT_UPDATE, handler)
  },

  onAggregationStart: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC_EVENT.MOA_AGGREGATION_START, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.MOA_AGGREGATION_START, handler)
  },

  onAggregationChunk: (callback: (data: AggregationChunk) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: AggregationChunk) => callback(data)
    ipcRenderer.on(IPC_EVENT.MOA_AGGREGATION_CHUNK, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.MOA_AGGREGATION_CHUNK, handler)
  },

  onAllDone: (callback: (data: { conversationId: string; conversations: unknown[] }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { conversationId: string; conversations: unknown[] }) => callback(data)
    ipcRenderer.on(IPC_EVENT.MOA_ALL_DONE, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.MOA_ALL_DONE, handler)
  },

  removeAllListeners: () => {
    ipcRenderer.removeAllListeners(IPC_EVENT.MOA_SUB_OUTPUT_UPDATE)
    ipcRenderer.removeAllListeners(IPC_EVENT.MOA_AGGREGATION_START)
    ipcRenderer.removeAllListeners(IPC_EVENT.MOA_AGGREGATION_CHUNK)
    ipcRenderer.removeAllListeners(IPC_EVENT.MOA_ALL_DONE)
  }
})
