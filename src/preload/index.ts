import { contextBridge, ipcRenderer } from 'electron'
import { IPC, IPC_EVENT } from '../shared/ipc-channels'
import type { GatewayRoundStartPayload, GatewaySubUpdatePayload, GatewayAggStartPayload, GatewayAggChunkPayload, GatewayRoundDonePayload } from '../shared/ipc-channels'
import type { SubOutputUpdate, AggregationChunk, UsageSummary, UsageRange, UsageGroupBy, UsageToday, RemoteUsageSource, MonitorUsage, MonitorStatus, PricingProbeSource, PricingProbeState, ProbeProgressEvent, ToastData, GenerateExpertsRequest } from '../shared/types'

contextBridge.exposeInMainWorld('moaAPI', {
  // Config / Providers
  getProviders: () => ipcRenderer.invoke('config:getProviders'),
  addProvider: (data: unknown) => ipcRenderer.invoke('config:addProvider', data),
  removeProvider: (id: string) => ipcRenderer.invoke('config:removeProvider', id),
  getModels: (providerId: string) => ipcRenderer.invoke('config:getModels', providerId),
  // T1：编辑厂商 / 改 API 密钥（同 vendor_key 组内共享）
  updateProvider: (id: string, patch: unknown) => ipcRenderer.invoke(IPC.PROVIDERS_UPDATE, id, patch),
  updateProviderKey: (id: string, apiKey: string) => ipcRenderer.invoke(IPC.PROVIDERS_UPDATE_KEY, id, apiKey),

  // Conversations
  getConversations: () => ipcRenderer.invoke('db:getConversations'),
  deleteConversation: (id: string) => ipcRenderer.invoke('db:deleteConversation', id),
  getMessages: (conversationId: string) => ipcRenderer.invoke('db:getMessages', conversationId),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:getAll'),
  setSetting: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),

  // MoA Config
  getMoaConfig: () => ipcRenderer.invoke('moa:getConfig'),
  setMoaConfig: (config: unknown) => ipcRenderer.invoke('moa:setConfig', config),

  // 主席团专家团生成（AI 规划专家）
  generateExperts: (req: GenerateExpertsRequest) =>
    ipcRenderer.invoke(IPC.MOA_GENERATE_EXPERTS, req),

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

  // Usage Monitoring
  getUsageSummary: (params: { range: UsageRange; groupBy: UsageGroupBy }) =>
    ipcRenderer.invoke(IPC.USAGE_GET_SUMMARY, params),
  getUsageToday: () => ipcRenderer.invoke(IPC.USAGE_GET_TODAY),

  // Cloud Usage Monitoring
  getMonitorStatus: (source: RemoteUsageSource) => ipcRenderer.invoke(IPC.MONITOR_GET_STATUS, source),
  monitorLogin: (source: RemoteUsageSource) => ipcRenderer.invoke(IPC.MONITOR_LOGIN, source),
  monitorLogout: (sourceId: string) => ipcRenderer.invoke(IPC.MONITOR_LOGOUT, sourceId),
  monitorSetApiKey: (sourceId: string, apiKey: string) => ipcRenderer.invoke(IPC.MONITOR_SET_API_KEY, sourceId, apiKey),
  monitorRefresh: (source: RemoteUsageSource) => ipcRenderer.invoke(IPC.MONITOR_REFRESH, source),
  monitorGetCumulative: (sourceId: string) => ipcRenderer.invoke(IPC.MONITOR_GET_CUMULATIVE, sourceId),
  monitorCollectorStatus: () => ipcRenderer.invoke(IPC.MONITOR_COLLECTOR_STATUS),
  monitorGetSnapshot: (sourceId: string) => ipcRenderer.invoke(IPC.MONITOR_GET_SNAPSHOT, sourceId),

  // Pricing Probe
  probePricing: (sources: PricingProbeSource[], force?: boolean) => ipcRenderer.invoke(IPC.PRICING_PROBE_RUN, sources, force),
  getProbeStatus: () => ipcRenderer.invoke(IPC.PRICING_PROBE_STATUS),
  onProbeProgress: (callback: (data: ProbeProgressEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ProbeProgressEvent) => callback(data)
    ipcRenderer.on(IPC_EVENT.PRICING_PROBE_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.PRICING_PROBE_PROGRESS, handler)
  },
  onProbeState: (callback: (data: PricingProbeState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: PricingProbeState) => callback(data)
    ipcRenderer.on(IPC_EVENT.PRICING_PROBE_STATE, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.PRICING_PROBE_STATE, handler)
  },

  // 厂商模型列表变更（/models 拉取后主进程广播；探查与手动刷新共用）
  onProvidersChanged: (callback: (data: { providerId: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { providerId: string }) => callback(data)
    ipcRenderer.on(IPC_EVENT.CONFIG_PROVIDERS_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.CONFIG_PROVIDERS_CHANGED, handler)
  },

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

  // 网关代理请求直播事件（T5；App 经 gatewayStore.initGatewaySubscriptions 订阅）
  onGatewayRoundStart: (callback: (data: GatewayRoundStartPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: GatewayRoundStartPayload) => callback(data)
    ipcRenderer.on(IPC_EVENT.GATEWAY_ROUND_START, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.GATEWAY_ROUND_START, handler)
  },

  onGatewaySubUpdate: (callback: (data: GatewaySubUpdatePayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: GatewaySubUpdatePayload) => callback(data)
    ipcRenderer.on(IPC_EVENT.GATEWAY_SUB_UPDATE, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.GATEWAY_SUB_UPDATE, handler)
  },

  onGatewayAggStart: (callback: (data: GatewayAggStartPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: GatewayAggStartPayload) => callback(data)
    ipcRenderer.on(IPC_EVENT.GATEWAY_AGG_START, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.GATEWAY_AGG_START, handler)
  },

  onGatewayAggChunk: (callback: (data: GatewayAggChunkPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: GatewayAggChunkPayload) => callback(data)
    ipcRenderer.on(IPC_EVENT.GATEWAY_AGG_CHUNK, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.GATEWAY_AGG_CHUNK, handler)
  },

  onGatewayRoundDone: (callback: (data: GatewayRoundDonePayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: GatewayRoundDonePayload) => callback(data)
    ipcRenderer.on(IPC_EVENT.GATEWAY_ROUND_DONE, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.GATEWAY_ROUND_DONE, handler)
  },

  // Menu event listeners
  onMenuNewConversation: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC_EVENT.MENU_NEW_CONVERSATION, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.MENU_NEW_CONVERSATION, handler)
  },

  onMenuCopyGatewayUrl: (callback: (url: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, url: string) => callback(url)
    ipcRenderer.on(IPC_EVENT.MENU_COPY_GATEWAY_URL, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.MENU_COPY_GATEWAY_URL, handler)
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

  // 主进程 → 渲染进程悬浮通知
  onRendererToast: (callback: (data: ToastData) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ToastData) => callback(data)
    ipcRenderer.on(IPC_EVENT.RENDERER_TOAST, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT.RENDERER_TOAST, handler)
  }
})
