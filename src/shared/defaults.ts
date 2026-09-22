import type { AppSettings, MonitoringSettings, PricingProbeSource } from './types'

export const DEFAULT_PORT = 28888
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_MAX_CONCURRENCY = 3
export const DEFAULT_SUB_MODEL_TIMEOUT = 60_000
export const DEFAULT_AGGREGATOR_TIMEOUT = 120_000
/** 流式调用空闲超时（毫秒）：chunk 间隔超过该值即中断，每收到一个 chunk 重置 */
export const DEFAULT_STREAM_IDLE_TIMEOUT = 30_000
/** 流式调用总时长上限（毫秒）：绝对保护，超时即中断（不重置） */
export const DEFAULT_STREAM_MAX_TIMEOUT = 300_000

export const DEFAULT_TITLE_SETTINGS = {
  autoMode: 'first_and_manual' as const,
  realtimeMode: 'every_n_rounds' as const,
  realtimeN: 5,
  providerId: '',
  modelId: '',
  maxLength: 50,
  language: 'auto' as const
}

/** 云端用量监控默认配置：预置启用的 Command Code / Xiaomi MiMo / DeepSeek 源 */
export const DEFAULT_MONITORING: MonitoringSettings = {
  sources: [
    {
      id: 'commandcode',
      type: 'commandcode',
      name: 'Command Code 云端',
      studioUrl: 'https://commandcode.ai/studio',
      enabled: true
    },
    {
      id: 'mimo',
      type: 'mimo',
      name: 'Xiaomi MiMo',
      studioUrl: 'https://platform.xiaomimimo.com/console/plan-manage',
      enabled: true
    },
    {
      id: 'deepseek',
      type: 'deepseek',
      name: 'DeepSeek 开放平台',
      studioUrl: 'https://platform.deepseek.com/usage',
      enabled: true
    }
  ],
  // 统一自动刷新间隔（分钟）：云监控页面数据刷新 + Command Code 后台明细采集共用；0 = 关闭
  autoRefreshMinutes: 10
}

/** 定价探查默认源：官方定价页 URL（关键词自动取所绑定厂商 /models 的模型名，用户可在设置页修改/增删） */
export const DEFAULT_PRICING_PROBE_SOURCES: PricingProbeSource[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
    timezone: 'Asia/Shanghai',
    enabled: true
  },
  {
    id: 'openai',
    name: 'OpenAI',
    url: 'https://openai.com/api/pricing/',
    enabled: true
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    url: 'https://www.anthropic.com/pricing',
    enabled: true
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    url: 'https://open.bigmodel.cn/pricing',
    enabled: true
  },
  {
    id: 'qwen',
    name: '阿里云百炼 Qwen',
    url: 'https://help.aliyun.com/zh/model-studio/models',
    enabled: true
  },
  {
    id: 'kimi',
    name: '月之暗面 Kimi',
    url: 'https://platform.moonshot.cn/docs/pricing/chat',
    enabled: true
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    url: 'https://www.minimax.io/platform/document/price',
    enabled: true
  },
  {
    // Command Code：探测实际用「按订阅套餐动态解析的计划页」（probe.ts resolveProbeUrl），
    // 此 URL 仅作套餐解析失败时的回退页（有全模型 per-1M 单价、无每模型额度）
    id: 'commandcode',
    name: 'Command Code',
    url: 'https://commandcode.ai/docs/resources/pricing-limits',
    enabled: true
  }
]

/** 按厂商名称返回预置的官方定价页 URL（新建源时用于预填），无匹配返回空串 */
export function defaultPricingProbeUrlByName(name: string): string {
  const n = name.trim().toLowerCase()
  return DEFAULT_PRICING_PROBE_SOURCES.find((s) => s.name.trim().toLowerCase() === n)?.url ?? ''
}

export const DEFAULT_PRICING_PROBE = {
  sources: DEFAULT_PRICING_PROBE_SOURCES,
  autoRefreshSeconds: 0
}

