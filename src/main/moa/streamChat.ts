// 通用流式调用层：单次 OpenAI 兼容 /chat/completions 请求的公共实现
// （SSE 收流 + 回退链 + 三档超时 + abort 信号组合 + usage 提取），callSubModelStream 与流式聚合共用。
// 统一走 fetchProxy（项目 P2-7 约定）；永不 throw —— 一切失败/中止/超时都映射为 error + 已收文本。
// 设计说明见 .hermes/plans/2026-09-18-moa-live-streaming.md §4.3

import { fetchProxy } from '../local/fetchProxy'
import { parseOpenAIChunk, readSseStream } from './sseReader'
import { DEFAULT_STREAM_IDLE_TIMEOUT, DEFAULT_STREAM_MAX_TIMEOUT } from '../../shared/defaults'

/** token 用量（与 SubModelOutput.tokenUsage / parseOpenAIChunk.usage 同形） */
export interface StreamUsage {
  prompt: number
  completion: number
}

export interface StreamChatOptions {
  providerBaseUrl: string
  apiKey?: string
  modelId: string
  messages: Array<{ role: string; content: string }>
  /** TTFT 超时（毫秒）：请求发出 → 首个 chunk（响应字节） */
  timeoutMs: number
  /** 外部中止信号（如网关客户端断开）；与超时信号组合，触发即中断并保留已收文本 */
  signal?: AbortSignal
  /** 增量回调：每收到一段文本增量回调累计全文（回调异常不影响收流） */
  onDelta?: (accumulatedText: string) => void
  /** stream:true 被 400 拒绝（中转不支持流式）时的非流式回退实现；缺省用内置单次 JSON 请求 */
  nonStreamFallback?: () => Promise<StreamChatResult>
  /** 空闲超时覆盖（毫秒）；缺省 DEFAULT_STREAM_IDLE_TIMEOUT，仅供测试/特殊场景 */
  idleTimeoutMs?: number
  /** 总时长上限覆盖（毫秒）；缺省 DEFAULT_STREAM_MAX_TIMEOUT，仅供测试/特殊场景 */
  maxTimeoutMs?: number
}

export interface StreamChatResult {
  /** 已收文本（中断/超时/失败时保留已收到的部分） */
  content: string
  /** usage 提取结果；上游未给 usage 时省略（不写假 0） */
  usage?: StreamUsage
  /** 失败/中止/超时原因；成功时为 undefined */
  error?: string
}

/** 单次流式尝试的结果：http-400 与 no-sse 是可降级的失败（请求未开始产出） */
type StreamAttemptResult =
  | { kind: 'ok'; content: string; usage?: StreamUsage }
  | { kind: 'http-400'; error: string }
  | { kind: 'no-sse' }
  | { kind: 'fatal'; error: string }
  | { kind: 'interrupted'; content: string; usage?: StreamUsage; error: string }

/** chat/completions 端点 URL（baseUrl 去尾斜杠后拼接） */
function chatCompletionsUrl(providerBaseUrl: string): string {
  return `${providerBaseUrl.replace(/\/+$/, '')}/chat/completions`
}

/** 请求头：Content-Type + Bearer（apiKey 有则加） */
function buildHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return headers
}

/**
 * 组合外部信号与内部（超时/主动取消）信号。
 * 优先 AbortSignal.any（Node 20.3+ / Electron 33 可用）；不可用时手写事件转发（兼容旧 Node）。
 * 返回 dispose 用于清理由本函数注册的监听（AbortSignal.any 路径无需清理）。
 */
function combineSignals(external: AbortSignal | undefined, internal: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  if (!external) return { signal: internal, dispose: () => {} }

  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  if (typeof anyFn === 'function') {
    return { signal: anyFn.call(AbortSignal, [external, internal]), dispose: () => {} }
  }

  // 兼容 fallback：手写事件转发
  const ctrl = new AbortController()
  const onAbort = (): void => ctrl.abort()
  if (external.aborted || internal.aborted) {
    ctrl.abort()
  } else {
    external.addEventListener('abort', onAbort, { once: true })
    internal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: ctrl.signal,
    dispose: () => {
      external.removeEventListener('abort', onAbort)
      internal.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * 响应体观察层（字节原样透传，不改变内容）：
 * - 每个原始 chunk 通知 onChunk（TTFT 达成判定 / idle 计时重置；注释心跳行也算 chunk）
 * - stop()：主动取消底层流。收到 [DONE] 后调用，避免服务端保持连接时干等 idle 超时
 */
function observeBody(body: ReadableStream<Uint8Array>, onChunk: () => void): { stream: ReadableStream<Uint8Array>; stop: () => void } {
  const reader = body.getReader()
  let stopped = false
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        onChunk()
        controller.enqueue(value)
      } catch (err) {
        // 网络中断/中止原样传给下游（readSseStream 会抛出，已收文本由调用方保留）
        controller.error(err)
      }
    },
    cancel(reason) {
      stopped = true
      return reader.cancel(reason)
    }
  })
  return {
    stream,
    stop: () => {
      if (stopped) return
      stopped = true
      // 流已关闭/已损坏时 cancel 可能 reject，忽略
      void reader.cancel().catch(() => {})
    }
  }
}

