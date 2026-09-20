// ─── 专家团生成器（主席团模式：AI 生成专家团）───
// 按用户任务需求 → LLM 规划专家团队（推荐数量 + 每专家 角色名/systemPrompt）。
// v11：新增生成档位（细分程度三档）与多轮追问（action=ask 判别 + 追问历史；轮数上限 3 后强制生成）。
// 复用：streamChat（fetchProxy + 回退链 + 三档超时）、probe 的宽容 JSON 提取。
// 生成模型解析：主模型（聚合模型）→ 首个可用子模型 → 首个可用厂商首模型 → 抛错。

import { getAllProviders } from '../providers/providerManager'
import { getMoaConfig } from './moaConfig'
import { streamChat } from './streamChat'
import { extractJsonArray, extractJsonObject, isRetriableLLMError } from '../pricing/probe'
import { DEFAULT_SUB_MODEL_TIMEOUT } from '../../shared/defaults'
import type { ClarifyTurn, ExpertGenResult, ExpertScale, GenerateExpertsRequest, GeneratedExpert } from '../../shared/types'

/** 追问轮数上限：达上限后主进程本地强制生成（不再追问） */
export const MAX_CLARIFY_ROUNDS = 3
const EXPERT_NAME_MAX = 50
const EXPERT_PROMPT_MAX = 4000
const EXPERT_QUESTION_MAX = 200
const EXPERT_ANSWER_MAX = 2000
/** 档位说明（Q3 决策：纯定性描述，不给数字） */
const SCALE_TEXT: Record<ExpertScale, string> = {
  few: '偏少：团队精干，每位专家覆盖多个相关维度，人数宜少不宜多。',
  normal: '正常：均衡规划，覆盖任务的关键维度，人数适中。',
  more: '较多：高度细分，每位专家聚焦一个细分方向，覆盖尽量完整的维度，同时避免无意义的冗余与重复。'
}

/** 码点安全截断（N-2）：超长时按 Unicode 码点取前 max 个（不切裂 emoji 代理对）；未超长原样返回（BMP 与 slice 等价） */
const clip = (s: string, max: number): string => (s.length > max ? [...s].slice(0, max).join('') : s)

/** 简易退避等待（上游瞬时故障自动重试用） */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 清洗追问历史（IPC 边界一次清洗；供 prompt 构建与入口共用）：
 * 非数组 → []；逐轮丢弃非对象轮与问题列表无效的轮；问题 trim + 截断 200；
 * 答案对齐问题（非字符串/缺失 → ''，trim + 截断 2000）；轮数截前 MAX_CLARIFY_ROUNDS。
 */
