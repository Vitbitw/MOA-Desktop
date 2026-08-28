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
  subModels: Record<string, { prompt: number; completion: number }>
  aggregator?: { prompt: number; completion: number }
  total: { prompt: number; completion: number }
  cost?: number
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
  /** 网络代理：所有主进程外发请求（运行时下载/HF 搜索/引擎探测）走此代理 */
  network: {
    /** 是否启用网络代理 */
    enabled: boolean
    /** 代理地址，如 http://127.0.0.1:7897 */
    proxyUrl: string
    /** 单次外发请求超时（毫秒），0 = 不超时。仅对未自带超时信号(AbortSignal.timeout)的调用生效 */
    timeoutMs: number
    /** 超时/网络错误后的最大重试次数（不含首次请求） */
    retryCount: number
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
  /** 云端用量监控（如 Command Code Studio） */
  monitoring: MonitoringSettings
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

// ─── Cloud Usage Monitoring (Command Code / Xiaomi MiMo / DeepSeek) ───
/** 云端用量监控源类型（当前支持 Command Code / Xiaomi MiMo / DeepSeek，后续可扩展） */
export type RemoteUsageSourceType = 'commandcode' | 'mimo' | 'deepseek'

/** 一个云端用量监控源（如 Command Code Studio 账号） */
export interface RemoteUsageSource {
  id: string
  type: RemoteUsageSourceType
  name: string
  studioUrl: string
  enabled: boolean
}

export interface MonitoringSettings {
  /** 已启用的云端用量监控源列表 */
  sources: RemoteUsageSource[]
  /** 自动刷新间隔（分钟），0 表示关闭 */
  autoRefreshMinutes: number
}

/** 滚动窗口额度（5小时/7天），字段可能缺失 */
export interface UsageWindowInfo {
  /** 已用百分比 0-100 */
  usedPercent?: number
  /** 重置时间（epoch 秒） */
  resetAt?: number
}

/** Command Code 用量归一化数据。区块可选：对应端点失败时 absent（见 sourcesAvailable） */
export interface CommandCodeUsage {
  fetchedAt: number
  sourcesAvailable: { summary: boolean; charts: boolean; credits: boolean; windows: boolean }
  summary?: { totalCount: number; totalCost: number; totalTokens: number; successRate: number }
  credits?: { monthlyCredits: number }
  windows?: { fiveHour?: UsageWindowInfo; weekly?: UsageWindowInfo }
  models?: Array<{
    model: string
    requests: number
    cost: number
    tokensIn: number
    tokensOut: number
    tokensTotal: number
  }>
}

/** 监控源当前认证状态 */
export interface MonitorStatus {
  loggedIn: boolean
  hasApiKey: boolean
}

/** monitor:refresh 失败时的错误码 */
export type MonitorErrorCode = 'not_authenticated' | 'session_expired' | 'network' | 'unknown'

// ─── Xiaomi MiMo 用量 ───

/** MiMo 账户余额（CNY，/api/v1/balance data 结构） */
export interface MimoBalance {
  currency: string
  balance: number
  cashBalance: number
  giftBalance: number
  frozenBalance: number
  overdraftLimit: number
  remainingOverdraftLimit: number
}

/** MiMo Token Plan 用量条目（如 plan_total_token / compensation_total_token） */
export interface MimoTokenPlanItem {
  name: string
  used: number
  limit: number
  /** 已用百分比 0-100 */
  percent: number
}

export interface MimoTokenPlan {
  /** 总体已用百分比 0-100 */
  percent: number
  items: MimoTokenPlanItem[]
}

/** MiMo 用量归一化数据。区块可选：对应端点失败时 absent（见 sourcesAvailable） */
export interface MimoUsage {
  fetchedAt: number
  sourcesAvailable: { balance: boolean; tokenPlan: boolean }
  balance?: MimoBalance
  tokenPlan?: MimoTokenPlan
}

/** 任意监控源的归一化用量（monitor:refresh 返回值，按 source.type 区分结构） */
export type MonitorUsage = CommandCodeUsage | MimoUsage | DeepSeekUsage

// ─── DeepSeek 用量 ───

/** DeepSeek 账户余额条目（/user/balance balance_infos[]，金额为字符串） */
export interface DeepSeekBalanceInfo {
  currency: string
  totalBalance: number
  grantedBalance: number
  toppedUpBalance: number
}

/** DeepSeek 账户余额（/user/balance） */
export interface DeepSeekBalance {
  /** 余额是否足以发起 API 调用 */
  isAvailable: boolean
  infos: DeepSeekBalanceInfo[]
}

/** DeepSeek 单模型用量汇总（当月 total） */
export interface DeepSeekModelUsage {
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** 请求次数（REQUEST） */
  requests: number
  /** 花费（cost 接口对应金额） */
  cost: number
}

/** DeepSeek 每日用量（近 7 日趋势） */
export interface DeepSeekDailyUsage {
  date: string
  tokens: number
  cost: number
}

/** DeepSeek 用量归一化数据。区块可选：对应端点失败时 absent（见 sourcesAvailable） */
export interface DeepSeekUsage {
  fetchedAt: number
  sourcesAvailable: { balance: boolean; usage: boolean }
  balance?: DeepSeekBalance
  currency?: string
  todayTokens?: number
  todayCost?: number
  monthTokens?: number
  monthCost?: number
  models?: DeepSeekModelUsage[]
  daily?: DeepSeekDailyUsage[]
}
