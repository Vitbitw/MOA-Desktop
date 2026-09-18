// ─── MoA Modes ───
export type MoAMode = 'aggregate' | 'compare' | 'direct'

// ─── MoA Architecture ───
/** 选举模式：子模型并行出完整答案 → 聚合模型拼接提炼；主席团模式：子模型带角色出意见 → 主模型参考意见亲自作答 */
export type MoaArchitecture = 'election' | 'committee'

// ─── Sub Model Role（预设角色模板 key；'' = 无角色）───
export type SubModelRole =
  | 'critic' | 'advisor' | 'creative'
  | 'pragmatist' | 'analyst' | 'summarizer'
  | ''

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
  /** 席位稳定 id（uuid）：同模型可占多个席位，卡片 key / 编辑态定位用。旧配置缺省，加载时内存补全 */
  id?: string
  modelId: string
  providerId: string
  order: number
  /** 预设角色模板 key；'' = 无预设（保持旧行为） */
  role?: SubModelRole
  /** 自定义 system prompt；非空时覆盖 role 模板 */
  systemPrompt?: string
  /** AI 生成的专家名（如「安全工程师」）。显示优先级：expertName > role 模板标签 > 无。旧配置缺省 */
  expertName?: string
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
  /** 子模型的预设角色（渲染端展示角色标签用；旧数据无此字段） */
  role?: SubModelRole
  /** 专家名（主席团 AI 生成专家团用；旧数据无此字段） */
  expertName?: string
}

export interface Conversation {
  id: string
  title: string
  mode: MoAMode
  createdAt: number
  updatedAt: number
  messageCount: number
  titleEdited?: boolean
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
  /** MoA 网关：把 MoA 聚合能力以 OpenAI 兼容 API 暴露给第三方软件（区别于 network 出站网络代理） */
  gateway: {
    enabled: boolean
    host: string
    port: number
    maxConcurrency: number
    authEnabled: boolean
    gatewayKey: string
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
    usageOverlay: boolean
    usageOverlayPos?: { x: number; y: number }
  }
  pricing: Record<string, PricingConfig>
  currency: 'USD' | 'CNY'
  /** 云端用量监控（如 Command Code Studio） */
  monitoring: MonitoringSettings
  /** 官方探查定价层（优先级：手动覆盖 > 官方探查 > 内置默认 > 0） */
  probedPricing: ProbedPricingEntry[]
  /** 定价探查配置（源 + 自动刷新 + 探查模型） */
  pricingProbe: PricingProbeSettings
  /** 定价探查页面级缓存（页面哈希 + 定价区块锚句；独立持久化，不入 pricingProbe） */
  pricingProbeCache?: Record<string, PricingPageCache>
}

export interface PricingConfig {
  /** 单价（每 1M tokens）。undefined 表示未探到/未设置；0 表示免费 */
  input?: number
  output?: number
  cacheRead?: number
  cacheCreation?: number
  /** 峰谷时段价（多时段窗口），请求时间命中窗口则用窗口价，否则用基础价 */
  windows?: PricingWindow[]
  /** 窗口时区（IANA），默认 Asia/Shanghai */
  timezone?: string
}

// ─── IPC Streaming Events ───
export interface SubOutputUpdate {
  index: number
  modelId: string
  providerId: string
  content: string
  /** running = 流式过程中的累计文本增量（host 层节流合并推送）；success/error = 终态（一次） */
  status: 'running' | 'success' | 'error'
  error?: string
  durationMs?: number
  tokenUsage?: { prompt: number; completion: number }
  role?: SubModelRole
  expertName?: string
}

// ─── AI 专家团生成（主席团模式）───

/** AI 生成的单个专家 */
export interface GeneratedExpert {
  name: string
  prompt: string
}

/** AI 专家团生成结果（moa:generateExperts 返回 data） */
export interface ExpertTeamPlan {
  /** AI 推荐理由（一句话，可空） */
  reason?: string
  /** 推荐的专家列表（长度 = 推荐数量） */
  experts: GeneratedExpert[]
  /** 实际使用的生成模型身份（UI 显示「由 X 生成」） */
  modelId: string
  providerId: string
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
  /**
   * 统一自动刷新间隔（分钟），0 表示关闭。
   * 页面数据刷新（本页打开期间）与 Command Code 后台明细采集共用此值；
   * 合并前的独立 collectIntervalMinutes 已并入（读设置时自动迁移，见 config/appSettings.ts）。
   */
  autoRefreshMinutes: number
}

/** 滚动窗口额度（5小时/7天），字段可能缺失 */
export interface UsageWindowInfo {
  /** 已用百分比 0-100 */
  usedPercent?: number
  /** 重置时间（epoch 秒） */
  resetAt?: number
}

