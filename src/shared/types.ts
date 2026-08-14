// ─── MoA Modes ───
export type MoAMode = 'aggregate' | 'compare' | 'direct'

// ─── Providers ───
export interface Provider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  models: ModelInfo[]
  enabled: boolean
  builtIn?: boolean
}

export interface ModelInfo {
  id: string
  name: string
  providerId: string
}

// ─── Sub Model Selection ───
export interface SubModelConfig {
  modelId: string
  providerId: string
  order: number
}

// ─── Aggregator Config ───
export interface AggregatorConfig {
  primaryModelId: string
  primaryProviderId: string
  fallbackModelId?: string
  fallbackProviderId?: string
  allowQuickSwitch?: boolean
}

// ─── Chat / Messages ───
export interface ChatMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  mode: MoAMode
  subModelOutputs?: SubModelOutput[]
  tokenUsage?: TokenUsage
  timestamp: number
}

export interface SubModelOutput {
  modelId: string
  providerId: string
  content: string
  status: 'success' | 'error'
  error?: string
  durationMs?: number
  tokenUsage?: { prompt: number; completion: number }
}

export interface Conversation {
  id: string
  title: string
  mode: MoAMode
  subModels: SubModelConfig[]
  aggregatorConfig?: AggregatorConfig
  createdAt: number
  updatedAt: number
  messageCount: number
  titleEdited?: boolean
}

// ─── Token / Usage ───
export interface TokenUsage {
  subModels: Record<string, { prompt: number; completion: number; cacheRead?: number; cacheCreation?: number }>
  aggregator?: { prompt: number; completion: number; cacheRead?: number; cacheCreation?: number }
  total: { prompt: number; completion: number }
  cost?: number
  cacheSavings?: number
}

// ─── Proxy / Request Log ───
export interface RequestLog {
  requestId: string
  timestamp: number
  clientIp: string
  mode: 'proxy' | 'chat'
  moaMode: 'aggregate' | 'direct'
  subCount: number
  promptTokens: number
  completionTokens: number
  cost: number
  durationMs: number
  success: boolean
  errorDetail?: string
}

// ─── Health ───
export interface HealthStatus {
  status: 'ok' | 'degraded' | 'error'
  version: string
  uptimeSeconds: number
  activeRequests: number
  queueLength: number
  moaConfig: { subCount: number; mode: string }
  providers: Array<{ name: string; status: string; model: string }>
}

// ─── Title Settings ───
export interface TitleSettings {
  autoMode: 'first_message' | 'first_reply' | 'manual_only' | 'first_and_manual'
  realtimeMode: 'off' | 'every_reply' | 'every_n_rounds'
  realtimeN: number
  providerId: string
  modelId: string
  maxLength: number
  language: 'auto' | 'zh' | 'en'
}

// ─── Settings ───
export interface AppSettings {
  title: TitleSettings
  proxy: {
    enabled: boolean
    host: string
    port: number
    maxConcurrency: number
    defaultModelId: string
    authEnabled: boolean
    proxyKey: string
    recording: 'full' | 'stats'
    transparency: 'default' | 'extended'
  }
  display: {
    subModelShow: 'always' | 'hidden' | 'perConversation'
    defaultSubModelExpanded: boolean
    autoClearSubOutputs: boolean
    usageOverlay: boolean
    usageOverlayPos?: { x: number; y: number }
  }
  pricing: Record<string, PricingConfig>
  currency: 'USD' | 'CNY'
}

export interface PricingConfig {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

// ─── IPC Streaming Events ───
export interface SubOutputUpdate {
  index: number
  modelId: string
  providerId: string
  content: string
  status: 'success' | 'error'
  error?: string
  durationMs?: number
  tokenUsage?: { prompt: number; completion: number }
}

export interface AggregationChunk {
  text: string
  done: boolean
}

// ─── Usage Monitoring ───
export type UsageRange = 'today' | 'week' | 'month' | 'all'
export type UsageGroupBy = 'model' | 'provider' | 'mode'
export interface UsageRow { key: string; requests: number; success: number; prompt: number; completion: number; cost: number }
export interface UsageSummary { range: UsageRange; groupBy: UsageGroupBy; totals: { requests: number; success: number; prompt: number; completion: number; cost: number }; rows: UsageRow[] }
export interface UsageToday { prompt: number; completion: number; cost: number; running: boolean }
