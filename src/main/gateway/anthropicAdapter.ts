// Anthropic Messages API（/v1/messages）↔ OpenAI Chat Completions 双向转换 + Anthropic SSE 事件生成。
// 纯函数、零依赖（不含任何 import，可在纯 Node 测试中直接 transform 加载）——Anthropic 格式只在网关边界转换，
// 内部统一走 OpenAI 兼容管线（引擎、上游 providers、事件桥全部复用）。
// 设计说明见 .hermes/plans/2026-09-18-moa-live-streaming.md §4.9

// ── 通用小工具 ──

/** 普通对象判定（数组/null 均false） */
function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 生成消息 id（无外部依赖；调用方可显式传入以覆盖） */
function makeMessageId(): string {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

// ── 请求转换：Anthropic → OpenAI ──

/** 转换后的 OpenAI 兼容消息（content 为纯文本或内容块数组；工具调用/结果带 tool_calls / tool_call_id） */
export interface AdapterContentPart {
  type: string
  [key: string]: unknown
}

export interface AdapterToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface AdapterMessage {
  role: string
  content?: string | AdapterContentPart[]
  tool_calls?: AdapterToolCall[]
  tool_call_id?: string
}

export interface AnthropicToOpenAIResult {
  /** 转换后的消息序列（system 首条；tool_result 拆分为 role:'tool' 消息，顺序保持） */
  messages: AdapterMessage[]
  /** 附加请求字段：tools / tool_choice / temperature / top_p / stop（原 stop_sequences） */
  extraBody: Record<string, unknown>
  /** 原 max_tokens（OpenAI 无对应字段，仅保留记录，不并入请求体——避免超出上游模型上限被 400 拒绝） */
  maxTokens?: number
}

/** system（string | blocks）→ system 文本（拼接 text；忽略 cache_control 等非文本字段）；无内容 → null */
function systemToText(system: unknown): string | null {
  if (typeof system === 'string') return system === '' ? null : system
  if (!Array.isArray(system)) return null
  const texts: string[] = []
  for (const block of system) {
    if (isObj(block) && typeof block.text === 'string') texts.push(block.text)
  }
  return texts.length > 0 ? texts.join('\n\n') : null
}

/** content 块数组（text/image）→ OpenAI 消息 content：纯文本拼接为 string，含图片时用内容块数组 */
function joinContentParts(parts: AdapterContentPart[]): string | AdapterContentPart[] {
  if (parts.length === 0) return ''
  if (parts.every((part) => part.type === 'text')) {
    return parts.map((part) => String(part.text)).join('\n\n')
  }
  return parts
}

/** image 块（base64 / url）→ OpenAI image_url 内容块；无法识别 → null（跳过该块） */
function imageToPart(block: Record<string, unknown>): AdapterContentPart | null {
  const source = block.source
  if (!isObj(source)) return null
  const sourceType = typeof source.type === 'string' ? source.type : ''
  if (sourceType === 'base64') {
    const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/png'
    const data = typeof source.data === 'string' ? source.data : ''
    if (data === '') return null
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } }
  }
  if (sourceType === 'url' && typeof source.url === 'string' && source.url !== '') {
    return { type: 'image_url', image_url: { url: source.url } }
  }
  return null
}

/** tool_use 块 → assistant tool_calls 条目；缺 name 视为无效（丢弃）。id 缺失时按 name 兜底生成 */
function toolUseToCall(block: Record<string, unknown>): AdapterToolCall | null {
  const name = typeof block.name === 'string' ? block.name : ''
  if (name === '') return null
  const id = typeof block.id === 'string' && block.id !== '' ? block.id : `call_${name}`
  const input = isObj(block.input) ? block.input : {}
  return { id, type: 'function', function: { name, arguments: JSON.stringify(input) } }
}

/** tool_result 的内容（string | blocks）→ tool 消息文本（非文本块 JSON 原样保留，避免信息丢失） */
function toolResultContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const texts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') { texts.push(block); continue }
    if (!isObj(block)) continue
    if (typeof block.text === 'string') { texts.push(block.text); continue }
    texts.push(JSON.stringify(block))
  }
  return texts.join('\n\n')
}