/** Command Code 订阅套餐信息（/internal/billing/subscriptions 归一化；字段缺失时省略） */
export interface CommandCodeSubscription {
  /** 套餐 ID（如 individual-pro / individual-goat / individual-max / teams-pro） */
  planId?: string
  /** 订阅状态（active / trialing / past_due / canceled / inactive，未知值原样保留） */
  status?: string
  /** 席位数量（org 套餐月度额度 = 基础额度 × 席位；缺失视为 1） */
  quantity?: number
  /** 当前计费周期结束时间：ISO 原样保留（若有）。续费开启时为「下次续费时间」，排定取消时为「服务到期时间」 */
  currentPeriodEnd?: string
  /** 当前周期结束时间归一化（epoch 秒；兼容 ISO / epoch 秒 / epoch 毫秒来源） */
  currentPeriodEndTs?: number
  /** 期末取消标记（cancel_at_period_end）：true = 已排定取消、到期不续费；false = 自动续费开启 */
  cancelAtPeriodEnd?: boolean
  /** 已排定取消（cancelAtPeriodEnd=true 或 cancelAt 有值）。字段缺失 = 信息不明，不推断 */
  cancelScheduled?: boolean
  /** 排定取消时间（epoch 秒；cancelAt 有值时） */
  cancelAtTs?: number
  /** 取消完成时间（epoch 秒；canceledAt 有值时） */
  canceledAtTs?: number
  /** 订阅结束时间（epoch 秒；endedAt 有值时） */
  endedAtTs?: number
  /** 计划变更过渡（如降级排定在周期末生效） */
  pendingPhase?: { unitAmount?: number; currency?: string; effectiveDateTs?: number }
}

/** Command Code 用量归一化数据。区块可选：对应端点失败时 absent（见 sourcesAvailable） */
export interface CommandCodeUsage {
  fetchedAt: number
  sourcesAvailable: {
    summary: boolean
    /** 由 /internal/usage 逐条记录聚合出的模型明细（「云端窗口」口径：受服务端 100 条硬上限） */
    listAggregate: boolean
    credits: boolean
    windows: boolean
    subscription: boolean
    /** /internal/usage/charts（「模型 × 时间桶」服务端预聚合，「服务端聚合」口径） */
    chartsEndpoint: boolean
  }
  summary?: {
    totalCount: number
    totalCost: number
    totalTokens: number
    successRate: number
    /**
     * 统计口径（服务端 periodBasis）：'billing-period' = 当前计费月、'last-30-days' = 最近 30 天，未知值原样保留。
     * 与「模型明细」（最近 100 条记录聚合 / 本地累计）口径不同，二者合计不应相等。
     */
    periodBasis?: string
  }
  credits?: { monthlyCredits: number }
  /** 额度窗口：5h/7d 滚动窗口；monthly = 账单月额度（已用% 按官网口径推算，见 computeMonthlyWindow） */
  windows?: { fiveHour?: UsageWindowInfo; weekly?: UsageWindowInfo; monthly?: UsageWindowInfo }
  /** 订阅套餐（含到期时间）；无订阅时 absent（sourcesAvailable.subscription 仍为 true） */
  subscription?: CommandCodeSubscription
  models?: Array<{
    model: string
    requests: number
    cost: number
    tokensIn: number
    tokensOut: number
    tokensTotal: number
  }>
  /** 服务端「模型 × 时间桶」聚合（/internal/usage/charts；与汇总 summary 同区间） */
  monthlyModels?: {
    rows: Array<{
      model: string
      requests: number
      cost: number
      tokensIn: number
      tokensOut: number
      tokensTotal: number
      cacheCost: number
      cacheSavings: number
    }>
    /** 服务端返回的时间桶个数（说明聚合粒度覆盖了多少桶） */
    buckets: number
    /** 服务端给出的统计区间（响应 window） */
    window?: { from?: string; to?: string; fromTs?: number; toTs?: number; periodBasis?: string }
  }
  /** 模型明细的数据覆盖情况（明细由 /internal/usage 请求记录聚合而来，见 coverage.records） */
  modelsCoverage?: {
    /** 已聚合的请求记录条数 */
    records: number
    /** true = 仍有更早的记录未纳入（页数/耗时上限，或后续页请求失败） */
    truncated: boolean
    /** 服务端记录保留窗口天数（响应 window.days，未知时省略） */
    windowDays?: number
    /** 已聚合记录的最早时间（epoch 毫秒）：说明明细覆盖的时间跨度起点 */
    fromTs?: number
    /** 已聚合记录的最新时间（epoch 毫秒） */
    toTs?: number
  }
}

/** 监控源当前认证状态 */
export interface MonitorStatus {
  loggedIn: boolean
  hasApiKey: boolean
}

/** 采集器持久化运行状态（cc_collector_state；"采集成功但没有新记录"时也能证明采集器在跑） */
export interface CollectorRunState {
  /** 最近一次采集时间（epoch 毫秒） */
  lastRunAt?: number
  /** 最近一次成功采集时间（epoch 毫秒） */
  lastOkAt?: number
  /** 最近一次失败原因（成功时清空） */
  lastError?: string
  /** 累计采集轮数 */
  runs: number
  /** 其中成功的轮数 */
  okRuns: number
  /** 累计新增记录条数 */
  totalInserted: number
}

