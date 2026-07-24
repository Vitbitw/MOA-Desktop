import type { AppSettings } from './types'

export const DEFAULT_PORT = 28888
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_MAX_CONCURRENCY = 3
export const DEFAULT_SUB_MODEL_TIMEOUT = 60_000
export const DEFAULT_AGGREGATOR_TIMEOUT = 120_000
export const DEFAULT_SUB_OUTPUT_ESTIMATE = 500
export const DEFAULT_AGG_OUTPUT_ESTIMATE = 800
export const DEFAULT_QUEUE_MAX = 50

export const DEFAULT_SETTINGS: AppSettings = {
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

export const BUILT_IN_PROVIDER_TEMPLATES = [
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { name: 'Google (Gemini)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  { name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1' }
]