/** token 数口径：非有限数字按 0（与 sseReader 的 usage 解析一致） */
function toTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 顶层 usage 提取；无 usage 对象返回 undefined（不写假 0） */
function toUsage(raw: unknown): StreamUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const usage = raw as { prompt_tokens?: unknown; completion_tokens?: unknown }
  return { prompt: toTokenCount(usage.prompt_tokens), completion: toTokenCount(usage.completion_tokens) }
}

/** 失败文案优先级：外部中止 > 超时档位 > 原始错误信息 */
function failureMessage(err: unknown, signal: AbortSignal | undefined, timeoutNote: string | null): string {
  if (signal?.aborted) return '已中止'
  if (timeoutNote) return timeoutNote
  return err instanceof Error ? err.message : String(err)
}

/** 读错误响应体（本身失败时忽略，仅用于错误信息拼装） */
async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text()
  } catch {
    return ''
  }
}

/**
 * 单次流式尝试（stream:true[+stream_options]）。
 * includeStreamOptions=false 用于回退链级 2（去掉 stream_options 重发）。
 * 可降级：http-400、以及 200 但响应体不是 SSE（有字节却无任何 data 事件）；
 * HTTP 200 之后的失败一律 interrupted（不重试，保留已收文本）。
 */
async function streamOnce(opts: StreamChatOptions, includeStreamOptions: boolean): Promise<StreamAttemptResult> {
  const body: Record<string, unknown> = { model: opts.modelId, messages: opts.messages, stream: true }
  if (includeStreamOptions) body.stream_options = { include_usage: true }

  // ── 三档超时 + 外部中止：统一经内部 ctrl 组合 ──
  const ctrl = new AbortController()
  const combined = combineSignals(opts.signal, ctrl.signal)
  const idleLimit = opts.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT
  const maxLimit = opts.maxTimeoutMs ?? DEFAULT_STREAM_MAX_TIMEOUT

  let timeoutNote: string | null = null // 哪一档超时触发（映射为 error 文案）
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  /** 档 2：idle（chunk 间隔；每收到一个 chunk 重置） */
  const armIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      timeoutNote = `流空闲超时（${idleLimit}ms）`
      ctrl.abort()
    }, idleLimit)
  }
  /** 档 1：TTFT（请求发出 → 首个 chunk，含响应头等待） */
  const ttftTimer = setTimeout(() => {
    timeoutNote = `首块响应超时（${opts.timeoutMs}ms）`
    ctrl.abort()
  }, opts.timeoutMs)
  /** 档 3：总时长绝对上限（不重置） */
  const maxTimer = setTimeout(() => {
    timeoutNote = `流总时长超时（${maxLimit}ms）`
    ctrl.abort()
  }, maxLimit)
  const clearTimers = (): void => {
    clearTimeout(ttftTimer)
    clearTimeout(maxTimer)
    if (idleTimer !== undefined) clearTimeout(idleTimer)
  }

  let acc = ''
  let usage: StreamUsage | undefined
  let sawDone = false
  let sawBytes = false // 收到过响应体字节（区分 0 字节空流）
  let sawDataEvent = false // 派发过 SSE data 事件（区分「200 但不是 SSE」的 JSON 响应体）
  let tapped: { stream: ReadableStream<Uint8Array>; stop: () => void } | null = null

  try {
    let resp: Response
    try {
      resp = await fetchProxy(chatCompletionsUrl(opts.providerBaseUrl), {
        method: 'POST',
        headers: buildHeaders(opts.apiKey),
        body: JSON.stringify(body),
        signal: combined.signal
      })
    } catch (err) {
      return { kind: 'fatal', error: failureMessage(err, opts.signal, timeoutNote) }
    }

    if (!resp.ok) {
      const errText = await safeText(resp)
      const error = `HTTP ${resp.status}: ${errText.slice(0, 300)}`
      // 400 = 请求被拒且未产出（stream_options / stream 不支持）→ 交给回退链降级
      return resp.status === 400 ? { kind: 'http-400', error } : { kind: 'fatal', error }
    }

    if (!resp.body) return { kind: 'ok', content: '' }

    tapped = observeBody(resp.body, () => {
      sawBytes = true
      clearTimeout(ttftTimer) // 首个 chunk 到达：TTFT 达成（此后只剩 idle / 总上限）
      armIdle()
    })

    try {
      await readSseStream(tapped.stream, (data) => {
        if (data === '[DONE]') {
          sawDone = true
          sawDataEvent = true // [DONE] 本身就是 SSE 帧
          tapped?.stop() // 立即停止读取，不等服务端关闭连接
          return
        }
        sawDataEvent = true
        const chunk = parseOpenAIChunk(data)
        if (!chunk) return
        if (typeof chunk.content === 'string' && chunk.content !== '') {
          acc += chunk.content
          if (opts.onDelta) {
            try {
              opts.onDelta(acc)
            } catch {
              /* 增量回调属观察者，失败不影响收流 */
            }
          }
        }
        if (chunk.usage) usage = chunk.usage
      })
    } catch (err) {
      // [DONE] 已收到后的读取错误（stop() 主动取消 / 服务端 RST）视为正常结束
      if (sawDone) return { kind: 'ok', content: acc, usage }
      const message = opts.signal?.aborted
        ? '已中止'
        : (timeoutNote ?? `流中断：${err instanceof Error ? err.message : String(err)}`)
      return { kind: 'interrupted', content: acc, usage, error: message }
    }
    // HTTP 200 但响应体不是 SSE（有字节却无任何 data 事件，如中转忽略 stream:true 直接回 JSON）：
    // 视为请求未产出流，交回退链走非流式（无损）。0 字节空流不算（按自然结束成功处理）。
    if (sawBytes && !sawDataEvent) return { kind: 'no-sse' }
    return { kind: 'ok', content: acc, usage }
  } finally {
    clearTimers()
    tapped?.stop() // 失败/超时/中止路径同样断开底层流
    combined.dispose()
  }
}