export const DEFAULT_SETTINGS: AppSettings = {
  title: DEFAULT_TITLE_SETTINGS,
  gateway: {
    enabled: true,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    authEnabled: false,
    gatewayKey: '',
    recording: 'full',
    transparency: 'default'
  },
  network: {
    enabled: false,
    proxyUrl: '',
    timeoutMs: 15_000,
    retryCount: 2
  },
  display: {
    usageOverlay: false
  },
  pricing: {},
  currency: 'USD',
  monitoring: DEFAULT_MONITORING,
  probedPricing: [],
  pricingProbe: DEFAULT_PRICING_PROBE
}

// 部分厂商条目参考自 cc-switch (MIT) by farion1231
// https://github.com/farion1231/cc-switch
// 「hermes-agent 补充批次」条目取自 NousResearch/hermes-agent (MIT) 的
// plugins/model-providers/ 与 hermes_cli/auth.py 官方注册表（baseUrl 均为源码原值），
// 仅收录 OpenAI chat/completions 协议 + Bearer API key 直连的 provider；
// OAuth 登录、Anthropic/Responses 专属协议、无固定端点者不收。
export const BUILT_IN_PROVIDER_TEMPLATES = [
  // ── 国际主流 ──
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  { name: 'Google (Gemini)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  { name: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1' },
  { name: 'Cohere', baseUrl: 'https://api.cohere.com/v1' },
  { name: 'xAI', baseUrl: 'https://api.x.ai/v1' },
  { name: 'Nous Research', baseUrl: 'https://inference-api.nousresearch.com/v1' },
  { name: 'Meta Model API', baseUrl: 'https://api.meta.ai/v1' },
  { name: 'Upstage Solar', baseUrl: 'https://api.upstage.ai/v1' },
  { name: 'Arcee AI', baseUrl: 'https://api.arcee.ai/api/v1' },

  // ── 云端 Agent 平台（订阅制 / 编程套餐） ──
  { name: 'Command Code', baseUrl: 'https://api.commandcode.ai/provider/v1' },
  { name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1' },
  { name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1' },
  { name: 'Kilo Code', baseUrl: 'https://api.kilo.ai/api/gateway' },
  { name: 'Kimi Coding Plan', baseUrl: 'https://api.kimi.com/coding/v1' },
  { name: '阿里云 Coding Plan', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1' },
  { name: '阿里云 Coding Plan (国际)', baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1' },

  // ── 聚合 / 路由平台 ──
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { name: 'Together AI', baseUrl: 'https://api.together.xyz/v1' },
  { name: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1' },
  { name: 'NewAPI', baseUrl: 'https://www.newapi.pro' },
  { name: 'TheRouter', baseUrl: 'https://api.therouter.ai' },
  { name: 'CherryIN', baseUrl: 'https://open.cherryin.net' },
  { name: 'Vercel AI Gateway', baseUrl: 'https://ai-gateway.vercel.sh/v1' },
  { name: 'Hugging Face', baseUrl: 'https://router.huggingface.co/v1' },
  { name: 'Tencent TokenHub', baseUrl: 'https://tokenhub.tencentmaas.com/v1' },
  { name: '阿里云 Token Plan', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' },
  { name: '阿里云 Token Plan (国际)', baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1' },
  { name: '阿里云百炼 (国际)', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },

  // ── 高性能推理 ──
  { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  { name: 'Perplexity', baseUrl: 'https://api.perplexity.ai' },
  { name: 'Replicate', baseUrl: 'https://api.replicate.com/v1' },
  { name: 'NovitaAI', baseUrl: 'https://api.novita.ai/openai/v1' },
  { name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1' },
  { name: 'DeepInfra', baseUrl: 'https://api.deepinfra.com/v1/openai' },
  { name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1' },
  { name: 'GMI Cloud', baseUrl: 'https://api.gmi-serving.com/v1' },
  { name: 'Nebius Token Factory', baseUrl: 'https://api.tokenfactory.nebius.com/v1' },
  { name: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1' },
  { name: 'Actual Computer', baseUrl: 'https://api.actual.inc/v1' },
  { name: 'StepFun', baseUrl: 'https://api.stepfun.com/step_plan/v1' },
  { name: 'StepFun (国际)', baseUrl: 'https://api.stepfun.ai/step_plan/v1' },

  // ── 国内主流 ──
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1' },
  { name: '智谱AI (GLM)', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { name: '阿里云百炼 (Qwen)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { name: '月之暗面 (Kimi)', baseUrl: 'https://api.moonshot.cn/v1' },
  { name: '零一万物 (Yi)', baseUrl: 'https://api.lingyiwanwu.com/v1' },
  { name: '百度千帆 (ERNIE)', baseUrl: 'https://qianfan.baidubce.com/v2' },
  { name: '火山方舟 (Doubao)', baseUrl: 'https://ark.cn-beijing.volces.com/api/compatible' },
  { name: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1' },
  { name: 'MiniMax (中国)', baseUrl: 'https://api.minimaxi.com/v1' },
  { name: 'Xiaomi MiMo', baseUrl: 'https://api.xiaomimimo.com/v1' },
  { name: 'Z.AI (GLM 国际)', baseUrl: 'https://api.z.ai/api/paas/v4' },
  { name: 'Moonshot AI (国际)', baseUrl: 'https://api.moonshot.ai/v1' },

  // ── 本地推理 ──
  { name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  { name: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
  { name: 'LocalAI', baseUrl: 'http://localhost:8080/v1' },
  { name: 'Jan', baseUrl: 'http://localhost:1337/v1' },

  // ── 第三方中转 / 聚合站 ──
  { name: 'PackyCode', baseUrl: 'https://www.packyapi.com' },
  { name: 'Code0', baseUrl: 'https://code0.ai/v1' },
  { name: 'TeamoRouter', baseUrl: 'https://api.teamorouter.com/v1' },
  { name: 'ClaudeCN', baseUrl: 'https://claudecn.top' },
  { name: 'AICodeMirror', baseUrl: 'https://api.aicodemirror.com/api/claudecode' },
  { name: 'FennoAI', baseUrl: 'https://api.fenno.ai/v1' },
  { name: '七牛 AI', baseUrl: 'https://api.qnaigc.com/bypass/openai/v1' },
  { name: 'Unity2.ai', baseUrl: 'https://api.unity2.ai/v1' },
  { name: 'Shengsuanyun', baseUrl: 'https://router.shengsuanyun.com/api' },
  { name: 'RunAPI', baseUrl: 'https://runapi.co' },
  { name: 'AIGoCode', baseUrl: 'https://api.aigocode.com' },
  { name: 'APIKEY.FUN', baseUrl: 'https://api.apikey.fun' },
  { name: 'SubRouter', baseUrl: 'https://subrouter.ai' }
]

// ── migrate-only 清单（T1）：仅用于 seed 预设与旧数据 backfill，新代码不得引用 ──
// 名称必须与上方 BUILT_IN_PROVIDER_TEMPLATES 的 name 逐字一致（增删模板须同步改清单）。

/** billing='plan' 名称清单（11 条，设计文档 §1：订阅制整组 7 条 + 阿里云 Token Plan 2 条 + StepFun 2 条） */
export const PLAN_BILLING_NAMES: string[] = [
  'Command Code',
  'OpenCode Zen',
  'OpenCode Go',
  'Kilo Code',
  'Kimi Coding Plan',
  '阿里云 Coding Plan',
  '阿里云 Coding Plan (国际)',
  '阿里云 Token Plan',
  '阿里云 Token Plan (国际)',
  'StepFun',
  'StepFun (国际)'
]
