// SSE 流读取器（纯 Node，零依赖）
// 职责：把 fetch 响应体（ReadableStream<Uint8Array>）增量解码为文本，按 SSE 规范切事件，
// 逐事件回调 data（多行 data: 以 '\n' 拼接，'[DONE]' 原样透传）与可选 event 类型。
// 不 import 任何 Electron / 项目内模块，可在纯 Node 测试中直接加载。
// 设计说明见 .hermes/plans/2026-09-18-moa-live-streaming.md §4.1

/** OpenAI 兼容流式响应的单条 chunk 解析结果（字段均可缺省；整体无效时为 null） */
export interface OpenAIStreamChunk {
  /** choices[0].delta.content：本帧文本增量 */
  content?: string
  /** choices[0].delta.tool_calls：本帧全部工具调用增量（index 为分片下标；id/name 通常首帧给出，arguments 逐帧拼接；兼容 function 嵌套与平铺两种形态；无有效条目时字段不出现） */
  toolCallsDelta?: Array<{ index: number; id?: string; name?: string; arguments?: string }>
  /** choices[0].finish_reason：非 null 字符串才有效（stop / length / tool_calls 等） */
  finishReason?: string | null
  /** 顶层 usage（stream_options.include_usage 终结块，或 OpenRouter 等挂在非空 choices 末帧）：token 计数 */
  usage?: { prompt: number; completion: number }
}

/** readSseStream 的解析中间态 */
interface SseState {
  /** 尚不构成完整行的残留文本（不含行终止符；可能是一个孤立 \r，等下一块确认是否 \r\n） */
  buffer: string
  /** 当前事件累积的 data 值（多行按出现顺序保存） */
  dataLines: string[]
  /** 当前事件的 event: 类型（同一事件内多次出现以最后一次为准） */
  eventType?: string
}

/**
 * 读取 SSE 流，每解析出一个完整事件就回调：data 为多行 data: 拼接结果，event 为 event: 行（无则 undefined）。
 * - '\n\n' 与 '\r\n\r\n' 均可作事件分隔（孤立 \r 也按行终止符处理）
 * - ':' 开头的注释/心跳行、id:/retry: 等未知字段行忽略；无 data（或 data 为空串）的事件不派发
 * - '[DONE]' 原样作为 data 传给 onData，由调用方判断
 * - 流结束时处理残余 buffer：缺结尾空行的最后一个事件照常派发
 * - 中途报错：已完整的事件都已回调，随后原样抛出异常（调用方保留已收文本）
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onData: (data: string, event?: string) => void
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  const state: SseState = { buffer: '', dataLines: [] }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // stream: true：多字节字符被 chunk 截断时先缓存不完整字节，等下一块拼齐再解码
      if (value && value.length > 0) feed(state, decoder.decode(value, { stream: true }), onData)
    }
  } finally {
    // 正常结束或中途报错都到这里：冲掉解码器内部残余字节，再收尾尾部事件
    feed(state, decoder.decode(), onData)
    flushTail(state, onData)
    try {
      reader.releaseLock()
    } catch {
      // 流处于 errored 状态时释放锁可能抛错，忽略
    }
  }
}

/**
 * 解析 OpenAI 兼容 /v1/chat/completions 流式响应的单条 SSE data。
 * - '[DONE]'、非法 JSON、解析后无有效字段 → null（绝不抛错）
 * - choices[0].delta.content → content
 * - choices[0].delta.tool_calls 全部条目 → toolCallsDelta 数组（index/id/name/arguments 增量字段原样保留，本帧有几条就返回几条）
 * - choices[0].finish_reason（非 null 字符串）→ finishReason
 * - 顶层 usage（include_usage 终结块 / 末帧挂 usage 的中转）→ usage；choices 空数组或非空都解析
 */
export function parseOpenAIChunk(data: string): OpenAIStreamChunk | null {
  if (data === '[DONE]') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  const root = parsed as { choices?: unknown; usage?: unknown }
  const choices = Array.isArray(root.choices) ? root.choices : []
  const chunk: OpenAIStreamChunk = {}

  if (choices.length > 0) {
    const first: unknown = choices[0]
    if (typeof first === 'object' && first !== null) {
      const choice = first as { delta?: unknown; finish_reason?: unknown }
      const delta = typeof choice.delta === 'object' && choice.delta !== null ? (choice.delta as Record<string, unknown>) : null
      if (delta) {
        if (typeof delta.content === 'string') chunk.content = delta.content
        const toolCallsDelta = pickToolCallsDelta(delta.tool_calls)
        if (toolCallsDelta) chunk.toolCallsDelta = toolCallsDelta
      }
      // null 的 finish_reason 是过程帧（无信息量），只收非 null 字符串
      if (typeof choice.finish_reason === 'string') chunk.finishReason = choice.finish_reason
    }
  }

  // 顶层 usage 与 choices 是否为空无关：include_usage 终结块（空 choices）与 OpenRouter 等挂在末帧（choices 非空）都收
  if (typeof root.usage === 'object' && root.usage !== null) {
    const usage = root.usage as { prompt_tokens?: unknown; completion_tokens?: unknown }
    chunk.usage = { prompt: toTokenCount(usage.prompt_tokens), completion: toTokenCount(usage.completion_tokens) }
  }

  return Object.keys(chunk).length > 0 ? chunk : null
}