/** 非流式回退：单次 JSON 请求（stream:false）；上游未给 usage 时省略（不写假 0） */
async function requestNonStream(opts: StreamChatOptions): Promise<StreamChatResult> {
  const ctrl = new AbortController()
  const combined = combineSignals(opts.signal, ctrl.signal)
  let timedOut = false
  // 非流式无 chunk 概念：timeoutMs 视为整请求上限
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, opts.timeoutMs)

  try {
    const resp = await fetchProxy(chatCompletionsUrl(opts.providerBaseUrl), {
      method: 'POST',
      headers: buildHeaders(opts.apiKey),
      body: JSON.stringify({ model: opts.modelId, messages: opts.messages, stream: false }),
      signal: combined.signal
    })
    if (!resp.ok) {
      const errText = await safeText(resp)
      return { content: '', error: `HTTP ${resp.status}: ${errText.slice(0, 300)}` }
    }

    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: unknown } }>; usage?: unknown }
    const first = data.choices?.[0]
    const content = typeof first?.message?.content === 'string' ? first.message.content : ''
    const usage = toUsage(data.usage)
    const result: StreamChatResult = { content }
    if (usage) result.usage = usage
    return result
  } catch (err) {
    const message = opts.signal?.aborted
      ? '已中止'
      : timedOut
        ? `回退请求超时（${opts.timeoutMs}ms）`
        : err instanceof Error
          ? err.message
          : String(err)
    return { content: '', error: message }
  } finally {
    clearTimeout(timer)
    combined.dispose()
  }
}

/**
 * 通用流式调用（永不 throw）：
 * ① stream:true + stream_options.include_usage → ② 被 400 拒绝则去掉 stream_options 重发
 * → ③ 再被 400 拒绝（中转不支持流式），或 200 但响应体根本不是 SSE → 非流式单次请求（优先 opts.nonStreamFallback）。
 * 200 之后的流中断/超时/中止不重试（可能已计费），保留已收文本返回 error。
 */
export async function streamChat(opts: StreamChatOptions): Promise<StreamChatResult> {
  if (opts.signal?.aborted) return { content: '', error: '已中止' }

  // 级 1：stream + stream_options
  let attempt = await streamOnce(opts, true)

  // 级 2：stream_options 被 400 拒绝 → 去掉重发（请求未开始产出，无损）
  if (attempt.kind === 'http-400') attempt = await streamOnce(opts, false)

  // 级 3：stream:true 被 400 拒绝 / 200 但不是 SSE → 非流式单次请求
  if (attempt.kind === 'http-400' || attempt.kind === 'no-sse') {
    if (!opts.nonStreamFallback) return await requestNonStream(opts)
    try {
      return await opts.nonStreamFallback()
    } catch (err) {
      return { content: '', error: err instanceof Error ? err.message : String(err) }
    }
  }

  if (attempt.kind === 'ok') {
    const result: StreamChatResult = { content: attempt.content }
    if (attempt.usage) result.usage = attempt.usage
    return result
  }
  if (attempt.kind === 'interrupted') {
    const result: StreamChatResult = { content: attempt.content, error: attempt.error }
    if (attempt.usage) result.usage = attempt.usage
    return result
  }
  return { content: '', error: attempt.error }
}