const sanitizeHistory = (raw: unknown): ClarifyTurn[] => {
  if (!Array.isArray(raw)) return []
  const turns: ClarifyTurn[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rawQuestions = (item as { questions?: unknown }).questions
    if (!Array.isArray(rawQuestions)) continue
    const questions = rawQuestions
      .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
      .map((q) => clip(q.trim(), EXPERT_QUESTION_MAX))
    if (questions.length === 0) continue
    const rawAnswers = (item as { answers?: unknown }).answers
    const answers = questions.map((_q, i) => {
      const a = Array.isArray(rawAnswers) ? rawAnswers[i] : undefined
      return typeof a === 'string' ? clip(a.trim(), EXPERT_ANSWER_MAX) : ''
    })
    turns.push({ questions, answers })
  }
  return turns.slice(0, MAX_CLARIFY_ROUNDS)
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

/** 专家团规划 prompt 入参（v11：档位 + 追问历史 + 强制生成） */
export interface ExpertPromptInput {
  requirement: string
  seats: string[]
  scale?: ExpertScale // 缺省 'normal'；非法值按 'normal'
  history?: ClarifyTurn[] // 缺省 []
  force?: boolean // 缺省 false
}

/** 渲染追问历史段（Q/A 逐轮成对；答案为空串 → 「（未补充）」） */
const renderHistoryBlock = (history: ClarifyTurn[]): string => {
  const turns = history.map((turn, i) => {
    const qa = turn.questions.map((q, j) => `- 问：${q}\n- 答：${turn.answers[j] || '（未补充）'}`)
    return `第 ${i + 1} 轮：\n${qa.join('\n')}`
  })
  return `【追问历史】\n${turns.join('\n')}`
}

/** 构建专家团规划 prompt（全文逐字对齐设计文档 §4.2：档位段 + 追问规则 + 历史/强制段按需插入） */
export function buildExpertPlanPrompt(input: ExpertPromptInput): string {
  const requirement = input?.requirement ?? ''
  const seats = Array.isArray(input?.seats) ? input.seats.filter((s): s is string => typeof s === 'string') : []
  // 档位白名单（IPC 边界一次校验）：仅 few / more 显式生效，其余一律 'normal'
  const scale: ExpertScale = input?.scale === 'few' || input?.scale === 'more' ? input.scale : 'normal'
  const history = sanitizeHistory(input?.history)
  const force = input?.force === true

  const head = `你是多模型协作（主席团模式）的专家团队规划师。用户将描述一个任务需求，你要为它规划一支专家团队。

【任务需求】
${requirement}

【当前配置】
- 已配置专家席位：${seats.length} 个${seats.length ? `（${seats.join('、')}）` : '（无，将自动创建席位）'}
- 系统会自动扩充/缩减席位以匹配你推荐的专家数量（新席位默认复用现有第一个席位的模型）

【细分程度】${SCALE_TEXT[scale]}
专家总数与分工颗粒度由你依据该档位自行决定。

【追问规则】
1. 规划前先检查：现有信息是否足以确定专家团队构成？若缺少关键信息（例如：产出物形态、技术栈/平台、面向对象或受众、核心约束、评估标准），先向用户追问，不要凭空假设。
2. 追问只针对「影响专家团队构成」的关键信息；能从需求中合理推断或无关紧要的不要问；每次最多 3 个问题，宁少勿滥。
3. 若提供【追问历史】，结合用户回答判断：信息已足够清晰则直接生成专家团；仍有关键信息不明确可继续追问（同样每次最多 3 个问题；用户留空的问题视为无需补充）。
4. 若【本次要求】写明不得再追问，则跳过追问，直接生成专家团。`

  const blocks: string[] = [head]
  if (history.length > 0) blocks.push(renderHistoryBlock(history))
  if (force) blocks.push('【本次要求】\n用户已选择直接生成：立即生成专家团队，不得再追问。')
  blocks.push(`【专家要求】
1. 每位专家给出：
   - name：简洁中文角色名（2-8 字，如「安全工程师」「性能专家」「产品经理」），避免泛泛的「专家」
   - prompt：该专家的角色描述，即其系统提示词。必须是完整成段的中文（200-350 字；宁详勿简，只写一句身份视为不合格），依次包含四部分：
     ① 身份设定：以「你是一位……」开头，写明具体专长领域与经验背景（1-2 句）；
     ② 职责描述：结合本任务，明确该角色承担的具体职责与重点关注方向（2-3 句，忌空泛套话）；
     ③ 工作方法：该角色分析问题的方法、检查框架或权衡维度（2-3 句）；
     ④ 输出要求：明确输出内容与组织形式，结尾固定写「参考本轮上下文，只输出你的意见」。
2. 各专家的 prompt 之间视角互补、各司其职，避免内容重复；专家团队整体应覆盖解决该任务所需的关键维度（领域专家 + 批判者 + 落地执行者等按需组合），并按【细分程度】控制整体人数与专业颗粒度。

【输出要求】
只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释。
需要追问时输出（action 固定为 ask，questions 1-3 个）：
{"action": "ask", "reason": "一句话说明为何需要追问", "questions": ["问题1", "问题2"]}
规划完成时输出（action 固定为 generate）：
{"action": "generate", "reason": "一句话说明推荐这个团队组成的理由", "experts": [{"name": "...", "prompt": "..."}]}

示例（仅格式与详略程度示意；内容必须按实际任务生成，勿照抄）：
追问：{"action": "ask", "reason": "需求未说明产出物形态与目标平台，无法确定专家构成", "questions": ["这份方案面向哪种交付物：文档、可运行代码还是上线服务？", "是否有指定的技术栈或运行平台？"]}
生成：{"action": "generate", "reason": "覆盖架构、安全、成本与落地四个维度，团队精干", "experts": [{"name": "安全工程师", "prompt": "你是一位深耕应用与供应链安全的资深安全工程师，具备十年以上安全审计与攻防对抗经验。在本次任务中，你负责从安全维度审查方案，重点关注认证授权、输入校验、依赖供应链与数据暴露面。分析时请对照 OWASP Top 10 逐项评估各风险点的触发条件与影响范围，区分高危与低危问题。输出时按风险等级排序，列出每个问题的成因与修复建议。参考本轮上下文，只输出你的意见。"}]}`)
  return blocks.join('\n\n')
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

/** 判别结果：ask → clarify（追问）；experts → plan（生成专家团） */
export type ExpertTeamReply =
  | { kind: 'clarify'; questions: string[]; reason?: string }
  | { kind: 'plan'; experts: GeneratedExpert[]; reason?: string }

/**
 * 解析 LLM 输出为判别结果（v11）：
 * ① action === 'ask' 且问题列表有效（非空字符串、trim + 截断 200、取前 3）→ clarify；
 * ② action === 'ask' 但问题无效 → 不返回，继续按 plan 解析（兼容旧格式与格式漂移）；
 * ③ experts 非空 → plan；④ 均无命中 → null（调用方抛「未能解析出生成结果，请重试」）。
 */
export function parseExpertTeamReply(content: string): ExpertTeamReply | null {
  const obj = extractJsonObject(content)
  if (obj && obj.action === 'ask') {
    const rawQuestions = Array.isArray(obj.questions) ? obj.questions : []
    const questions = rawQuestions
      .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
      .map((q) => clip(q.trim(), EXPERT_QUESTION_MAX))
      .slice(0, 3)
    if (questions.length > 0) {
      const reason = typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim() : undefined
      return reason !== undefined ? { kind: 'clarify', questions, reason } : { kind: 'clarify', questions }
    }
  }
  const { reason, experts } = parseExpertPlan(content)
  if (experts.length === 0) return null
  return reason !== undefined ? { kind: 'plan', experts, reason } : { kind: 'plan', experts }
}

// ─── 入口（IPC moa:generateExperts）───

/** 按任务需求生成专家团（clarify = 追问 / plan = 专家团）；一切失败场景均 throw Error（IPC 层包装为 {success:false, error}） */
export async function generateExpertTeam(req: GenerateExpertsRequest): Promise<ExpertGenResult> {
  const requirement = typeof req?.requirement === 'string' ? req.requirement.trim() : ''
  if (!requirement) throw new Error('需求描述为空')

  // 追问历史（IPC 边界一次清洗：丢弃非法轮、答案对齐问题、轮数截前 MAX_CLARIFY_ROUNDS）
  const history = sanitizeHistory(req?.history)

  const model = resolveGeneratorModel()
  if (!model) throw new Error('未配置可用的生成模型：请先配置厂商 API Key 或 MoA 主模型')

  const seats = Array.isArray(req?.seats) ? req.seats.filter((s): s is string => typeof s === 'string') : []
  // 安全阀：用户点「直接生成」或追问轮数达上限 → 本轮不得再追问
  const force = req?.forceGenerate === true || history.length >= MAX_CLARIFY_ROUNDS
  const prompt = buildExpertPlanPrompt({ requirement, seats, scale: req?.scale, history, force })

  const genOnce = (): Promise<Awaited<ReturnType<typeof streamChat>>> =>
    streamChat({
      providerBaseUrl: model.baseUrl,
      apiKey: model.apiKey,
      modelId: model.modelId,
      messages: [{ role: 'user', content: prompt }],
      timeoutMs: DEFAULT_SUB_MODEL_TIMEOUT
    })
  // 上游瞬时故障（5xx/网络类）自动重试一次：复现过「首次 500、手动重试即成功」的场景
  let result = await genOnce()
  if (result.error !== undefined && isRetriableLLMError(result.error)) {
    console.warn(`[ExpertGen] 生成失败（${result.error}），1.5s 后自动重试一次`)
    await sleep(1500)
    result = await genOnce()
  }
  if (result.error !== undefined) throw new Error(`生成失败：${result.error}`)

  const reply = parseExpertTeamReply(result.content)
  if (reply === null) throw new Error('未能解析出生成结果，请重试')

  if (reply.kind === 'clarify') {
    // force 兜底：本轮已要求直接生成而模型仍追问 → 视为生成失败
    if (force) throw new Error('生成失败：模型未按要求直接生成专家团，请重试')
    // 诊断日志：记录追问问题（便于定位模型为何需要补充信息）
    console.log(`[ExpertGen] 追问 ${reply.questions.length} 个问题：${reply.questions.join(' / ')}`)
    const clarify: ExpertGenResult = { kind: 'clarify', questions: reply.questions, modelId: model.modelId, providerId: model.providerId }
    if (reply.reason !== undefined) clarify.reason = reply.reason
    return clarify
  }

  // 诊断日志：记录实际生成结果（专家名 + 角色描述字数）——描述过短/缺失时便于定位是模型输出问题还是链路问题
  console.log(
    `[ExpertGen] ${model.providerId} / ${model.modelId} → ${reply.experts.length} 位专家：${reply.experts.map((e) => `${e.name}(${e.prompt.length}字)`).join('、')}`
  )

  const plan: ExpertGenResult = { kind: 'plan', experts: reply.experts, modelId: model.modelId, providerId: model.providerId }
  if (reply.reason !== undefined) plan.reason = reply.reason
  return plan
}