/** 本地累计的按模型用量（Command Code；由多次采集到的记录去重累积而来） */
export interface CumulativeModelUsage {
  models: Array<{
    model: string
    requests: number
    cost: number
    tokensIn: number
    tokensOut: number
    tokensTotal: number
  }>
  /** 累计覆盖的记录条数（去重后） */
  records: number
  /** 累计记录的最早时间（epoch 毫秒） */
  fromTs?: number
  /** 累计记录的最新时间（epoch 毫秒） */
  toTs?: number
  /** 本地首次采集时间（epoch 毫秒）：说明"累计自何时起" */
  sinceTs?: number
  /** 最近一次采集时间（epoch 毫秒） */
  lastCollectedAt?: number
  /** 采集器运行状态（是否还在跑、已跑多少轮、失败几次） */
  collectorState?: CollectorRunState
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

// ─── 定价探查（LLM 自动更新官方定价）───

/** 峰谷时段价：请求时间落在 [start, end) 内且星期匹配则用窗口价，否则用基础价 */
export interface PricingWindow {
  /** 时段开始 'HH:mm'，24h */
  start: string
  /** 时段结束 'HH:mm'，24h；start > end 表示跨午夜 */
  end: string
  /** USD / 1M tokens */
  input: number
  output: number
  /** 适用的星期：0=周日 .. 6=周六（JS Date.getDay() 语义）。缺省/空 = 每天 */
  days?: number[]
}

/** 一条探查到的官方定价（统一存储为 USD / 1M tokens） */
export interface ProbedPricingEntry {
  /** 模型 ID 前缀（最长前缀匹配，与 DEFAULT_PRICING 语义一致） */
  pattern: string
  input: number
  output: number
  cacheRead?: number
  cacheCreation?: number
  /** 峰谷时段价（可空 = 无时段价） */
  windows?: PricingWindow[]
  /** 窗口时区（IANA），探查时从源写入，默认 Asia/Shanghai */
  timezone?: string
  /** 官方页原始币种（存储价格统一折算为 USD） */
  currency?: 'USD' | 'CNY'
  /** 官方页计费单位描述（如 "per 1M tokens" / "per 1K tokens" / "per request"）；空则按 1M tokens */
  unit?: string
  /** 来源与时间元数据（UI 展示 + 自动刷新判断） */
  sourceId: string
  sourceUrl: string
  fetchedAt: number
}

/** 一个定价探查源 */
export interface PricingProbeSource {
  id: string
  name: string
  /** 绑定的厂商 ID（已配置 API Key 的 provider）；模型关键词自动取该厂商 /models 的模型名 */
  providerId?: string
  /** 官方定价页 URL */
  url: string
  /** 峰谷时段基准时区（IANA，默认 Asia/Shanghai） */
  timezone?: string
  enabled: boolean
  /** 探查前是否先执行 /models 获取/更新该厂商的模型 ID 作为提取关键词（缺省 = true） */
  fetchModelsBeforeProbe?: boolean
}

/** 单个源的页面级探查缓存（独立于 sources 持久化，UI 编辑源时不会误覆盖） */
export interface PricingPageCache {
  /** 上次抓取全文本的哈希（空白归一化后）。相同 → 页面未变更，跳过 LLM 直接沿用旧结果 */
  hash?: string
  /** 定价区块起始锚文本（原文连续片段，用于下次定位时 indexOf 切取） */
  fragmentFrom?: string
  /** 定价区块结束锚文本 */
  fragmentTo?: string
}

/** 定价探查进度事件（main → renderer，探查过程中实时推送） */
export interface ProbeProgressEvent {
  /** 当前探查的源 ID（用于 UI 定位到对应源卡片） */
  sourceId: string
  /** 当前探查的源名 */
  sourceName: string
  /** 当前源序号（从 1 开始） */
  index: number
  /** 源总数 */
  total: number
  /** 当前阶段：抓取页面 / 大模型解析 */
  stage: 'fetching' | 'extracting'
  /** 该源是否已完成（最后一个进度事件，携带结果） */
  done?: boolean
  ok?: boolean
  entryCount?: number
  error?: string
  /** 页面未变更、沿用旧结果（未调用 LLM） */
  skipped?: boolean
}

export interface PricingProbeSettings {
  sources: PricingProbeSource[]
  /** 自动刷新间隔（秒），0 = 关闭（默认 0）。UI 按时/分/秒拆分设置 */
  autoRefreshSeconds: number
  /** 探查用模型（'providerId:modelId' 格式）；缺省回退聚合模型 */
  probeModelId?: string
}

/** pricing:probeRun 返回的单个源探查结果 */
export interface PricingProbeResultItem {
  sourceId: string
  ok: boolean
  entryCount?: number
  error?: string
  /** 页面未变更、沿用旧结果（未调用 LLM） */
  skipped?: boolean
}

// ─── 悬浮通知（renderer Toast）───

export type ToastType = 'info' | 'warning' | 'success' | 'error'

/** 渲染进程悬浮通知内容（renderer store 内部使用 + 主进程经 IPC_EVENT.RENDERER_TOAST 推送） */
export interface ToastData {
  type: ToastType
  title: string
  message?: string
  /** 展示时长（ms），<=0 或省略时用默认值 */
  duration?: number
}
