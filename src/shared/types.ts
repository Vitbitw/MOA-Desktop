// ─── MoA Modes ───
export type MoAMode = 'aggregate' | 'compare' | 'direct'

// ─── Providers ───
export type ProviderKind = 'api' | 'local'

export interface Provider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  models: ModelInfo[]
  enabled: boolean
  builtIn?: boolean
  /** 'api' = 云端厂商（需 Key）；'local' = 本地推理端点（无需 Key） */
  kind?: ProviderKind
  /** kind='local' 时关联的引擎 id（local_engines.id），手动地址可为空 */
  engineId?: string
}

export interface ModelInfo {
  id: string
  name: string
  providerId: string
  /** 本地模型：文件大小（字节），用于列表展示 */
  sizeBytes?: number
  /** 本地模型：量化名（Q4_K_M 等），从文件名解析 */
  quantization?: string
}

// ─── Local Engines ───
export type LocalEngineType = 'lmstudio' | 'ollama' | 'llamaserver' | 'bundled' | 'manual'
export type LocalEngineStatus = 'stopped' | 'running' | 'error'

export interface LocalEngine {
  id: string
  name: string
  engineType: LocalEngineType
  baseUrl: string
  /** bundled/manual 引擎的可执行文件路径 */
  binaryPath?: string
  port?: number
  status: LocalEngineStatus
  /** 探测到的模型列表（不持久化，运行时填充） */
  models?: ModelInfo[]
  /** 探测到的版本号，仅展示 */
  version?: string
  createdAt: number
}

export interface DetectedEngine {
  engineType: LocalEngineType
  name: string
  baseUrl: string
  port: number
  reachable: boolean
  version?: string
  models: ModelInfo[]
}

// ─── Local Models（应用管理的 GGUF 模型库）───
// 注意：LocalModelStatus 只有三种状态，禁止加 'cancelled'
// 注意：LocalModel 禁止 downloadJobId 字段（无 DB 列支撑）
export type LocalModelStatus = 'downloading' | 'downloaded' | 'error'

/** 模型启动参数（llama-server CLI flags） */
export interface LaunchConfig {
  /** GPU 层卸载数量 (-ngl)，默认 99（全部卸载） */
  gpuLayers: number
  /** 上下文长度 (-c)，默认 32768 */
  contextLength: number
  /** 张量拆分比例 (-ts)，双卡如 "1,0.3"；单卡留空 */
  tensorSplit?: string
  /** K cache 量化类型 (--cache-type-k)，默认 "q8_0" */
  cacheTypeK: string
  /** V cache 量化类型 (--cache-type-v)，默认 "q8_0" */
  cacheTypeV: string
  /** Flash Attention (-fa)，默认 true */
  flashAttention: boolean
  /** 启用 Jinja 聊天模板 (--jinja)，默认 true */
  jinja: boolean
  /** CPU 线程数 (-t)，0 = 自动 */
  threads: number
  /** 额外参数（原样追加） */
  extraArgs?: string
}

export const DEFAULT_LAUNCH_CONFIG: LaunchConfig = {
  gpuLayers: 99,
  contextLength: 32768,
  cacheTypeK: 'q8_0',
  cacheTypeV: 'q8_0',
  flashAttention: true,
  jinja: true,
  threads: 0,
}

export interface LocalModel {
  id: string
  /** 显示名（repo 名 + 文件名） */
  name: string
  /** 推理请求中的 model id（= 文件名去掉 .gguf） */
  modelId: string
  /** GGUF 文件绝对路径；下载中为最终目标路径 */
  ggufPath: string
  sizeBytes: number
  downloadedBytes: number
  hfRepo: string
  hfFile: string
  quantization?: string
  status: LocalModelStatus
  createdAt: number
  /** 启动参数（JSON），null = 用默认值 */
  launchConfig?: LaunchConfig | null
}

// ─── Download job（渲染端进度展示用，主进程内存态）───
export interface DownloadProgress {
  jobId: string
  modelId: string
  repo: string
  file: string
  receivedBytes: number
  totalBytes: number
  /** 0-100；totalBytes 未知时按 receivedBytes 累计 */
  percent: number
  speedBps: number
  status: 'downloading' | 'done' | 'cancelled' | 'error'
  error?: string
}

// ─── Bundled runtime state ───
export type RuntimeStatus = 'not-installed' | 'downloading' | 'ready' | 'running' | 'error'
export interface RuntimeState {
  status: RuntimeStatus
  binaryPath: string
  port?: number
  /** downloading 时 0-100 */
  progress?: number
  error?: string
  backend?: string
  /** 当前正在由 bundled 引擎加载运行的 LocalModel.id（用于 UI 禁用删除等） */
  runningModelId?: string
}

// ─── Hugging Face 搜索返回（全仓统一类型，hfHub.ts 直接 import 它）───
export interface HfSearchResult {
  id: string
  author: string
  name: string
  downloads: number
  likes: number
  ggufFiles: Array<{ filename: string; sizeBytes: number }>
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
  /** 网络代理：所有主进程外发请求（运行时下载/HF 搜索/引擎探测）走此代理 */
  network: {
    /** 是否启用网络代理 */
    enabled: boolean
    /** 代理地址，如 http://127.0.0.1:7897 */
    proxyUrl: string
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