/** tool_result 块 → role:'tool' 消息；tool_use_id 与内容均空 → null（无可表达信息） */
function toolResultToMessage(block: Record<string, unknown>): AdapterMessage | null {
  const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
  const content = toolResultContentToText(block.content)
  if (toolUseId === '' && content === '') return null
  return { role: 'tool', tool_call_id: toolUseId, content }
}

/**
 * 单条 Anthropic 消息 → 一条或多条 OpenAI 消息。
 * - text/image 块聚合为一条消息（纯文本 → string；含图片 → 内容块数组）
 * - tool_use 块并入所在 assistant 消息的 tool_calls（与文本同条）
 * - tool_result 块拆分为独立 role:'tool' 消息（含混合内容的消息按原顺序拆分）
 */
function convertMessage(msg: unknown): AdapterMessage[] {
  if (!isObj(msg)) return []
  const role = typeof msg.role === 'string' ? msg.role : 'user'
  const content = msg.content
  if (typeof content === 'string') return content === '' ? [] : [{ role, content }]
  if (!Array.isArray(content)) return []

  const out: AdapterMessage[] = []
  let parts: AdapterContentPart[] = []
  let toolCalls: AdapterToolCall[] = []
  const flush = (): void => {
    if (parts.length === 0 && toolCalls.length === 0) return
    const message: AdapterMessage = { role, content: joinContentParts(parts) }
    if (toolCalls.length > 0) message.tool_calls = toolCalls
    out.push(message)
    parts = []
    toolCalls = []
  }

  for (const block of content) {
    if (!isObj(block)) continue
    const type = typeof block.type === 'string' ? block.type : ''
    if (type === 'tool_result') {
      flush() // 混排的 text/image 先落一条，tool_result 保持原顺序单独成条
      const toolMessage = toolResultToMessage(block)
      if (toolMessage) out.push(toolMessage)
      continue
    }
    if (type === 'tool_use') {
      const call = toolUseToCall(block)
      if (call) toolCalls.push(call)
      continue
    }
    if (type === 'image') {
      const part = imageToPart(block)
      if (part) parts.push(part)
      continue
    }
    // text 及未知块：取 text 字段（cache_control 等其余字段忽略；无 text 的未知块跳过）
    if (typeof block.text === 'string') parts.push({ type: 'text', text: block.text })
  }
  flush()
  return out
}

/** tools（[{name,description,input_schema}]）→ OpenAI tools；无有效工具 → null */
function toolsToOpenAI(tools: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(tools)) return null
  const out: Array<Record<string, unknown>> = []
  for (const tool of tools) {
    if (!isObj(tool)) continue
    const name = typeof tool.name === 'string' ? tool.name : ''
    if (name === '') continue
    const fn: Record<string, unknown> = { name }
    if (typeof tool.description === 'string') fn.description = tool.description
    // input_schema 缺失/非法时给空对象 schema（部分上游要求 parameters 必需）
    fn.parameters = isObj(tool.input_schema) ? tool.input_schema : { type: 'object', properties: {} }
    out.push({ type: 'function', function: fn })
  }
  return out.length > 0 ? out : null
}

/** tool_choice 映射：auto→auto；any→required；none→none；{type:'tool',name}→{type:'function',function:{name}}；其余 → null */
function toolChoiceToOpenAI(choice: unknown): string | Record<string, unknown> | null {
  if (typeof choice === 'string') return choice // 已是 OpenAI 风格（宽松兼容）
  if (!isObj(choice)) return null
  const type = typeof choice.type === 'string' ? choice.type : ''
  if (type === 'auto') return 'auto'
  if (type === 'any') return 'required'
  if (type === 'none') return 'none'
  if (type === 'tool' && typeof choice.name === 'string' && choice.name !== '') {
    return { type: 'function', function: { name: choice.name } }
  }
  return null
}

/**
 * Anthropic /v1/messages 请求体 → OpenAI 兼容请求。
 * 忽略不报错：anthropic-version / anthropic-beta 头、thinking、metadata、cache_control（后者仅在块内被跳过）。
 */
