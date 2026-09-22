import { getAllProviders } from '../providers/providerManager'
import { callSubModelStream, countSuccessfulSubModels } from './subModelCaller'
import { buildAggregationMessages, buildCommitteeMessages, getAggregationPrompt, CHAIR_PROMPT_ZH } from './aggregationPrompt'
import { DEFAULT_SUB_MODEL_TIMEOUT, DEFAULT_AGGREGATOR_TIMEOUT } from '../../shared/defaults'
import { hasProviderAccess, isLocalBaseUrl } from '../../shared/providerAccess'
import { streamChat } from './streamChat'
import type { ChatMessage, ToolCallResult } from './streamChat'
import type { SubModelConfig, AggregatorConfig, SubModelOutput, MoaArchitecture, SubModelRole } from '../../shared/types'

export interface MoaRequest {
  messages: ChatMessage[]
  subModels: SubModelConfig[]
  aggregator?: AggregatorConfig
  mode: 'aggregate' | 'compare' | 'direct'
  systemPrompt?: string
  aggregationPromptVariant?: 'standard-zh' | 'concise-en' | 'custom'
  customAggregationPrompt?: string
  subTimeoutMs?: number
  aggTimeoutMs?: number
  /** 协作架构：缺省 'election'（子模型并行出完整答案，聚合模型拼接提炼） */
  architecture?: MoaArchitecture
  /** 外部中止信号（网关客户端断开等）：中止后不再发起聚合、进行中调用随之中断（app 内路径不传） */
  signal?: AbortSignal
  /** 附加请求字段（tools / tool_choice / temperature 等）：逐路透传给子模型与聚合模型（Anthropic 端点用；缺省不传） */
  extraBody?: Record<string, unknown>
}

export interface MoaResponse {
  type: 'aggregate' | 'compare' | 'direct'
  content: string
  subOutputs: SubModelOutput[]
  aggregatorContent?: string
  /** 实际使用的聚合模型 usage（主聚合或 fallback 聚合） */
  aggregatorUsage?: { prompt: number; completion: number }
  /** 聚合模型末帧 finish_reason（'length' = 上游截断；Anthropic 端点映射 stop_reason=max_tokens 用） */
  aggregatorFinishReason?: string
  /** 实际使用的聚合模型身份（fallback 生效时不是 primary） */
  aggregatorModelId?: string
  aggregatorProviderId?: string
  /** 聚合模型输出的 tool_calls（聚合成功且有工具调用时透出；Anthropic 端点转 tool_use 用） */
  aggregatorToolCalls?: ToolCallResult[]
  success: boolean
  partialFailure?: boolean
  error?: string
}

/** 子模型事件载荷：status 'running' = 流式过程中的累计文本增量（多次发射，仅事件语义、不落库）；success/error = 终态（一次） */
export interface SubOutputEventPayload extends Omit<SubModelOutput, 'status'> {
  status: 'running' | 'success' | 'error'
}

/** 可选的事件回调：事件版入口会注入，纯调用版（executeMoA）不注入 */
interface MoaEvents {
  emitSubOutput: (output: SubOutputEventPayload, index: number) => void
  emitAggregationStart: () => void
  emitAggregationChunk: (text: string, done: boolean) => void
}

/** Resolve sub-model configs to actual provider URLs, keys, and effective per-sub system prompt. */
export interface ResolvedSubModel {
  providerId: string
  providerBaseUrl: string
  apiKey: string
  modelId: string
  enabled: boolean
  role: SubModelRole
  systemPrompt: string | undefined
  expertName?: string
}

export function resolveSubModels(subModels: SubModelConfig[], defaultSystemPrompt?: string): ResolvedSubModel[] {
  const providers = getAllProviders()
  return subModels.map((sm) => {
    const p = providers.find((prov) => prov.id === sm.providerId)
    // 生效的子模型 systemPrompt：自定义介绍 > 全局默认（预设角色模板已退役，v9——旧数据迁移在 moaConfig 层完成）
    const effectiveSystemPrompt = sm.systemPrompt && sm.systemPrompt.trim().length > 0 ? sm.systemPrompt : undefined
    return {
      providerId: sm.providerId,
      providerBaseUrl: p?.baseUrl || '',
      apiKey: p?.apiKey || '',
      modelId: sm.modelId,
      enabled: p?.enabled !== false,
      role: (sm.role || '') as SubModelRole,
      systemPrompt: effectiveSystemPrompt || defaultSystemPrompt,
      expertName: sm.expertName
    }
  }).filter((sm) => sm.providerBaseUrl && sm.enabled && (sm.apiKey || isLocalBaseUrl(sm.providerBaseUrl)))
}

