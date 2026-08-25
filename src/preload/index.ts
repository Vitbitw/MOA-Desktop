import { contextBridge, ipcRenderer } from 'electron'
import { IPC, IPC_EVENT } from '../shared/ipc-channels'
import type { SubOutputUpdate, AggregationChunk, UsageSummary, UsageRange, UsageGroupBy, UsageToday } from '../shared/types'

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
  sendMessage: (msg: { conversationId?: string; title?: string; content: string; mode: string }) =>
    ipcRenderer.invoke('moa:sendMessage', msg),

  // Title
  updateConversationTitle: (conversationId: string, title: string, titleEdited?: boolean) =>
    ipcRenderer.invoke('db:updateConversationTitle', conversationId, title, titleEdited),
  generateTitle: (data: {
    conversationId: string
    messages: Array<{ role: string; content: string }>
    providerId: string
    modelId: string
    maxLength: number
    language: 'auto' | 'zh' | 'en'
  }) => ipcRenderer.invoke('title:generate', data),

  // App
  getVersion: () => ipcRenderer.invoke('app:getVersion'),

  // Usage Monitoring
  getUsageSummary: (params: { range: UsageRange; groupBy: UsageGroupBy }) =>
    ipcRenderer.invoke(IPC.USAGE_GET_SUMMARY, params),
  getUsageToday: () => ipcRenderer.invoke(IPC.USAGE_GET_TODAY),

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
    ipcRenderer.removeAllListeners(IPC_EVENT.MENU_NEW_CONVERSATION)
    ipcRenderer.removeAllListeners(IPC_EVENT.MENU_COPY_PROXY_URL)
    ipcRenderer.removeAllListeners(IPC_EVENT.TITLE_UPDATED)
    ipcRenderer.removeAllListeners(IPC_EVENT.MENU_OPEN_SETTINGS)
    ipcRenderer.removeAllListeners(IPC_EVENT.USAGE_OPEN)
    ipcRenderer.removeAllListeners(IPC_EVENT.USAGE_UPDATED)
  },

  // Menu event listeners
  onMenuNewConversation: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC_EVENT.MENU_NEW_CONVERSATION, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.MENU_NEW_CONVERSATION, handler)
  },

  onMenuCopyProxyUrl: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC_EVENT.MENU_COPY_PROXY_URL, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.MENU_COPY_PROXY_URL, handler)
  },

  onMenuOpenSettings: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC_EVENT.MENU_OPEN_SETTINGS, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.MENU_OPEN_SETTINGS, handler)
  },

  // 用量悬浮窗右键「打开用量页」
  onUsageOpen: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC_EVENT.USAGE_OPEN, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.USAGE_OPEN, handler)
  },

  // Title event listeners
  onTitleUpdated: (callback: (data: { conversationId: string; title: string; conversations: unknown[] }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { conversationId: string; title: string; conversations: unknown[] }) => callback(data)
    ipcRenderer.on(IPC_EVENT.TITLE_UPDATED, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.TITLE_UPDATED, handler)
  },

  // Usage event listeners
  onUsageUpdated: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC_EVENT.USAGE_UPDATED, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.USAGE_UPDATED, handler)
  },

  // Local Model Deployment
  detectLocalEngines: () => ipcRenderer.invoke(IPC.LOCAL_DETECT_ENGINES),
  listLocalEngines: () => ipcRenderer.invoke(IPC.LOCAL_LIST_ENGINES),
  addManualEngine: (baseUrl: string) => ipcRenderer.invoke(IPC.LOCAL_ADD_MANUAL_ENGINE, baseUrl),
  removeLocalEngine: (id: string) => ipcRenderer.invoke(IPC.LOCAL_REMOVE_ENGINE, id),
  listLocalModels: () => ipcRenderer.invoke(IPC.LOCAL_LIST_MODELS),
  searchHf: (query: string) => ipcRenderer.invoke(IPC.LOCAL_SEARCH_HF, query),
  startDownload: (params: { repo: string; file: string; sizeBytes?: number; quantization?: string }) =>
    ipcRenderer.invoke(IPC.LOCAL_START_DOWNLOAD, params),
  cancelDownload: (jobId: string) => ipcRenderer.invoke(IPC.LOCAL_CANCEL_DOWNLOAD, jobId),
  deleteLocalModel: (id: string) => ipcRenderer.invoke(IPC.LOCAL_DELETE_MODEL, id),
  startEngine: (modelId: string) => ipcRenderer.invoke(IPC.LOCAL_START_ENGINE, modelId),
  stopEngine: () => ipcRenderer.invoke(IPC.LOCAL_STOP_ENGINE),
  getRuntimeState: () => ipcRenderer.invoke(IPC.LOCAL_GET_RUNTIME),
  ensureRuntime: (backend?: string) => ipcRenderer.invoke(IPC.LOCAL_ENSURE_RUNTIME, backend),
  getLaunchConfig: (modelId: string) => ipcRenderer.invoke(IPC.LOCAL_GET_LAUNCH_CONFIG, modelId),
  setLaunchConfig: (modelId: string, config: unknown) => ipcRenderer.invoke(IPC.LOCAL_SET_LAUNCH_CONFIG, modelId, config),
  onEngineStatusChanged: (callback: (data: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data)
    ipcRenderer.on(IPC_EVENT.LOCAL_ENGINE_STATUS_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.LOCAL_ENGINE_STATUS_CHANGED, handler)
  },
  onDownloadProgress: (callback: (data: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data)
    ipcRenderer.on(IPC_EVENT.LOCAL_DOWNLOAD_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.LOCAL_DOWNLOAD_PROGRESS, handler)
  }
})