export function anthropicToOpenAI(body: unknown): AnthropicToOpenAIResult {
  const root = isObj(body) ? body : {}

  const messages: AdapterMessage[] = []
  const systemText = systemToText(root.system)
  if (systemText !== null) messages.push({ role: 'system', content: systemText })
  const rawMessages = Array.isArray(root.messages) ? root.messages : []
  for (const msg of rawMessages) messages.push(...convertMessage(msg))

  const extraBody: Record<string, unknown> = {}
  if (typeof root.temperature === 'number') extraBody.temperature = root.temperature
  if (typeof root.top_p === 'number') extraBody.top_p = root.top_p
  if (Array.isArray(root.stop_sequences) && root.stop_sequences.length > 0) extraBody.stop = root.stop_sequences
  const tools = toolsToOpenAI(root.tools)
  if (tools) extraBody.tools = tools
  const toolChoice = toolChoiceToOpenAI(root.tool_choice)
  if (toolChoice !== null) extraBody.tool_choice = toolChoice

  const result: AnthropicToOpenAIResult = { messages, extraBody }
  if (typeof root.max_tokens === 'number') result.maxTokens = root.max_tokens
  return result
}

// ── 响应转换：OpenAI → Anthropic ──

/** openAIToAnthropic 输入：聚合结果（content / tool_calls / finish_reason / usage） */
export interface OpenAIToAnthropicInput {
  content: string
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  finishReason?: string | null
  usage?: { prompt: number; completion: number } | null
}

export interface OpenAIToAnthropicOptions {
  /** 响应 id（缺省自动生成 msg_*） */
  id?: string
  /** 响应 model 名（缺省 moa-aggregated） */
  model?: string
}

export interface AnthropicResponseBlock {
  type: string
  [key: string]: unknown
}

export interface AnthropicMessageBody {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: AnthropicResponseBlock[]
  stop_reason: 'tool_use' | 'max_tokens' | 'end_turn'
  stop_sequence: null
  usage: { input_tokens: number; output_tokens: number }
}