/** Resolve aggregator model config to { baseUrl, apiKey, modelId } or null. */
function resolveAggregator(aggregator: AggregatorConfig): {
  providerBaseUrl: string
  apiKey: string
  modelId: string
} | null {
  const providers = getAllProviders()
  const p = providers.find((prov) => prov.id === aggregator.primaryProviderId)
  if (!p) return null
  if (!p.enabled) return null
  if (!hasProviderAccess(p)) return null
  return {
    providerBaseUrl: p.baseUrl,
    apiKey: p.apiKey || '',
    modelId: aggregator.primaryModelId
  }
}

/**
 * Call the aggregator model with built aggregation messages. Return content string.
 * 流式实现（T2）：经 streamChat 收流，onDelta 逐段回调累计文本；signal 透传外部中止。
 * T7：extraBody 透传（tools/tool_choice 等）；返回值带 toolCalls（聚合模型工具调用，转 tool_use 用）
 * 与 finishReason（上游截断 'length' 透出，Anthropic 端点映射 max_tokens 用）。
 */
async function callAggregator(
  aggInfo: { providerBaseUrl: string; apiKey: string; modelId: string },
  messages: ChatMessage[],
  timeoutMs: number,
  onDelta?: (accumulatedText: string) => void,
  signal?: AbortSignal,
  extraBody?: Record<string, unknown>
): Promise<{ content: string; success: boolean; error?: string; usage?: { prompt: number; completion: number }; toolCalls?: ToolCallResult[]; finishReason?: string }> {
  const result = await streamChat({
    providerBaseUrl: aggInfo.providerBaseUrl,
    apiKey: aggInfo.apiKey,
    modelId: aggInfo.modelId,
    messages,
    timeoutMs,
    signal,
    onDelta,
    extraBody
  })

  const output: { content: string; success: boolean; error?: string; usage?: { prompt: number; completion: number }; toolCalls?: ToolCallResult[]; finishReason?: string } = {
    content: result.content,
    success: result.error === undefined
  }
  if (result.error !== undefined) output.error = result.error
  if (result.usage !== undefined) output.usage = result.usage
  if (result.toolCalls !== undefined) output.toolCalls = result.toolCalls
  if (result.finishReason !== undefined) output.finishReason = result.finishReason
  return output
}

/**
 * MoA 引擎统一实现。executeMoA（纯调用）与 executeMoAWithEvents（事件流）共享此逻辑，
 * 仅通过可选的 events 回调差异（子模型逐个完成、聚合开始/分块）。
 */
