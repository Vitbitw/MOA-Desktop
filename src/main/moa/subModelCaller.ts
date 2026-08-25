import type { SubModelOutput } from '../../shared/types'
import { fetchProxy } from '../local/fetchProxy'

export interface SubModelCallOptions {
  providerBaseUrl: string
  apiKey: string
  modelId: string
  messages: Array<{ role: string; content: string }>
  systemPrompt?: string
  timeoutMs: number
}

/**
 * Call a single sub-model (OpenAI-compatible /v1/chat/completions).
 * For Anthropic-style endpoints, the caller should normalize to OpenAI format upstream.
 */
export async function callSubModel(opts: SubModelCallOptions): Promise<SubModelOutput> {
  const startTime = Date.now()
  const { providerBaseUrl, apiKey, modelId, messages, systemPrompt, timeoutMs } = opts

  // Build payload
  const body: Record<string, unknown> = {
    model: modelId,
    messages: systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages,
    stream: false
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    // P2-7：统一走 fetchProxy（本地引擎回环直连、云端 provider 可走网络代理）
    const resp = await fetchProxy(`${providerBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    })

    const durationMs = Date.now() - startTime

    if (!resp.ok) {
      const errText = await resp.text()
      return {
        modelId,
        providerId: providerBaseUrl,
        content: '',
        status: 'error',
        error: `HTTP ${resp.status}: ${errText.slice(0, 300)}`,
        durationMs
      }
    }

    const data = await resp.json()
    const content = data.choices?.[0]?.message?.content || ''
    const usage = data.usage || {}

    return {
      modelId,
      providerId: providerBaseUrl,
      content,
      status: 'success',
      durationMs,
      tokenUsage: {
        prompt: usage.prompt_tokens || 0,
        completion: usage.completion_tokens || 0
      }
    }
  } catch (err: unknown) {
    const durationMs = Date.now() - startTime
    const msg = err instanceof Error ? err.message : String(err)
    return {
      modelId,
      providerId: providerBaseUrl,
      content: '',
      status: 'error',
      error: msg,
      durationMs
    }
  }
}

export interface ParallelCallOptions {
  subModels: Array<{
    providerBaseUrl: string
    apiKey: string
    modelId: string
  }>
  messages: Array<{ role: string; content: string }>
  systemPrompt?: string
  subTimeoutMs?: number
}

/**
 * Call all sub-models in parallel via Promise.allSettled.
 * Returns results with timeout and error info per model.
 */
export async function callSubModelsParallel(opts: ParallelCallOptions): Promise<SubModelOutput[]> {
  const timeoutMs = opts.subTimeoutMs ?? 60_000

  const promises = opts.subModels.map((sm) =>
    callSubModel({
      providerBaseUrl: sm.providerBaseUrl,
      apiKey: sm.apiKey,
      modelId: sm.modelId,
      messages: opts.messages,
      systemPrompt: opts.systemPrompt,
      timeoutMs
    })
  )

  const settled = await Promise.allSettled(promises)

  return settled.map((result, i) => {
    if (result.status === 'fulfilled') return result.value

    const sm = opts.subModels[i]
    return {
      modelId: sm.modelId,
      providerId: sm.providerBaseUrl,
      content: '',
      status: 'error' as const,
      error: 'Promise.allSettled 中出现意外拒绝',
      durationMs: 0
    }
  })
}

/** Count how many sub-models succeeded. */
export function countSuccessfulSubModels(results: SubModelOutput[]): number {
  return results.filter((r) => r.status === 'success').length
}