/** OpenAI arguments（JSON 字符串）→ Anthropic input 对象；空串/解析失败/非对象 → {} */
export function parseToolInput(argumentsText: string | undefined): Record<string, unknown> {
  if (!argumentsText) return {}
  try {
    const parsed: unknown = JSON.parse(argumentsText)
    return isObj(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** stop_reason 映射：有工具调用 → 'tool_use'；length/max_tokens → 'max_tokens'；其余（stop/null）→ 'end_turn' */
export function anthropicStopReason(
  hasToolCalls: boolean,
  finishReason?: string | null
): 'tool_use' | 'max_tokens' | 'end_turn' {
  if (hasToolCalls) return 'tool_use'
  if (finishReason === 'length' || finishReason === 'max_tokens') return 'max_tokens'
  return 'end_turn'
}

/** 非流式响应体：文本 delta → content 数组（text 块 + tool_use 块；文本为空则只有 tool_use 块） */
export function openAIToAnthropic(
  result: OpenAIToAnthropicInput,
  opts: OpenAIToAnthropicOptions = {}
): AnthropicMessageBody {
  const toolCalls = result.toolCalls ?? []
  const content: AnthropicResponseBlock[] = []
  if (result.content !== '') content.push({ type: 'text', text: result.content })
  toolCalls.forEach((call, index) => {
    content.push({
      type: 'tool_use',
      id: call.id !== '' ? call.id : `toolu_${index}`,
      name: call.name,
      input: parseToolInput(call.arguments)
    })
  })
  return {
    id: opts.id || makeMessageId(),
    type: 'message',
    role: 'assistant',
    model: opts.model || 'moa-aggregated',
    content,
    stop_reason: anthropicStopReason(toolCalls.length > 0, result.finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: result.usage?.prompt ?? 0,
      output_tokens: result.usage?.completion ?? 0
    }
  }
}

// ── 流式事件生成：Anthropic SSE ──

/** 单条 Anthropic SSE 事件（event 类型 + data 载荷；data.type 与 event 同名） */
export interface AnthropicSseEvent {
  event: string
  data: Record<string, unknown>
}

/** 事件对象 → SSE 文本（Anthropic 格式：event 行 + data 行 + 空行；与 OpenAI data-only 格式不同） */
export function formatAnthropicSse(event: AnthropicSseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`
}

export interface AnthropicStreamState {
  /** 起始序列：message_start + content_block_start(text)（重复调用返回空数组） */
  start(): AnthropicSseEvent[]
  /** 文本增量：content_block_delta{text_delta}（惰性补齐起始序列） */
  textDelta(text: string): AnthropicSseEvent[]
  /** 收尾序列：content_block_stop(text) + [tool_use 块（一次性 input_json_delta）] + message_delta{stop_reason,usage} + message_stop */
  end(opts?: {
    toolCalls?: Array<{ id: string; name: string; arguments: string }>
    stopReason?: string | null
    usage?: { prompt: number; completion: number } | null
  }): AnthropicSseEvent[]
}

export interface AnthropicStreamStateOptions {
  id?: string
  model?: string
}

/**
 * Anthropic 流式事件状态机（纯函数：只产事件对象，不做任何 IO——写字节由调用方负责）。
 * 序列：message_start → content_block_start(text) → content_block_delta{text_delta}×N → content_block_stop
 *       → [content_block_start{tool_use,input:{}} → input_json_delta{完整 JSON} → content_block_stop]×M
 *       → message_delta{stop_reason,usage} → message_stop
 */
export function createAnthropicStreamState(opts: AnthropicStreamStateOptions = {}): AnthropicStreamState {
  const id = opts.id || makeMessageId()
  const model = opts.model || 'moa-aggregated'
  const textIndex = 0
  let started = false
  let ended = false

  const startEvents = (): AnthropicSseEvent[] => {
    if (started) return []
    started = true
    return [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        }
      },
      {
        event: 'content_block_start',
        data: { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } }
      }
    ]
  }

  return {
    start: () => startEvents(),
    textDelta: (text: string): AnthropicSseEvent[] => {
      if (ended || text === '') return []
      const events = startEvents()
      events.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text } }
      })
      return events
    },
    end: (endOpts): AnthropicSseEvent[] => {
      if (ended) return []
      const events = startEvents() // 无文本也补全起始序列（事件序列完整）
      ended = true
      events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: textIndex } })

      const toolCalls = endOpts?.toolCalls ?? []
      toolCalls.forEach((call, i) => {
        const index = textIndex + 1 + i
        events.push({
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: call.id !== '' ? call.id : `toolu_${i}`, name: call.name, input: {} }
          }
        })
        events.push({
          event: 'content_block_delta',
          data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: call.arguments !== '' ? call.arguments : '{}' } }
        })
        events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } })
      })

      events.push({
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: anthropicStopReason(toolCalls.length > 0, endOpts?.stopReason), stop_sequence: null },
          // usage 同时带 input_tokens（Anthropic 在 message_start 给输入侧；此处一次性给出已知完整用量）
          usage: {
            input_tokens: endOpts?.usage?.prompt ?? 0,
            output_tokens: endOpts?.usage?.completion ?? 0
          }
        }
      })
      events.push({ event: 'message_stop', data: { type: 'message_stop' } })
      return events
    }
  }
}

/**
 * 完整事件序列生成（纯函数驱动 state 状态机，二者同源）：
 * 给定文本增量序列 + 可选 toolCalls/usage/stopReason，返回整段 Anthropic SSE 事件数组。
 * 网关真流式路径用 createAnthropicStreamState 增量产出；本函数用于整段校验/测试。
 */
export function anthropicStreamEvents(input: {
  textDeltas?: string[]
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  usage?: { prompt: number; completion: number } | null
  stopReason?: string | null
  id?: string
  model?: string
}): AnthropicSseEvent[] {
  const state = createAnthropicStreamState({ id: input.id, model: input.model })
  const events = state.start()
  for (const delta of input.textDeltas ?? []) events.push(...state.textDelta(delta))
  events.push(...state.end({ toolCalls: input.toolCalls, stopReason: input.stopReason, usage: input.usage }))
  return events
}
