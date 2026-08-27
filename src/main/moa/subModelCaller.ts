import type { SubModelOutput } from '../../shared/types'
import { fetchProxy } from '../local/fetchProxy'

export interface SubModelCallOptions {
  providerBaseUrl: string
  /** 厂商 ID（写入 SubModelOutput.providerId；缺省时回退 baseUrl 兼容旧调用） */
  providerId?: string
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
  const { providerBaseUrl, providerId, apiKey, modelId, messages, systemPrompt, timeoutMs } = opts

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
        providerId: providerId || providerBaseUrl,
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
      providerId: providerId || providerBaseUrl,
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
      providerId: providerId || providerBaseUrl,
      content: '',
      status: 'error',
      error: msg,
      durationMs
    }
  }
}

/** Count how many sub-models succeeded. */
export function countSuccessfulSubModels(results: SubModelOutput[]): number {
  return results.filter((r) => r.status === 'success').length
}
