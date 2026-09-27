import crypto from 'node:crypto'
import type { SubModelConfig, AggregatorConfig, MoAMode, MoaArchitecture } from '../../shared/types'
import { getRoleTemplate } from '../../shared/moaRoles'
import { getDatabase } from '../db/database'

const CONFIG_KEY = 'moa_runtime_config'

export interface MoaRuntimeConfig {
  /** 已废弃：网关出口模式见 gatewayDirectModel（缺省聚合）；聊天模式由输入框按钮控制，此字段不再影响行为（保留仅为旧配置兼容） */
  mode: MoAMode
  subModels: SubModelConfig[]
  aggregator: AggregatorConfig | null
  aggregationPromptVariant: 'standard-zh' | 'concise-en' | 'custom'
  customAggregationPrompt?: string
  /** 协作架构：'election'（选举/拼接）| 'committee'（主席团/专家意见）。旧配置缺省 'election' */
  architecture: MoaArchitecture
  /** 网关独立协作架构：缺省（undefined）= 跟随全局 architecture；仅影响网关出口（聊天侧恒用全局） */
  gatewayArchitecture?: MoaArchitecture
  /** 网关出口模式：单模型直通模型（'providerId:modelId'，splitModelKey 解析）；缺省（undefined）= 聚合（席位全体参与）。
   *  仅影响网关出口（聊天侧不受影响）；配置失效（厂商被删/停用/不可用、模型不在其列表）时网关回落常规链路 */
  gatewayDirectModel?: string
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
      // 防御：非数组垃圾值（旧版本/手工改库）会让 getMoaConfig 的 .map 抛 TypeError
      const subModels: SubModelConfig[] = Array.isArray(parsed.subModels) ? parsed.subModels : []
      // 旧配置迁移（N-5）：主进程一次性补全缺失的席位 id 并落库（幂等：已有 id 的项不动）。
      // 渲染端不再补 id —— 避免 providers 变化触发的二次加载重新生成 id、打断编辑态。
      let migrated = false
      for (const sm of subModels) {
        if (sm && typeof sm === 'object' && !sm.id) {
          sm.id = crypto.randomUUID()
          migrated = true
        }
      }
      // 旧配置迁移（v9）：① v8 角色三态残留清收——非自定义模式（customRole===false）下残留的
      // expertName 在 v8 运行时不生效，清除以保持一致；② 预设角色退役 → 转为等价自定义角色
      // （名字=模板名、介绍=模板提示词；已有自定义内容优先保留），role 清空；③ customRole 字段退役。
      for (const sm of subModels) {
        if (!sm || typeof sm !== 'object') continue
        if (sm.customRole === false && sm.expertName !== undefined) {
          sm.expertName = undefined
          migrated = true
        }
        if (sm.role) {
          const tpl = getRoleTemplate(sm.role)
          if (!(sm.expertName ?? '').trim()) sm.expertName = tpl?.label ?? sm.role
          if (!(sm.systemPrompt ?? '').trim() && tpl?.systemPrompt) sm.systemPrompt = tpl.systemPrompt
          sm.role = ''
          migrated = true
        }
        if (sm.customRole !== undefined) {
          delete sm.customRole
          migrated = true
        }
      }
      currentConfig = {
        mode: parsed.mode || 'direct',
        subModels,
        aggregator: parsed.aggregator || null,
        aggregationPromptVariant: parsed.aggregationPromptVariant || 'standard-zh',
        customAggregationPrompt: parsed.customAggregationPrompt,
        architecture: parsed.architecture || 'election',
        gatewayArchitecture: parsed.gatewayArchitecture || undefined,
        // 防御：非字符串垃圾值（手工改库）会让 splitModelKey 抛错——加载期收敛为 undefined
        gatewayDirectModel:
          typeof parsed.gatewayDirectModel === 'string' && parsed.gatewayDirectModel !== ''
            ? parsed.gatewayDirectModel
            : undefined
      }
      if (migrated) {
        // 回写失败仅记日志、不阻断加载（内存态已带新 id，本次会话可用；下次启动重试落库）
        try {
          getDatabase().exec(
            'INSERT OR REPLACE INTO moa_config (key, value, updated_at) VALUES (?, ?, ?)',
            [CONFIG_KEY, JSON.stringify(currentConfig), Date.now()]
          )
          console.log('[MoA Config] Migrated subModels seat ids to DB')
        } catch (err) {
          console.error('[MoA Config] Failed to persist seat id migration:', err)
        }
      }
      // 摘要一行：完整 dump 会把每个子模型的 systemPrompt 原文（数 KB）刷进日志，既刷屏又无人看
      console.log(
        `[MoA Config] Loaded from DB: 架构=${currentConfig.architecture}, 网关架构=${currentConfig.gatewayArchitecture ?? '跟随'}, 网关出口=${currentConfig.gatewayDirectModel ? `直通(${currentConfig.gatewayDirectModel})` : '聚合'}, 子模型=${currentConfig.subModels.length}, 聚合=${currentConfig.aggregator?.primaryModelId ?? '无'}`
      )
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
    architecture: currentConfig.architecture,
    gatewayArchitecture: currentConfig.gatewayArchitecture,
    gatewayDirectModel: currentConfig.gatewayDirectModel
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
