// ─── 专家团生成器（主席团模式：AI 生成专家团）───
// 按用户任务需求 → LLM 规划专家团队（推荐数量 + 每专家 角色名/systemPrompt）。
// 复用：streamChat（fetchProxy + 回退链 + 三档超时）、probe 的宽容 JSON 提取。
// 生成模型解析：主模型（聚合模型）→ 首个可用子模型 → 首个可用厂商首模型 → 抛错。

import { getAllProviders } from '../providers/providerManager'
import { getMoaConfig } from './moaConfig'
import { streamChat } from './streamChat'
import { extractJsonArray, extractJsonObject } from '../pricing/probe'
import { DEFAULT_SUB_MODEL_TIMEOUT } from '../../shared/defaults'
import type { ExpertTeamPlan, GeneratedExpert } from '../../shared/types'

const EXPERT_NAME_MAX = 50
const EXPERT_PROMPT_MAX = 4000

/** 码点安全截断（N-2）：超长时按 Unicode 码点取前 max 个（不切裂 emoji 代理对）；未超长原样返回（BMP 与 slice 等价） */
const clip = (s: string, max: number): string => (s.length > max ? [...s].slice(0, max).join('') : s)

export interface GenerateExpertsRequest {
  requirement: string
  seats: string[]
}

interface RawExpert {
  name?: unknown
  prompt?: unknown
}

interface GeneratorModel {
  providerId: string
  baseUrl: string
  apiKey?: string
  modelId: string
}

// ─── 生成模型解析 ───

/** 解析生成用模型：主模型（聚合模型）→ 首个可用子模型 → 首个可用厂商首模型 → null（调用方抛错） */
export function resolveGeneratorModel(): GeneratorModel | null {
  const config = getMoaConfig()
  const providers = getAllProviders()

  // ① 主模型（聚合模型）
  const agg = config.aggregator
  if (agg?.primaryProviderId && agg?.primaryModelId) {
    const p = providers.find((prov) => prov.id === agg.primaryProviderId)
    if (p?.enabled && p.apiKey) {
      return { providerId: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey, modelId: agg.primaryModelId }
    }
  }

  // ② 首个可用子模型（subModels[0] 对应厂商）
  const firstSub = config.subModels[0]
  if (firstSub) {
    const p = providers.find((prov) => prov.id === firstSub.providerId)
    if (p?.enabled && p.apiKey) {
      return { providerId: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey, modelId: firstSub.modelId }
    }
  }

  // ③ 首个已启用且配 Key 的厂商的首个模型
  for (const p of providers) {
    if (!p.enabled || !p.apiKey) continue
    const m = p.models?.[0]
    if (m?.id) return { providerId: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey, modelId: m.id }
  }

  return null
}

// ─── Prompt 构建 ───

/** 构建专家团规划 prompt（全文逐字对齐设计文档 §5.3） */
export function buildExpertPlanPrompt(req: GenerateExpertsRequest): string {
  const requirement = req?.requirement ?? ''
  const seats = Array.isArray(req?.seats) ? req.seats.filter((s): s is string => typeof s === 'string') : []
  return `你是多模型协作（主席团模式）的专家团队规划师。用户将描述一个任务需求，你要为它规划一支专家团队。

【任务需求】
${requirement}

【当前配置】
- 已配置专家席位：${seats.length} 个${seats.length ? `（${seats.join('、')}）` : '（无，将自动创建席位）'}
- 系统会自动扩充/缩减席位以匹配你推荐的专家数量（新席位默认复用现有第一个席位的模型）

【规划要求】
1. 推荐专家数量：根据任务的复杂度与维度决定，通常 2-6 位；特别简单的任务也可只用 1-2 位。
2. 每位专家给出：
   - name：简洁中文角色名（2-8 字，如「安全工程师」「性能专家」「产品经理」），避免泛泛的「专家」
   - prompt：该专家的 system prompt（150-300 字），要求：
     · 第二人称角色设定（「你是一位……」），说明身份与专长；
     · 明确该专家的分析视角、关注点与输出要求；
     · 各专家视角互补、覆盖解决该任务的不同关键维度，避免重复；
     · 结尾要求该专家「参考本轮上下文，只输出你的意见」。
3. 专家团队整体应覆盖解决该任务所需的关键维度（领域专家 + 批判者 + 落地执行者等按需组合）。

【输出要求】
只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释：
{"reason": "一句话说明推荐这个数量的理由", "experts": [{"name": "...", "prompt": "..."}]}`
}

// ─── 解析与校验 ───

/**
 * 解析 LLM 输出为专家列表（导出供 T4 测试直接引用）：
 * 优先取 JSON 对象的 experts 数组，否则宽容提取数组（含 experts 包裹键）；
 * name / prompt 均为非空字符串才保留，name 截断 50、prompt 截断 4000。
 */
export function parseExpertPlan(content: string): { reason?: string; experts: GeneratedExpert[] } {
  const obj = extractJsonObject(content)
  const rawList: RawExpert[] =
    obj && Array.isArray(obj.experts) ? (obj.experts as RawExpert[]) : extractJsonArray<RawExpert>(content) ?? []

  const experts: GeneratedExpert[] = []
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : ''
    if (!name || !prompt) continue
    experts.push({ name: clip(name, EXPERT_NAME_MAX), prompt: clip(prompt, EXPERT_PROMPT_MAX) })
  }

  const reason = obj && typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim() : undefined
  return reason !== undefined ? { reason, experts } : { experts }
}

// ─── 入口（IPC moa:generateExperts）───

/** 按任务需求生成专家团；一切失败场景均 throw Error（IPC 层包装为 {success:false, error}） */
export async function generateExpertTeam(req: GenerateExpertsRequest): Promise<ExpertTeamPlan> {
  const requirement = typeof req?.requirement === 'string' ? req.requirement.trim() : ''
  if (!requirement) throw new Error('需求描述为空')

  const model = resolveGeneratorModel()
  if (!model) throw new Error('未配置可用的生成模型：请先配置厂商 API Key 或 MoA 主模型')

  const seats = Array.isArray(req?.seats) ? req.seats.filter((s): s is string => typeof s === 'string') : []
  const prompt = buildExpertPlanPrompt({ requirement, seats })

  const result = await streamChat({
    providerBaseUrl: model.baseUrl,
    apiKey: model.apiKey,
    modelId: model.modelId,
    messages: [{ role: 'user', content: prompt }],
    timeoutMs: DEFAULT_SUB_MODEL_TIMEOUT
  })
  if (result.error !== undefined) throw new Error(`生成失败：${result.error}`)

  const { reason, experts } = parseExpertPlan(result.content)
  if (experts.length === 0) throw new Error('未能解析出有效专家列表，请重试')

  const plan: ExpertTeamPlan = { experts, modelId: model.modelId, providerId: model.providerId }
  if (reason !== undefined) plan.reason = reason
  return plan
}
