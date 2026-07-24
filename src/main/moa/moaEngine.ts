import { getAllProviders } from '../providers/providerManager'
import { callSubModelsParallel, countSuccessfulSubModels } from './subModelCaller'
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
      error: 'No usable sub-models: check provider configuration and API keys'
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
      error: 'All sub-models failed. Check provider health and API keys.'
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
      error: 'No aggregator model configured. Configure one in settings or switch to D mode.'
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
      error: `Aggregator failed: ${aggResult.error}. Sub-models available in compare view.`
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
