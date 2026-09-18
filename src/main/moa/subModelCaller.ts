import type { SubModelOutput } from '../../shared/types'
import { fetchProxy } from '../local/fetchProxy'
import { combineSignals, streamChat } from './streamChat'

export interface SubModelCallOptions {
  providerBaseUrl: string
  /** 厂商 ID（写入 SubModelOutput.providerId；缺省时回退 baseUrl 兼容旧调用） */
  providerId?: string
  apiKey: string
  modelId: string
  messages: Array<{ role: string; content: string }>
  systemPrompt?: string
  timeoutMs: number
  /** 外部中止信号（网关客户端断开等）；与内部 AbortSignal.timeout 组合，触发即中断请求 */
  signal?: AbortSignal
}

/**
 * Call a single sub-model (OpenAI-compatible /v1/chat/completions).
 * For Anthropic-style endpoints, the caller should normalize to OpenAI format upstream.
 */
export async function callSubModel(opts: SubModelCallOptions): Promise<SubModelOutput> {
  const startTime = Date.now()
  const { providerBaseUrl, providerId, apiKey, modelId, messages, systemPrompt, timeoutMs, signal } = opts

  // Build payload
  const body: Record<string, unknown> = {
    model: modelId,
    messages: systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages,
    stream: false
  }

  // 外部 signal 与自身超时组合（同 streamChat 式）：客户端断开立即中断，不再跑满 timeoutMs
  const combined = combineSignals(signal, AbortSignal.timeout(timeoutMs))

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    // P2-7：统一走 fetchProxy（本地引擎回环直连、云端 provider 可走网络代理）
    const resp = await fetchProxy(`${providerBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: combined.signal
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
    // 外部中止（客户端断开）优先标注「已中止」；其余（含自身超时）保留原始错误信息
    const msg = signal?.aborted ? '已中止' : err instanceof Error ? err.message : String(err)
    return {
      modelId,
      providerId: providerId || providerBaseUrl,
      content: '',
      status: 'error',
      error: msg,
      durationMs
    }
  } finally {
    combined.dispose()
  }
}

/** Count how many sub-models succeeded. */
export function countSuccessfulSubModels(results: SubModelOutput[]): number {
  return results.filter((r) => r.status === 'success').length
}

/** callSubModelStream 的选项：非流式选项 + 外部中止信号 + 增量回调 */
export type SubModelStreamOptions = SubModelCallOptions & {
  /** 增量回调：每收到一段文本增量回调累计全文 */
  onDelta?: (accumulatedText: string) => void
}

/**
 * 流式调用单个子模型（经 streamChat 通用流式层实现，永不 throw）。
 * 回退链：stream_options 400 → 去掉重发；stream:true 400 → 复用 callSubModel 非流式（外部 signal
 * 透传，回退中中止同样立即生效）；
 * HTTP 200 后流中断/超时/中止 → 不重试，保留已收文本，status:'error'。
 * usage 缺失时 tokenUsage 省略（不写假 0）。
 */
export async function callSubModelStream(opts: SubModelStreamOptions): Promise<SubModelOutput> {
  const startTime = Date.now()
  const { providerBaseUrl, providerId, apiKey, modelId, messages, systemPrompt, timeoutMs, signal, onDelta } = opts

  const result = await streamChat({
    providerBaseUrl,
    apiKey,
    modelId,
    messages: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages,
    timeoutMs,
    signal,
    onDelta,
    // 回退链级 3：stream:true 被 400 拒绝（中转不支持）→ 复用现有非流式实现
    nonStreamFallback: async () => {
      const r = await callSubModel(opts)
      if (r.status !== 'success') return { content: '', error: r.error ?? '非流式回退失败' }
      // callSubModel 对缺失 usage 写 0 兜底；此处只在真实用量时透传，避免假 0
      const usage = r.tokenUsage && (r.tokenUsage.prompt > 0 || r.tokenUsage.completion > 0) ? r.tokenUsage : undefined
      return usage ? { content: r.content, usage } : { content: r.content }
    }
  })

  const output: SubModelOutput = {
    modelId,
    providerId: providerId || providerBaseUrl,
    content: result.content,
    status: result.error !== undefined ? 'error' : 'success',
    durationMs: Date.now() - startTime
  }
  if (result.error !== undefined) output.error = result.error
  if (result.usage !== undefined) output.tokenUsage = result.usage
  return output
}