async function executeMoAInternal(req: MoaRequest, events?: MoaEvents): Promise<MoaResponse> {
  // ── Resolve sub-models ──
  const resolvedSubs = resolveSubModels(req.subModels, req.systemPrompt)
  if (resolvedSubs.length === 0) {
    return {
      type: req.mode,
      content: '',
      subOutputs: [],
      success: false,
      error: '没有可用的子模型：请检查厂商配置和 API Key'
    }
  }

  // ── Call sub-models in parallel, emitting each result as it completes ──
  const subOutputs: SubModelOutput[] = []
  const timeoutMs = req.subTimeoutMs ?? DEFAULT_SUB_MODEL_TIMEOUT

  // direct 模式只用首个可用子模型（subOutputs[0]）：只调用它，其余子模型不发起请求，
  // 避免白付 N-1 份调用费用。index 语义不变——direct 时仅 index 0 有事件与输出
  const subsToCall = req.mode === 'direct' ? resolvedSubs.slice(0, 1) : resolvedSubs

  const promises = subsToCall.map((sm, index) =>
    callSubModelStream({
      providerBaseUrl: sm.providerBaseUrl,
      providerId: sm.providerId,
      apiKey: sm.apiKey,
      modelId: sm.modelId,
      messages: req.messages,
      systemPrompt: sm.systemPrompt,
      timeoutMs,
      signal: req.signal,
      // 附加字段（tools 等）透传：子模型可出 tool_calls 作为专家意见（不进最终响应）
      extraBody: req.extraBody,
      // 流式增量 → running 累计事件（引擎不做节流：节流由 host 层 index.ts / 网关广播负责）
      onDelta: (acc) => {
        try {
          events?.emitSubOutput(
            { modelId: sm.modelId, providerId: sm.providerId || sm.providerBaseUrl, content: acc, status: 'running', role: sm.role, expertName: sm.expertName },
            index
          )
        } catch { /* 事件失败不影响业务结果 */ }
      }
    }).then((result) => {
      subOutputs[index] = { ...result, role: sm.role, expertName: sm.expertName }
      // 事件发射隔离：emit 抛错不得落入下方 .catch 被当作子模型失败处理（否则会用
      // errorOutput 覆盖已成功的真实输出，聚合模式误报「所有子模型均失败」且用量漏记）
      try { events?.emitSubOutput(subOutputs[index], index) } catch { /* 事件失败不影响业务结果 */ }
      return subOutputs[index]
    }).catch((err: unknown) => {
      const errMsg = err instanceof Error ? err.message : String(err)
      const errorOutput: SubModelOutput = {
        modelId: sm.modelId,
        providerId: sm.providerId || sm.providerBaseUrl,
        content: '',
        status: 'error',
        error: errMsg,
        durationMs: 0,
        role: sm.role,
        expertName: sm.expertName
      }
      subOutputs[index] = errorOutput
      try { events?.emitSubOutput(errorOutput, index) } catch { /* 事件失败不影响业务结果 */ }
      return errorOutput
    })
  )

  await Promise.allSettled(promises)

  // ── Abort short-circuit：子模型阶段结束时 signal 已中止（客户端断开）→ 不再发起聚合，直接返回失败。
  // 与「全部子模型失败」路径区分：error 文案为「已中止」；进行中的调用已随 signal 中断，部分 subOutputs 保留已收文本。
  if (req.signal?.aborted) {
    return {
      type: req.mode,
      content: '',
      subOutputs,
      success: false,
      error: '已中止'
    }
  }

  const successfulCount = countSuccessfulSubModels(subOutputs)

  // ── Direct mode ──
  if (req.mode === 'direct') {
    const first = subOutputs[0]
    return {
      type: 'direct',
      content: first.status === 'success' ? first.content : '',
      subOutputs,
      success: first.status === 'success',
      error: first.status !== 'success' ? first.error : undefined
    }
  }

  // ── Compare (D) mode ──
  if (req.mode === 'compare') {
    return {
      type: 'compare',
      content: '',
      subOutputs,
      success: successfulCount > 0,
      partialFailure: successfulCount < subOutputs.length
    }
  }

  // ── Aggregate (A) mode ──
  if (successfulCount === 0) {
    return {
      type: 'aggregate',
      content: '',
      subOutputs,
      success: false,
      error: '所有子模型均失败。请检查厂商连接和 API Key。'
    }
  }

  const successfulOutputs = subOutputs.filter((o) => o.status === 'success')

  // Resolve aggregator model
  const aggInfo = req.aggregator ? resolveAggregator(req.aggregator) : null
  if (!aggInfo) {
    return {
      type: 'aggregate',
      content: '',
      subOutputs,
      success: false,
      partialFailure: successfulCount < subOutputs.length,
      error: '未配置聚合模型。请在设置中配置或切换为 D 模式。'
    }
  }

  try { events?.emitAggregationStart() } catch { /* 事件失败不得使 executeMoA reject */ }

  // 按架构分叉：主席团模式用主持人提示词 + 完整历史 + 专家意见；选举模式沿用融合器提示词
  const isCommittee = req.architecture === 'committee'
  const aggPrompt = isCommittee
    ? (req.customAggregationPrompt?.trim() || CHAIR_PROMPT_ZH)
    : getAggregationPrompt(
        req.aggregationPromptVariant || 'standard-zh',
        req.customAggregationPrompt
      )
  const aggMessages = isCommittee
    ? buildCommitteeMessages(
        req.messages,
        successfulOutputs.map((o) => ({ modelId: o.modelId, content: o.content, expertName: o.expertName })),
        aggPrompt
      )
    : buildAggregationMessages(
        req.messages,
        successfulOutputs.map((o) => ({ modelId: o.modelId, content: o.content })),
        aggPrompt
      )

  // Call aggregator：onDelta → 累计文本分块事件（done=false），signal 透传（中止随流中断）
  const onAggDelta = (acc: string): void => {
    try { events?.emitAggregationChunk(acc, false) } catch { /* 忽略事件失败 */ }
  }
  const aggResult = await callAggregator(
    aggInfo,
    aggMessages,
    req.aggTimeoutMs ?? DEFAULT_AGGREGATOR_TIMEOUT,
    onAggDelta,
    req.signal,
    req.extraBody
  )

  if (!aggResult.success) {
    // Try fallback aggregator if configured
    // abort 后不得再发起聚合（含 fallback）：跳过 fallback 直接进入降级返回
    if (req.aggregator?.fallbackProviderId && req.aggregator?.fallbackModelId && !req.signal?.aborted) {
      const fallbackAgg = resolveAggregator({
        primaryModelId: req.aggregator.fallbackModelId,
        primaryProviderId: req.aggregator.fallbackProviderId
      })
      if (fallbackAgg) {
        // fallback 聚合重置：primary 失败后先清空已展示的部分文本（节流窗口内被合并覆盖则视觉等价）
        try { events?.emitAggregationChunk('', false) } catch { /* 忽略事件失败 */ }
        const fallbackResult = await callAggregator(
          fallbackAgg,
          aggMessages,
          req.aggTimeoutMs ?? DEFAULT_AGGREGATOR_TIMEOUT,
          onAggDelta,
          req.signal,
          req.extraBody
        )
        if (fallbackResult.success) {
          try { events?.emitAggregationChunk(fallbackResult.content, true) } catch { /* 忽略事件失败 */ }
          const fallbackResponse: MoaResponse = {
            type: 'aggregate',
            content: fallbackResult.content,
            subOutputs,
            aggregatorContent: fallbackResult.content,
            aggregatorUsage: fallbackResult.usage,
            aggregatorModelId: req.aggregator.fallbackModelId,
            aggregatorProviderId: req.aggregator.fallbackProviderId,
            success: true,
            partialFailure: successfulCount < subOutputs.length
          }
          // 聚合模型 tool_calls 透出（Anthropic 端点转 tool_use；无则不设字段，向后兼容）
          if (fallbackResult.toolCalls) fallbackResponse.aggregatorToolCalls = fallbackResult.toolCalls
          if (fallbackResult.finishReason) fallbackResponse.aggregatorFinishReason = fallbackResult.finishReason
          return fallbackResponse
        }
      }
    }

    // Aggregation failed — degrade to compare
    try { events?.emitAggregationChunk('', true) } catch { /* 忽略事件失败 */ }
    return {
      type: 'aggregate',
      content: '',
      subOutputs,
      success: false,
      partialFailure: successfulCount < subOutputs.length,
      aggregatorContent: '',
      error: `聚合失败：${aggResult.error}。子模型输出可在对比视图中查看。`
    }
  }

  try { events?.emitAggregationChunk(aggResult.content, true) } catch { /* 忽略事件失败 */ }

  const aggregateResponse: MoaResponse = {
    type: 'aggregate',
    content: aggResult.content,
    subOutputs,
    aggregatorContent: aggResult.content,
    aggregatorUsage: aggResult.usage,
    aggregatorModelId: req.aggregator?.primaryModelId ?? '',
    aggregatorProviderId: req.aggregator?.primaryProviderId ?? '',
    success: true,
    partialFailure: successfulCount < subOutputs.length
  }
  // 聚合模型 tool_calls 透出（Anthropic 端点转 tool_use；无则不设字段，向后兼容）
  if (aggResult.toolCalls) aggregateResponse.aggregatorToolCalls = aggResult.toolCalls
  // 聚合末帧 finish_reason 透出（'length' 截断 → Anthropic stop_reason max_tokens；无则不设字段）
  if (aggResult.finishReason) aggregateResponse.aggregatorFinishReason = aggResult.finishReason
  return aggregateResponse
}

/** MoA engine entry point (pure call, no events). */
export function executeMoA(req: MoaRequest): Promise<MoaResponse> {
  return executeMoAInternal(req)
}

export interface MoaRequestWithEvents extends MoaRequest {
  emitSubOutput: (output: SubOutputEventPayload, index: number) => void
  emitAggregationStart: () => void
  emitAggregationChunk: (text: string, done: boolean) => void
}

/** MoA engine entry point (event-emitting variant). */
export function executeMoAWithEvents(req: MoaRequestWithEvents): Promise<MoaResponse> {
  return executeMoAInternal(req, {
    emitSubOutput: req.emitSubOutput,
    emitAggregationStart: req.emitAggregationStart,
    emitAggregationChunk: req.emitAggregationChunk
  })
}