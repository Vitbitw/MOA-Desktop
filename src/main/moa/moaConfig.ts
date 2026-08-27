import type { SubModelConfig, AggregatorConfig, MoAMode } from '../../shared/types'
import { getDatabase } from '../db/database'

const CONFIG_KEY = 'moa_runtime_config'

export interface MoaRuntimeConfig {
  mode: MoAMode
  subModels: SubModelConfig[]
  aggregator: AggregatorConfig | null
  aggregationPromptVariant: 'standard-zh' | 'concise-en' | 'custom'
  customAggregationPrompt?: string
}

interface DbConfigRow {
  value: string
}

let currentConfig: MoaRuntimeConfig = {
  mode: 'direct',
  subModels: [],
  aggregator: null,
  aggregationPromptVariant: 'standard-zh'
}

/** Load MoA config from database. Call once after db.init(). */
export function loadMoaConfigFromDb(): void {
  try {
    const row = getDatabase().queryOne<DbConfigRow>(
      "SELECT value FROM moa_config WHERE key = ?",
      [CONFIG_KEY]
    )
    if (row && row.value) {
      const parsed = JSON.parse(row.value)
      currentConfig = {
        mode: parsed.mode || 'direct',
        subModels: parsed.subModels || [],
        aggregator: parsed.aggregator || null,
        aggregationPromptVariant: parsed.aggregationPromptVariant || 'standard-zh',
        customAggregationPrompt: parsed.customAggregationPrompt
      }
      console.log('[MoA Config] Loaded from DB:', JSON.stringify(currentConfig))
    }
  } catch (err) {
    console.error('[MoA Config] Failed to load from DB:', err)
  }
}

export function getMoaConfig(): MoaRuntimeConfig {
  // 深拷贝：subModels/aggregator 数组/对象不能暴露引用，否则渲染端改数组会污染主进程内存态
  return {
    ...currentConfig,
    subModels: currentConfig.subModels.map((sm) => ({ ...sm })),
    aggregator: currentConfig.aggregator ? { ...currentConfig.aggregator } : null,
    customAggregationPrompt: currentConfig.customAggregationPrompt
  }
}

export function setMoaConfig(config: Partial<MoaRuntimeConfig>): MoaRuntimeConfig {
  currentConfig = { ...currentConfig, ...config }

  // Persist to database
  try {
    getDatabase().exec(
      'INSERT OR REPLACE INTO moa_config (key, value, updated_at) VALUES (?, ?, ?)',
      [CONFIG_KEY, JSON.stringify(currentConfig), Date.now()]
    )
    console.log('[MoA Config] Saved to DB')
  } catch (err) {
    console.error('[MoA Config] Failed to save to DB:', err)
  }

  return getMoaConfig()
}
