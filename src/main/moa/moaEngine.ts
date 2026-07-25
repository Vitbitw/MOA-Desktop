import { getAllProviders } from '../providers/providerManager'
import { callSubModel, callSubModelsParallel, countSuccessfulSubModels } from './subModelCaller'
import { buildAggregationMessages, getAggregationPrompt } from './aggregationPrompt'
import type { SubModelConfig, AggregatorConfig, SubModelOutput } from '../../shared/types'

export interface MoaRequest {
  messages: Array<{ role: string; content: string }>
  subModels: SubModelConfig[]
  aggregator?: AggregatorConfig
  mode: 'aggregate' | 'compare' | 'direct'
  systemPrompt?: string
  aggregationPromptVariant?: 'standard-zh' | 'concise-en' | 'custom'
  customAggregationPrompt?: string
  subTimeoutMs?: number
  aggTimeoutMs?: number
}

export interface MoaResponse {
  type: 'aggregate' | 'compare' | 'direct'
  content: string
  subOutputs: SubModelOutput[]
  aggregatorContent?: string
  success: boolean
  partialFailure?: boolean
  error?: string
}

/** Resolve sub-model configs to actual provider URLs and keys. */
function resolveSubModels(subModels: SubModelConfig[]): Array<{
  providerBaseUrl: string
  apiKey: string
  modelId: string
}> {
  const providers = getAllProviders()
  return subModels.map((sm) => {
    const p = providers.find((prov) => prov.id === sm.providerId)
    return {
      providerBaseUrl: p?.baseUrl || '',
      apiKey: p?.apiKey || '',
      modelId: sm.modelId
    }
  }).filter((sm) => sm.providerBaseUrl && sm.apiKey)
}

/** Resolve aggregator model config to { baseUrl, apiKey, modelId } or null. */
function resolveAggregator(aggregator: AggregatorConfig): {
  providerBaseUrl: string
  apiKey: string
  modelId: string
} | null {
  const providers = getAllProviders()
  const p = providers.find((prov) => prov.id === aggregator.primaryProviderId)
  if (!p?.apiKey) return null
  return {
    providerBaseUrl: p.baseUrl,
    apiKey: p.apiKey,
    modelId: aggregator.primaryModelId
  }
}

/** Call the aggregator model with built aggregation messages. Return content string. */
async function callAggregator(
  aggInfo: { providerBaseUrl: string; apiKey: string; modelId: string },
  messages: Array<{ role: string; content: string }>,
  timeoutMs: number
): Promise<{ content: string; success: boolean; error?: string }> {
  try {
    const resp = await fetch(`${aggInfo.providerBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aggInfo.apiKey}`
      },
      body: JSON.stringify({
        model: aggInfo.modelId,
        messages,
        stream: false
      }),
      signal: AbortSignal.timeout(timeoutMs)
    })

    if (!resp.ok) {
      const errText = await resp.text()
      return { content: '', success: false, error: `HTTP ${resp.status}: ${errText.slice(0, 300)}` }
    }

    const data = await resp.json()
    return { content: data.choices?.[0]?.message?.content || '', success: true }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: '', success: false, error: msg }
  }
}

/**
 * MoA engine entry point.
 * Determines mode, calls sub-models in parallel, then either returns raw comparison or aggregates.
 */
export async function executeMoA(req: MoaRequest): Promise<MoaResponse> {
  // ── Resolve sub-models ──
  const resolvedSubs = resolveSubModels(req.subModels)
  if (resolvedSubs.length === 0) {
    return {
      type: req.mode,
      content: '',
      subOutputs: [],
      success: false,
      error: '没有可用的子模型：请检查厂商配置和 API Key'
    }
  }

  // ── Call sub-models in parallel ──
  const subOutputs = await callSubModelsParallel({
    subModels: resolvedSubs,
    messages: req.messages,
    systemPrompt: req.systemPrompt,
    subTimeoutMs: req.subTimeoutMs ?? 60_000
  })

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
    // No aggregator configured — fallback to compare
    return {
      type: 'aggregate',
      content: '',
      subOutputs,
      success: false,
      partialFailure: successfulCount < subOutputs.length,
      error: '未配置聚合模型。请在设置中配置或切换为 D 模式。'
    }
  }

  // Build aggregation messages
  const aggPrompt = getAggregationPrompt(
    req.aggregationPromptVariant || 'standard-zh',
    req.customAggregationPrompt
  )
  const aggMessages = buildAggregationMessages(
    req.messages,
    successfulOutputs.map((o) => ({ modelId: o.modelId, content: o.content })),
    aggPrompt
  )

  // Call aggregator
  const aggResult = await callAggregator(aggInfo, aggMessages, req.aggTimeoutMs ?? 120_000)

  if (!aggResult.success) {
    // Try fallback aggregator if configured
    if (req.aggregator?.fallbackProviderId && req.aggregator?.fallbackModelId) {
      const fallbackAgg = resolveAggregator({
        primaryModelId: req.aggregator.fallbackModelId,
        primaryProviderId: req.aggregator.fallbackProviderId
      })
      if (fallbackAgg) {
        const fallbackResult = await callAggregator(fallbackAgg, aggMessages, req.aggTimeoutMs ?? 120_000)
        if (fallbackResult.success) {
          return {
            type: 'aggregate',
            content: fallbackResult.content,
            subOutputs,
            aggregatorContent: fallbackResult.content,
            success: true,
            partialFailure: successfulCount < subOutputs.length
          }
        }
      }
    }

    // Aggregation failed — degrade to compare
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

  return {
    type: 'aggregate',
    content: aggResult.content,
    subOutputs,
    aggregatorContent: aggResult.content,
    success: true,
    partialFailure: successfulCount < subOutputs.length
  }
}