/** toolCallsDelta 的单条元素（从接口派生，避免类型重复） */
type ToolCallDelta = NonNullable<OpenAIStreamChunk['toolCallsDelta']>[number]

/** 取 choices[0].delta.tool_calls 的全部条目增量（数组顺序=原顺序）；无有效条目返回 null（index 缺失或非法按 0 兜底） */
function pickToolCallsDelta(value: unknown): OpenAIStreamChunk['toolCallsDelta'] | null {
  if (!Array.isArray(value)) return null
  const deltas: ToolCallDelta[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue // 非对象条目无字段可取，跳过

    const toolCall = item as { index?: unknown; id?: unknown; name?: unknown; arguments?: unknown; function?: unknown }
    // 标准 OpenAI 把 name/arguments 放在 tool_calls[].function 内，部分兼容厂商平铺在顶层，两者都收
    const fn = typeof toolCall.function === 'object' && toolCall.function !== null ? (toolCall.function as { name?: unknown; arguments?: unknown }) : null

    const delta: ToolCallDelta = {
      index: typeof toolCall.index === 'number' && Number.isFinite(toolCall.index) ? toolCall.index : 0
    }
    if (typeof toolCall.id === 'string') delta.id = toolCall.id
    const name = pickString(fn ? fn.name : undefined, toolCall.name)
    if (name !== undefined) delta.name = name
    const args = pickString(fn ? fn.arguments : undefined, toolCall.arguments)
    if (args !== undefined) delta.arguments = args
    deltas.push(delta)
  }
  return deltas.length > 0 ? deltas : null
}

/** 依次取第一个字符串候选（用于兼容 function 嵌套与平铺两种字段位置） */
function pickString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string') return candidate
  }
  return undefined
}

/** token 数兜底：非有限数字一律 0（对应 usage.prompt_tokens || 0 的口径） */
function toTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 扫描文本块：按行终止符切行交给 handleLine；块尾不完整的行留在 buffer 等下一块 */
function feed(state: SseState, text: string, onData: (data: string, event?: string) => void): void {
  const buf = state.buffer + text
  let lineStart = 0
  let i = 0
  while (i < buf.length) {
    const code = buf.charCodeAt(i)
    if (code === 10) {
      // \n
      handleLine(buf.slice(lineStart, i), state, onData)
      i += 1
      lineStart = i
    } else if (code === 13) {
      // \r：后随 \n 则一并消费；孤立 \r 也算终止符；若 \r 正好在块尾则留下等下一块（可能只是 \r\n 的前半）
      if (i === buf.length - 1) break
      handleLine(buf.slice(lineStart, i), state, onData)
      i += buf.charCodeAt(i + 1) === 10 ? 2 : 1
      lineStart = i
    } else {
      i += 1
    }
  }
  state.buffer = buf.slice(lineStart)
}

/** 流结束收尾：残余 buffer 视为最后一行（无行终止符也算），随后派发缺结尾空行的最后一个事件 */
function flushTail(state: SseState, onData: (data: string, event?: string) => void): void {
  const tail = state.buffer
  state.buffer = ''
  if (tail !== '') handleLine(tail.endsWith('\r') ? tail.slice(0, -1) : tail, state, onData)
  dispatch(state, onData)
}

/** 单行解析：data 累积；event 记录类型；':' 开头为注释/心跳；id:/retry: 等字段忽略 */
function handleLine(line: string, state: SseState, onData: (data: string, event?: string) => void): void {
  if (line === '') {
    dispatch(state, onData) // 空行 = 事件边界
    return
  }
  if (line.startsWith(':')) return

  const colon = line.indexOf(':')
  const field = colon === -1 ? line : line.slice(0, colon)
  let value = colon === -1 ? '' : line.slice(colon + 1)
  if (value.startsWith(' ')) value = value.slice(1) // 规范：只去掉冒号后的一个前导空格

  if (field === 'data') {
    state.dataLines.push(value)
  } else if (field === 'event') {
    state.eventType = value
  }
  // id / retry 等其他字段：忽略
}

/** 派发当前累积事件：data 行以 '\n' 拼接（含 [DONE]）；无 data 或 data 为空串的事件不派发（SSE 规范） */
function dispatch(state: SseState, onData: (data: string, event?: string) => void): void {
  const event = state.eventType
  state.eventType = undefined
  if (state.dataLines.length === 0) return
  const data = state.dataLines.join('\n')
  state.dataLines = []
  if (data !== '') onData(data, event)
}
