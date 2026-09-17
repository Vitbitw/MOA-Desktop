import type { SubModelConfig, AggregatorConfig, MoAMode, MoaArchitecture } from '../../shared/types'
import { getDatabase } from '../db/database'

const CONFIG_KEY = 'moa_runtime_config'

export interface MoaRuntimeConfig {
  mode: MoAMode
  subModels: SubModelConfig[]
  aggregator: AggregatorConfig | null
  aggregationPromptVariant: 'standard-zh' | 'concise-en' | 'custom'
  customAggregationPrompt?: string
  /** 协作架构：'election'（选举/拼接）| 'committee'（主席团/专家意见）。旧配置缺省 'election' */
  architecture: MoaArchitecture
}

interface DbConfigRow {
  value: string
}

let currentConfig: MoaRuntimeConfig = {
  mode: 'direct',
  subModels: [],
  aggregator: null,
  aggregationPromptVariant: 'standard-zh',
  architecture: 'election'
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
        // 防御：非数组垃圾值（旧版本/手工改库）会让 getMoaConfig 的 .map 抛 TypeError
        subModels: Array.isArray(parsed.subModels) ? parsed.subModels : [],
        aggregator: parsed.aggregator || null,
        aggregationPromptVariant: parsed.aggregationPromptVariant || 'standard-zh',
        customAggregationPrompt: parsed.customAggregationPrompt,
        architecture: parsed.architecture || 'election'
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
    customAggregationPrompt: currentConfig.customAggregationPrompt,
    architecture: currentConfig.architecture
  }
}

export function setMoaConfig(config: Partial<MoaRuntimeConfig>): MoaRuntimeConfig {
  // 先写 DB 再提交内存态：写入失败直接抛错（调用方 IPC handler 包装后渲染端收到 {success:false}），
  // 避免「渲染端以为保存成功、重启后回退」；内存态不被未落盘的脏值污染
  const nextConfig = { ...currentConfig, ...config }
  getDatabase().exec(
    'INSERT OR REPLACE INTO moa_config (key, value, updated_at) VALUES (?, ?, ?)',
    [CONFIG_KEY, JSON.stringify(nextConfig), Date.now()]
  )
  currentConfig = nextConfig
  console.log('[MoA Config] Saved to DB')
  return getMoaConfig()
}
