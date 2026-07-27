import type { AppSettings } from './types'

export const DEFAULT_PORT = 28888
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_MAX_CONCURRENCY = 3
export const DEFAULT_SUB_MODEL_TIMEOUT = 60_000
export const DEFAULT_AGGREGATOR_TIMEOUT = 120_000
export const DEFAULT_SUB_OUTPUT_ESTIMATE = 500
export const DEFAULT_AGG_OUTPUT_ESTIMATE = 800
export const DEFAULT_QUEUE_MAX = 50

export const DEFAULT_TITLE_SETTINGS = {
  autoMode: 'first_and_manual' as const,
  realtimeMode: 'every_n_rounds' as const,
  realtimeN: 5,
  providerId: '',
  modelId: '',
  maxLength: 50,
  language: 'auto' as const
}

export const DEFAULT_SETTINGS: AppSettings = {
  title: DEFAULT_TITLE_SETTINGS,
  proxy: {
    enabled: true,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    defaultModelId: '',
    authEnabled: false,
    proxyKey: '',
    recording: 'full',
    transparency: 'default'
  },
  display: {
    subModelShow: 'hidden',
    defaultSubModelExpanded: false,
    autoClearSubOutputs: false
  },
  pricing: {},
  currency: 'USD'
}

// 部分厂商条目参考自 cc-switch (MIT) by farion1231
// https://github.com/farion1231/cc-switch
export const BUILT_IN_PROVIDER_TEMPLATES = [
  // ── 国际主流 ──
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  { name: 'Google (Gemini)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  { name: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1' },
  { name: 'Cohere', baseUrl: 'https://api.cohere.com/v1' },
  { name: 'xAI', baseUrl: 'https://api.x.ai/v1' },

  // ── 聚合 / 路由平台 ──
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { name: 'Together AI', baseUrl: 'https://api.together.xyz/v1' },
  { name: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1' },
  { name: 'NewAPI', baseUrl: 'https://www.newapi.pro' },
  { name: 'TheRouter', baseUrl: 'https://api.therouter.ai' },
  { name: 'CherryIN', baseUrl: 'https://open.cherryin.net' },

  // ── 高性能推理 ──
  { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  { name: 'Perplexity', baseUrl: 'https://api.perplexity.ai' },
  { name: 'Replicate', baseUrl: 'https://api.replicate.com/v1' },

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
