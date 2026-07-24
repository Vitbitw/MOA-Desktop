import type { SubModelConfig, AggregatorConfig, MoAMode } from '../../shared/types'

export interface MoaRuntimeConfig {
  mode: MoAMode
  subModels: SubModelConfig[]
  aggregator: AggregatorConfig | null
  aggregationPromptVariant: 'standard-zh' | 'concise-en' | 'custom'
  customAggregationPrompt?: string
}

let currentConfig: MoaRuntimeConfig = {
  mode: 'direct',
  subModels: [],
  aggregator: null,
  aggregationPromptVariant: 'standard-zh'
}

export function getMoaConfig(): MoaRuntimeConfig {
  return { ...currentConfig }
}

export function setMoaConfig(config: Partial<MoaRuntimeConfig>): MoaRuntimeConfig {
  currentConfig = { ...currentConfig, ...config }
  console.log('[MoA Config] Updated:', JSON.stringify(currentConfig, null, 2))
  return getMoaConfig()
}