// ── Event-emitting variant ──────────────────────────────────────────

export interface MoaRequestWithEvents extends MoaRequest {
  emitSubOutput: (output: SubModelOutput, index: number) => void
  emitAggregationStart: () => void
  emitAggregationChunk: (text: string, done: boolean) => void
}

/**
 * MoA engine entry point (event-emitting variant).
 * Same logic as executeMoA, but calls sub-models individually so each
 * result can be emitted via IPC callbacks as it completes.
 * Also emits aggregation start/chunk events.
 */
export async function executeMoAWithEvents(req: MoaRequestWithEvents): Promise<MoaResponse> {
  // ── Resolve sub-models ──
  const resolvedSubs = resolveSubModels(req.subModels)
  if (resolvedSubs.length === 0) {
    return {
      type: req.mode,
      content: '',
      subOutputs: [],
      success: false,
      error: '没有可用的子模型：请检查厂商配置和 API Key'
    }
  }

  // ── Call sub-models individually, emitting each as it completes ──
  const subOutputs: SubModelOutput[] = []
  const timeoutMs = req.subTimeoutMs ?? 60_000

  const promises = resolvedSubs.map((sm, index) =>
    callSubModel({
      providerBaseUrl: sm.providerBaseUrl,
      apiKey: sm.apiKey,
      modelId: sm.modelId,
      messages: req.messages,
      systemPrompt: req.systemPrompt,
      timeoutMs
    }).then((result) => {
      subOutputs[index] = result
      req.emitSubOutput(result, index)
      return result
    }).catch((err: unknown) => {
      const errMsg = err instanceof Error ? err.message : String(err)
      const errorOutput: SubModelOutput = {
        modelId: sm.modelId,
        providerId: sm.providerBaseUrl,
        content: '',
        status: 'error',
        error: errMsg,
        durationMs: 0
      }
      subOutputs[index] = errorOutput
      req.emitSubOutput(errorOutput, index)
      return errorOutput
    })
  )

  await Promise.allSettled(promises)

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

  req.emitAggregationStart()

  // Build aggregation messages
  const aggPrompt = getAggregationPrompt(
    req.aggregationPromptVariant || 'standard-zh',
    req.customAggregationPrompt
  )
  const aggMessages = buildAggregationMessages(
    req.messages,
    successfulOutputs.map((o) => ({ modelId: o.modelId, content: o.content })),
    aggPrompt
  )

  // Call aggregator
  const aggResult = await callAggregator(aggInfo, aggMessages, req.aggTimeoutMs ?? 120_000)

  if (!aggResult.success) {
    // Try fallback aggregator if configured
    if (req.aggregator?.fallbackProviderId && req.aggregator?.fallbackModelId) {
      const fallbackAgg = resolveAggregator({
        primaryModelId: req.aggregator.fallbackModelId,
        primaryProviderId: req.aggregator.fallbackProviderId
      })
      if (fallbackAgg) {
        const fallbackResult = await callAggregator(fallbackAgg, aggMessages, req.aggTimeoutMs ?? 120_000)
        if (fallbackResult.success) {
          req.emitAggregationChunk(fallbackResult.content, true)
          return {
            type: 'aggregate',
            content: fallbackResult.content,
            subOutputs,
            aggregatorContent: fallbackResult.content,
            success: true,
            partialFailure: successfulCount < subOutputs.length
          }
        }
      }
    }

    // Aggregation failed — degrade to compare
    req.emitAggregationChunk('', true)
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

  req.emitAggregationChunk(aggResult.content, true)

  return {
    type: 'aggregate',
    content: aggResult.content,
    subOutputs,
    aggregatorContent: aggResult.content,
    success: true,
    partialFailure: successfulCount < subOutputs.length
  }
}
