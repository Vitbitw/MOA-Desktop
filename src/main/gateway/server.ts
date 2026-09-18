import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import cors, { type CorsOptions } from 'cors'
import crypto from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { getAllProviders } from '../providers/providerManager'
import { getMoaConfig } from '../moa/moaConfig'
import { executeMoAWithEvents, resolveSubModels } from '../moa/moaEngine'
import { createThrottledEmitter, STREAM_PUSH_INTERVAL_MS } from '../moa/streamThrottle'
import type { ThrottledEmitter } from '../moa/streamThrottle'
import { parseOpenAIChunk, readSseStream } from '../moa/sseReader'
import { accumulateToolCalls, toolCallsFromMessage, toolCallsOrUndefined } from '../moa/streamChat'
import type { ChatMessage, ToolCallResult } from '../moa/streamChat'
import { anthropicToOpenAI, createAnthropicStreamState, formatAnthropicSse, openAIToAnthropic } from './anthropicAdapter'
import { getDatabase } from '../db/database'
import { readAppSettings } from '../config/appSettings'
import { buildUsageEntries, sumUsage } from '../moa/usage'
import type { Provider, SubModelOutput } from '../../shared/types'
import type { MoaResponse } from '../moa/moaEngine'
import type { MoaRuntimeConfig } from '../moa/moaConfig'
import { fetchProxy } from '../local/fetchProxy'
import { broadcastToUi, GATEWAY_ROUND_START, GATEWAY_SUB_UPDATE, GATEWAY_AGG_START, GATEWAY_AGG_CHUNK, GATEWAY_ROUND_DONE } from '../uiBridge'
import type { GatewayRoundStartPayload, GatewaySubUpdatePayload, GatewayAggStartPayload, GatewayAggChunkPayload, GatewayRoundDonePayload } from '../uiBridge'

let server: Server | null = null
/** 当前 server 对应的设置值（host/port），applyGatewayServer 幂等判断用 */
let runningConfig: { host: string; port: number } | null = null

/** 上游转发请求的超时预算（30 分钟）。带信号调用可避免 fetchProxy 的全局 timeoutMs
 * 误伤非流式慢速上游（模型思考 >15s 时首字节迟迟不回）；30 分钟为兜底上限。 */
const UPSTREAM_TIMEOUT_MS = 30 * 60_000

// ── 并发计数与限流 ──
// 此前 /health 的 activeRequests/queueLength 硬编码 0，maxConcurrency 设置从未生效。
let activeRequests = 0
let queueLength = 0
const waiters: Array<() => void> = []

/** 读取网关最大并发数（settings.gateway.maxConcurrency；UI 写入保证 ≥1）。 */
function getMaxConcurrency(): number {
  return readAppSettings().gateway.maxConcurrency
}

/** 获取并发许可；超限则进入 FIFO 等待队列。 */
function acquire(): Promise<void> {
  if (activeRequests < getMaxConcurrency()) {
    activeRequests++
    return Promise.resolve()
  }
  queueLength++
  return new Promise((resolve) => {
    waiters.push(() => {
      queueLength--
      activeRequests++
      resolve()
    })
  })
}

function release(): void {
  activeRequests = Math.max(0, activeRequests - 1)
  const next = waiters.shift()
  if (next) next()
}

// ── 代理鉴权 ──
// settings.gateway.authEnabled + gatewayKey 均配置时，/v1/* 请求必须携带相同密钥
// （请求头 x-api-key 或 Authorization: Bearer <key>）。
function getGatewayAuth(): { enabled: boolean; key: string } {
  const { authEnabled, gatewayKey } = readAppSettings().gateway
  if (authEnabled && gatewayKey) return { enabled: true, key: String(gatewayKey) }
  return { enabled: false, key: '' }
}

/** 网关鉴权中间件（仅挂载在 /v1/* 上；/health 除外） */
function gatewayAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const auth = getGatewayAuth()
  if (!auth.enabled) { next(); return }
  const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : ''
  const provided =
    (typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : '') ||
    (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '')
  if (provided && provided === auth.key) { next(); return }
  res.status(401).json({
    error: { message: 'Unauthorized: invalid or missing API key.', type: 'unauthorized' }
  })
}

// ── 网关请求记账 ──
// 此前网关流量从不写入 request_logs，用量统计（今日/总计/悬浮窗）只覆盖 App 内聊天，
// 第三方客户端经本地网关产生的费用完全不可见。这里统一记录（source='gateway'）。

/** 组装 moa 结果的用量明细（成功子模型 + 聚合器），供 request_logs.models 使用 */
function usageInputsFromMoa(result: {
  subOutputs: SubModelOutput[]
  aggregatorUsage?: { prompt: number; completion: number }
  aggregatorModelId?: string
  aggregatorProviderId?: string
}): Array<{ modelId: string; providerId?: string; role: 'sub' | 'agg'; prompt: number; completion: number }> {
  const inputs: Array<{ modelId: string; providerId?: string; role: 'sub' | 'agg'; prompt: number; completion: number }> = []
  for (const o of result.subOutputs) {
    if (o.status === 'success' && o.tokenUsage) {
      inputs.push({
        modelId: o.modelId,
        providerId: o.providerId,
        role: 'sub',
        prompt: o.tokenUsage.prompt,
        completion: o.tokenUsage.completion
      })
    }
  }
  if (result.aggregatorUsage) {
    inputs.push({
      modelId: result.aggregatorModelId || '',
      providerId: result.aggregatorProviderId,
      role: 'agg',
      prompt: result.aggregatorUsage.prompt,
      completion: result.aggregatorUsage.completion
    })
  }
  return inputs
}

interface GatewayLogEntry {
  moaMode: string
  success: boolean
  prompt: number
  completion: number
  durationMs: number
  subCount: number
  models?: Array<{ modelId: string; providerId?: string; role: 'sub' | 'agg'; prompt: number; completion: number }>
  error?: string | null
}

/** 写入一条网关请求日志（source='gateway'）；记录模式 'stats' 仅落汇总计数，不落模型级明细 */
function logGatewayRequest(entry: GatewayLogEntry): void {
  try {
    const entries = buildUsageEntries((entry.models || []).map((m) => ({ ...m, cost: 0 })))
    const totals = sumUsage(entries)
    const storedModels = readAppSettings().gateway.recording === 'full' ? entries : []
    getDatabase().exec(
      `INSERT INTO request_logs (request_id, timestamp, client_ip, source, moa_mode, sub_count, prompt_tokens, completion_tokens, cost, duration_ms, success, error_detail, models)
       VALUES (?, ?, '127.0.0.1', 'gateway', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        Date.now(),
        entry.moaMode,
        entry.subCount,
        Math.round(entry.prompt),
        Math.round(entry.completion),
        totals.cost,
        Math.round(entry.durationMs),
        entry.success ? 1 : 0,
        entry.error || null,
        JSON.stringify(storedModels)
      ]
    )
  } catch (err) {
    console.error('[Gateway] failed to record request log:', err)
  }
}

/** 包装路由：进入时 acquire，响应结束（finish/close 任一）释放。 */
function withConcurrency(handler: (req: Request, res: Response) => Promise<void> | void) {
  return async (req: Request, res: Response): Promise<void> => {
    await acquire()
    let released = false
    const releaseOnce = () => {
      if (released) return
      released = true
      release()
    }
    res.on('finish', releaseOnce)
    res.on('close', releaseOnce)
    try {
      await handler(req, res)
    } catch (err) {
      releaseOnce()
      throw err
    }
  }
}

/** 可参与直连路由的 provider（enabled 且有 API key）。 */
function usableProviders(): Provider[] {
  return getAllProviders().filter((p) => p.enabled && p.apiKey)
}

/** Find first enabled provider for direct passthrough. */
function firstUsableProvider(): { baseUrl: string; apiKey: string; models: Provider['models'] } | null {
  const p = usableProviders()[0]
  if (!p) return null
  return { baseUrl: p.baseUrl, apiKey: p.apiKey, models: p.models }
}

/**
 * 按请求的 model 名选择 provider（直连模式智能路由）。
 * 返回 null 表示无精确匹配，调用方回落 firstUsableProvider。
 */
function findProviderForModel(model: string): { baseUrl: string; apiKey: string; models: Provider['models'] } | null {
  if (!model) return null
  const p = usableProviders().find((prov) => prov.models.some((m) => m.id === model))
  if (!p) return null
  return { baseUrl: p.baseUrl, apiKey: p.apiKey, models: p.models }
}

/** 直连路由选路：优先按 model 精确匹配，回落第一个可用 provider。 */
function routeForRequest(model: string | undefined): { baseUrl: string; apiKey: string; models: Provider['models'] } | null {
  return (model && findProviderForModel(model)) || firstUsableProvider()
}

/**
 * 造「旁路 tap」流：返回 stream 与其 controller（ReadableStream 构造时 start 同步执行，返回时 controller 必已就绪）。
 * direct 透传时把读到的 chunk 镜像进该流，交给 readSseStream 增量解析——不改变原透传字节。
 */
function createTapStream(): { stream: ReadableStream<Uint8Array>; controller: ReadableStreamDefaultController<Uint8Array> } {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c }
  })
  return { stream, controller }
}

// ── MoA 轮次共享执行核心（/v1/chat/completions 与 /v1/messages 共用） ──
// 两协议只在「对外帧格式」上不同：核心负责 roundStart 广播、子模型/聚合节流广播、引擎执行与发射器清理；
// 对外写帧经 MoaClientSink 由协议各自实现（OpenAI chunk / Anthropic SSE），chat/completions 行为零变更。

/** 协议侧客户端写入器：MoA 执行核心只回调聚合增量，帧格式与收尾策略由各协议实现 */
interface MoaClientSink {
  /** 客户端请求为流式（false 时增量不写帧，收尾以完整 JSON 返回） */
  readonly streaming: boolean
  /** 聚合增量（text=累计全文；done=true 为终态）——协议各自做 diff / fallback 重置 / 已开流收流语义 */
  onAggChunk(text: string, done: boolean): void
  /** 是否已向客户端写过内容（失败收尾判定：未写过 → 错误 JSON） */
  hasContent(): boolean
  /** 收流结束（正常完成 / 失败但已开流共用）；info 供 Anthropic 写 tool_use 块与 usage（OpenAI 忽略） */
  finish(info: { toolCalls?: ToolCallResult[]; finishReason?: string | null; usage?: { prompt: number; completion: number } }): void
}

/**
 * SSE 输出器：首次写入前补齐 SSE 三头（延迟设置——失败未开流路径的 res.json 需保持 application/json，
 * 见 T4.1 评审修订）；写入失败静默（客户端断开由 abort 链路中止引擎）。
 */
function createSseWriter(res: Response): (text: string) => void {
  let headersSet = false
  return (text: string): void => {
    if (!headersSet) {
      if (res.headersSent) return // 头已发出（防御）：与旧实现一致不再写
      headersSet = true
      try {
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
      } catch { /* 头已发出（防御）：不阻塞写帧 */ }
    }
    try {
      res.write(text)
    } catch { /* 客户端已断开：abort 链路负责中止引擎 */ }
  }
}

/**
 * OpenAI 风格对外写入器（/v1/chat/completions MoA 分支，逻辑与 T4 实现逐行一致）：
 * 聚合增量 text.slice(lastSentLen) 逐帧写 SSE（不节流）；已开流后 fallback 重置 → 立即收流结束。
 */
function createOpenAISink(res: Response, stream: boolean, controller: AbortController): MoaClientSink {
  const writeSse = createSseWriter(res)
  const chunkFrame = (delta: Record<string, unknown>, finishReason: string | null): unknown => ({
    id: `chatcmpl-moa-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'moa-aggregated',
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  })
  let lastSentLen = 0
  let clientGotContent = false
  let clientStreamClosed = false

  /** 对外收流结束（finish_reason:'stop' + [DONE]）：正常完成 / 聚合失败已开流 / fallback 已开流三情形共用 */
  const finishClientStream = (): void => {
    if (!stream || clientStreamClosed) return
    clientStreamClosed = true
    if (controller.signal.aborted || res.writableEnded) return
    writeSse(`data: ${JSON.stringify(chunkFrame({}, 'stop'))}\n\n`)
    try { res.write('data: [DONE]\n\n') } catch { /* 客户端已断开 */ }
    try { res.end() } catch { /* 客户端已断开 */ }
  }

  return {
    streaming: stream,
    hasContent: () => clientGotContent,
    onAggChunk(text: string, done: boolean): void {
      if (!stream || clientStreamClosed || controller.signal.aborted) return
      if (!done && text === '') {
        // fallback 聚合重置（引擎在 primary 失败后发出）：已写过增量 → 对外收流结束（已流出的内容
        // 不可撤回），UI 继续 fallback 直播；未写过 → lastSentLen 归零，fallback 内容无缝接续
        if (clientGotContent) finishClientStream()
        else lastSentLen = 0
        return
      }
      const delta = text.slice(lastSentLen)
      if (delta === '') return
      lastSentLen = text.length
      clientGotContent = true
      writeSse(`data: ${JSON.stringify(chunkFrame({ content: delta }, null))}\n\n`)
    },
    finish: () => finishClientStream()
  }
}

/**
 * Anthropic 风格对外写入器（/v1/messages MoA 分支）：
 * 文本增量真流式写 content_block_delta；tool_use 块 / stop_reason / usage 在收尾（结果就绪后）一次性给出
 * ——聚合模型 tool_calls 与 usage 只有引擎返回 MoaResponse 时才知道，故收尾由路由调用 finish()。
 * fallback 重置：已写过文本 → 停止转发（不可撤回），未写过 → 归零重新累计。
 */
function createAnthropicSink(res: Response, stream: boolean, controller: AbortController): MoaClientSink & { writeError(status: number, message: string): void } {
  const writeSse = createSseWriter(res)
  const state = createAnthropicStreamState()
  let started = false // 已写过任何事件（message_start 已发出）
  let sentLen = 0 // 已发送文本累计长度（diff 基准）
  let forwarding = true // fallback 重置且已写过内容 → 停止转发后续文本
  let closed = false // 收尾/错误已写（终态事件或错误 JSON）

  const writeEvents = (events: ReturnType<ReturnType<typeof createAnthropicStreamState>['start']>): void => {
    for (const event of events) writeSse(formatAnthropicSse(event))
  }
  const startIfNeeded = (): void => {
    if (started) return
    started = true
    writeEvents(state.start())
  }

  return {
    streaming: stream,
    hasContent: () => started,
    onAggChunk(text: string, done: boolean): void {
      if (!stream || closed || controller.signal.aborted) return
      if (!done && text === '') {
        if (started) forwarding = false
        else sentLen = 0
        return
      }
      if (!forwarding) return
      const delta = text.slice(sentLen)
      if (delta === '') return
      startIfNeeded()
      sentLen = text.length
      writeEvents(state.textDelta(delta))
    },
    finish(info): void {
      if (!stream || closed) return
      closed = true
      if (controller.signal.aborted || res.writableEnded) return
      startIfNeeded()
      writeEvents(state.end({ toolCalls: info.toolCalls, stopReason: info.finishReason, usage: info.usage }))
      try { res.end() } catch { /* 客户端已断开 */ }
    },
    writeError(status: number, message: string): void {
      closed = true
      if (res.headersSent) return
      try {
        res.status(status).json({ type: 'error', error: { type: 'api_error', message } })
      } catch { /* 响应已结束 */ }
    }
  }
}

/**
 * MoA 轮次执行核心（两协议共用）：roundStart 广播 → 引擎事件桥（子模型/聚合节流广播 + 协议写帧）→ 发射器清理。
 * - 子模型：节流广播 GATEWAY_SUB_UPDATE（终态 flush + dispose）
 * - 聚合：节流广播 GATEWAY_AGG_CHUNK + sink.onAggChunk（对外真流式由协议实现）
 * - 引擎内部异常映射为失败结果（不向外抛）；abort / 记账 / 对外收尾由调用方按协议处理
 */
async function executeMoaRound(opts: {
  config: MoaRuntimeConfig
  messages: ChatMessage[]
  extraBody?: Record<string, unknown>
  roundId: string
  controller: AbortController
  sink: MoaClientSink
}): Promise<MoaResponse> {
  const { config, roundId, controller, sink } = opts

  // roundStart 广播：子模型清单经与引擎相同的 resolveSubModels 得到（index 与 subUpdate 对齐）。
  // UI 收到即切监控视图；清单只含模型身份，不含密钥。
  const roundSubs = resolveSubModels(config.subModels).map((sm, index) => ({
    index,
    modelId: sm.modelId,
    role: sm.role
  }))
  broadcastToUi(GATEWAY_ROUND_START, {
    roundId,
    mode: config.mode,
    subModels: roundSubs,
    aggregator: config.aggregator ? { modelId: config.aggregator.primaryModelId } : undefined
  } satisfies GatewayRoundStartPayload)

  // 每个子模型 index 一个节流发射器 + 聚合一个（与 app 内路径同机制；终态 flush+dispose，见 streamThrottle）
  const subEmitters = new Map<number, ThrottledEmitter<GatewaySubUpdatePayload>>()
  const subEmitterOf = (index: number): ThrottledEmitter<GatewaySubUpdatePayload> => {
    let emitter = subEmitters.get(index)
    if (!emitter) {
      emitter = createThrottledEmitter<GatewaySubUpdatePayload>(STREAM_PUSH_INTERVAL_MS, (update) => {
        broadcastToUi(GATEWAY_SUB_UPDATE, update)
      })
      subEmitters.set(index, emitter)
    }
    return emitter
  }
  const aggEmitter = createThrottledEmitter<GatewayAggChunkPayload>(STREAM_PUSH_INTERVAL_MS, (chunk) => {
    broadcastToUi(GATEWAY_AGG_CHUNK, chunk)
  })

  const result = await executeMoAWithEvents({
    messages: opts.messages,
    subModels: config.subModels,
    aggregator: config.aggregator || undefined,
    mode: config.mode === 'aggregate' ? 'aggregate' : 'compare',
    aggregationPromptVariant: config.aggregationPromptVariant,
    customAggregationPrompt: config.customAggregationPrompt,
    architecture: config.architecture,
    // 附加请求字段（tools / tool_choice / temperature 等）逐路透传（Anthropic 端点用；缺省 undefined 不变更行为）
    extraBody: opts.extraBody,
    // 客户端断开 → abort 链路：信号透传引擎（中止后不再发起聚合、进行中调用随之中断）
    signal: controller.signal,
    emitSubOutput: (output, index) => {
      const update: GatewaySubUpdatePayload = {
        roundId,
        index,
        modelId: output.modelId,
        providerId: output.providerId,
        content: output.content,
        status: output.status
      }
      if (output.error !== undefined) update.error = output.error
      if (output.durationMs !== undefined) update.durationMs = output.durationMs
      if (output.tokenUsage !== undefined) update.tokenUsage = output.tokenUsage
      if (output.role !== undefined) update.role = output.role
      const emitter = subEmitterOf(index)
      if (output.status === 'running') {
        emitter.push(update)
      } else {
        // 终态：立即发终值（丢弃 pending）+ dispose，此后不得再补发旧文本
        emitter.flush(update)
        emitter.dispose()
      }
    },
    emitAggregationStart: () => {
      broadcastToUi(GATEWAY_AGG_START, { roundId } satisfies GatewayAggStartPayload)
    },
    emitAggregationChunk: (text, done) => {
      // ① UI 节流广播（text=累计全文；done=true 终态 flush+dispose）
      const chunk: GatewayAggChunkPayload = { roundId, text, done }
      if (!done) {
        aggEmitter.push(chunk)
      } else {
        aggEmitter.flush(chunk)
        aggEmitter.dispose()
      }
      // ② 对外写帧（协议各自实现：OpenAI 真增量 diff / Anthropic content_block_delta）
      sink.onAggChunk(text, done)
    }
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      type: 'aggregate' as const,
      content: '',
      subOutputs: [],
      success: false,
      error: `MoA 引擎内部错误: ${msg}`
    }
  })

  // 一轮结束：清空全部节流发射器（防泄漏；已 dispose 的重复调用为无操作）
  for (const emitter of subEmitters.values()) emitter.dispose()
  aggEmitter.dispose()

  return result
}

/**
 * /v1/messages direct 模式：单模型透传（上游按 OpenAI 兼容协议调用，响应/事件转换为 Anthropic 形态）。
 * - 非流式：上游 JSON → Anthropic message JSON
 * - 流式：上游 SSE 文本增量真流转发为 Anthropic content_block_delta；tool_use 块 / stop_reason / usage 收尾一次性给出
 * - 直播广播与 chat/completions direct 分支同语义（单模型清单 index 0）；客户端断开 → cancel 上游读取流
 */
async function handleAnthropicDirect(opts: {
  res: Response
  provider: { baseUrl: string; apiKey: string; models: Provider['models'] }
  converted: ReturnType<typeof anthropicToOpenAI>
  model?: string
  stream: boolean
}): Promise<void> {
  const { res, provider, converted, stream } = opts
  const reqStart = Date.now()
  const roundId = crypto.randomUUID()
  // 请求名不在该 provider 模型列表时回落到其第一个模型；否则透传原名（与 chat/completions direct 一致）
  let upstreamModel = opts.model || ''
  if (!provider.models.some((m) => m.id === upstreamModel)) {
    upstreamModel = provider.models[0]?.id || upstreamModel
  }

  // 直通轮次同样直播：单模型清单；终态 subUpdate + roundDone 由 finishDirectRound 统一广播（directDone 防重复）
  let directAcc = ''
  let directUsage: { prompt: number; completion: number } | undefined
  const dirEmitter = createThrottledEmitter<GatewaySubUpdatePayload>(STREAM_PUSH_INTERVAL_MS, (update) => {
    broadcastToUi(GATEWAY_SUB_UPDATE, update)
  })
  let directDone = false
  const finishDirectRound = (status: 'success' | 'error', error?: string): void => {
    if (directDone) return
    directDone = true
    const update: GatewaySubUpdatePayload = {
      roundId,
      index: 0,
      modelId: upstreamModel,
      providerId: provider.baseUrl,
      content: directAcc,
      status,
      durationMs: Date.now() - reqStart
    }
    if (error !== undefined) update.error = error
    if (directUsage !== undefined) update.tokenUsage = directUsage
    dirEmitter.flush(update)
    dirEmitter.dispose()
    broadcastToUi(GATEWAY_ROUND_DONE, {
      roundId,
      success: status === 'success',
      error: status === 'success' ? undefined : (error || '直通请求失败'),
      durationMs: Date.now() - reqStart
    })
  }
  broadcastToUi(GATEWAY_ROUND_START, {
    roundId,
    mode: 'direct',
    subModels: [{ index: 0, modelId: upstreamModel, role: '' }]
  } satisfies GatewayRoundStartPayload)

  // 对外 Anthropic SSE：文本增量真流转发；tool_use 块与 usage 在收尾一次性给出
  const writeSse = createSseWriter(res)
  const state = createAnthropicStreamState()
  let started = false
  let finished = false
  const writeEvents = (events: ReturnType<ReturnType<typeof createAnthropicStreamState>['start']>): void => {
    for (const event of events) writeSse(formatAnthropicSse(event))
  }
  const startIfNeeded = (): void => {
    if (started) return
    started = true
    writeEvents(state.start())
  }
  const closeStream = (info: { toolCalls?: ToolCallResult[]; stopReason?: string | null }): void => {
    if (finished) return
    finished = true
    startIfNeeded()
    writeEvents(state.end({ toolCalls: info.toolCalls, stopReason: info.stopReason, usage: directUsage }))
    try { res.end() } catch { /* 客户端已断开 */ }
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`
    // 上游请求统一走 fetchProxy；body = 转换后的 OpenAI 请求（tools 等经 extraBody 带出）
    const upstream = await fetchProxy(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...converted.extraBody, model: upstreamModel, messages: converted.messages, stream }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    })

    if (!upstream.ok) {
      const errBody = await upstream.text()
      logGatewayRequest({
        moaMode: 'direct',
        success: false,
        prompt: 0,
        completion: 0,
        durationMs: Date.now() - reqStart,
        subCount: 0,
        models: upstreamModel ? [{ modelId: upstreamModel, role: 'sub', prompt: 0, completion: 0 }] : [],
        error: `Upstream ${upstream.status}: ${errBody.slice(0, 300)}`
      })
      if (!res.headersSent) {
        res.status(502).json({
          type: 'error',
          error: { type: 'api_error', message: `Upstream ${upstream.status}: ${errBody.slice(0, 500)}` }
        })
      }
      finishDirectRound('error', `Upstream ${upstream.status}: ${errBody.slice(0, 300)}`)
      return
    }

    if (!stream) {
      const data = await upstream.json()
      const usage = data.usage || {}
      logGatewayRequest({
        moaMode: 'direct',
        success: true,
        prompt: usage.prompt_tokens || 0,
        completion: usage.completion_tokens || 0,
        durationMs: Date.now() - reqStart,
        subCount: 1,
        models: upstreamModel ? [{
          modelId: upstreamModel,
          role: 'sub' as const,
          prompt: usage.prompt_tokens || 0,
          completion: usage.completion_tokens || 0
        }] : []
      })
      const message = data.choices?.[0]?.message
      directAcc = typeof message?.content === 'string' ? message.content : ''
      if (typeof usage.prompt_tokens === 'number' || typeof usage.completion_tokens === 'number') {
        directUsage = { prompt: usage.prompt_tokens || 0, completion: usage.completion_tokens || 0 }
      }
      res.json(openAIToAnthropic({
        content: directAcc,
        toolCalls: toolCallsFromMessage(message),
        finishReason: data.choices?.[0]?.finish_reason,
        usage: directUsage
      }))
      finishDirectRound('success')
      return
    }

    // ── 流式：上游 SSE → Anthropic 事件真流转发（客户端断开 → cancel 上游读取流） ──
    const toolAcc = new Map<number, ToolCallResult>()
    let finishReason: string | null = null
    let clientClosed = false
    const upstreamBody = upstream.body
    if (upstreamBody) {
      const upstreamReader = upstreamBody.getReader()
      res.on('close', () => {
        clientClosed = true
        try { void upstreamReader.cancel().catch(() => {}) } catch { /* ignore */ }
      })
      const passthrough = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await upstreamReader.read()
            if (done) { controller.close(); return }
            controller.enqueue(value)
          } catch (err) {
            controller.error(err) // 网络中断/中止原样传给 readSseStream（已收内容保留）
          }
        },
        cancel() { return upstreamReader.cancel() }
      })
      await readSseStream(passthrough, (data) => {
        const chunk = parseOpenAIChunk(data)
        if (!chunk) return
        if (typeof chunk.content === 'string' && chunk.content !== '') {
          directAcc += chunk.content
          dirEmitter.push({
            roundId,
            index: 0,
            modelId: upstreamModel,
            providerId: provider.baseUrl,
            content: directAcc,
            status: 'running'
          })
          startIfNeeded()
          writeEvents(state.textDelta(chunk.content))
        }
        if (chunk.toolCallsDelta) accumulateToolCalls(toolAcc, chunk.toolCallsDelta)
        if (chunk.finishReason) finishReason = chunk.finishReason
        if (chunk.usage) directUsage = chunk.usage
      })
    }
    const closedEarly = clientClosed
    if (!closedEarly) closeStream({ toolCalls: toolCallsOrUndefined(toolAcc), stopReason: finishReason })
    logGatewayRequest({
      moaMode: 'direct',
      success: !closedEarly,
      prompt: 0,
      completion: 0,
      durationMs: Date.now() - reqStart,
      subCount: 1,
      models: upstreamModel ? [{ modelId: upstreamModel, role: 'sub', prompt: 0, completion: 0 }] : [],
      error: closedEarly ? '客户端提前断开' : null
    })
    if (closedEarly) finishDirectRound('error', '客户端提前断开')
    else finishDirectRound('success')
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!res.headersSent) {
      logGatewayRequest({
        moaMode: 'direct',
        success: false,
        prompt: 0,
        completion: 0,
        durationMs: Date.now() - reqStart,
        subCount: 0,
        error: msg
      })
      res.status(502).json({ type: 'error', error: { type: 'api_error', message: `Gateway: ${msg}` } })
    } else if (stream && !finished && !res.writableEnded) {
      // SSE 已开写：补收尾（不能再发 JSON 错误体），失败标注走 UI 广播与记账
      closeStream({ stopReason: null })
    }
    finishDirectRound('error', msg)
  }
}

export function createGatewayServer(): Express {
  const app: Express = express()

  // ── CORS：仅放行本地回环浏览器来源 ──
  // 此前 cors() 对任意来源全开，恶意网页可借助用户已配置的 Key 调用本地网关消耗上游费用。
  // 原生客户端（curl / Cline / Copilot 等）请求无 Origin 头，不受影响。
  const corsOptions: CorsOptions = {
    origin: (origin, callback) => {
      if (!origin) { callback(null, true); return }
      try {
        const h = new URL(origin).hostname
        if (h === 'localhost' || h === '127.0.0.1' || h === '::1') {
          callback(null, true)
          return
        }
      } catch { /* 非法 origin，拒绝 */ }
      callback(null, false)
    }
  }
  app.use(cors(corsOptions))

  // 鉴权：/health 无需鉴权，/v1/* 全部要求（启用时）
  app.use('/v1', gatewayAuthMiddleware)

  app.use(express.json({ limit: '10mb' }))

  // ── Health ──
  app.get('/health', (_req: Request, res: Response) => {
    const provider = firstUsableProvider()
    const config = getMoaConfig()
    res.json({
      status: 'ok',
      version: '1.0.0',
      uptimeSeconds: Math.floor(process.uptime()),
      activeRequests,
      queueLength,
      moaConfig: { subCount: config.subModels.length, mode: config.mode },
      // model 字段透出实际可用的首个模型名（旧实现误填 config.mode，与字段语义不符）
      providers: [{ name: 'default', status: provider ? 'ok' : 'no_key', model: provider?.models[0]?.id ?? '' }]
    })
  })

  // ── Models list（聚合所有可用 provider 的 DB 缓存模型，不发网络请求）──
  // 此前仅透传「第一个 enabled provider」：云端+本地共存时本地模型不可见，
  // 第三方客户端选不到本地模型。现聚合全部；未 fetch 过模型列表的云端 provider 自然缺席（与原行为一致）。
  app.get('/v1/models', (_req: Request, res: Response) => {
    const providers = usableProviders()
    const data = providers.flatMap((p) =>
      p.models.map((m) => ({ id: m.id, object: 'model', created: 0, owned_by: p.name }))
    )
    res.json({ object: 'list', data })
  })

  // ── Chat completions ──
  app.post('/v1/chat/completions', withConcurrency(async (req: Request, res: Response) => {
    const config = getMoaConfig()
    // 模型决策（与聊天侧直连约定一致）：请求模型命中 provider → 用之；否则回落 MoA 菜单配置的
    // 首个子模型（命中时）；仍不命中则由 routeForRequest 回落第一个可用 provider 的首个模型
    const bodyModel: string | undefined = req.body?.model
    const moaModel = config.subModels[0]?.modelId
    const requestedModel =
      bodyModel && findProviderForModel(bodyModel) ? bodyModel
        : moaModel && findProviderForModel(moaModel) ? moaModel
          : bodyModel
    // 智能路由：请求的 model 命中某 provider（含本地引擎）则路由之，否则回落第一个可用
    const provider = routeForRequest(requestedModel)
    if (!provider) {
      res.status(503).json({
        error: { message: 'No enabled provider configured.', type: 'moa_config_error' }
      })
      return
    }

    const { messages, stream } = req.body

    // ── Direct mode ──
    if (config.mode === 'direct' || config.subModels.length === 0) {
      const reqStart = Date.now()
      const roundId = crypto.randomUUID()
      // 请求名不在该 provider 模型列表时回落到其第一个模型；否则透传原名
      let upstreamModel = requestedModel || ''
      if (!provider.models.some((m) => m.id === upstreamModel)) {
        upstreamModel = provider.models[0]?.id || upstreamModel
      }

      // 直通轮次同样直播（T4）：单模型清单；终态 subUpdate + roundDone 由 finishDirectRound 统一广播
      // （含异常路径；directDone 防重复）。旁路解析只观察字节，不改透传内容。
      let directAcc = ''
      let directUsage: { prompt: number; completion: number } | undefined
      const dirEmitter = createThrottledEmitter<GatewaySubUpdatePayload>(STREAM_PUSH_INTERVAL_MS, (update) => {
        broadcastToUi(GATEWAY_SUB_UPDATE, update)
      })
      let directDone = false
      const finishDirectRound = (status: 'success' | 'error', error?: string): void => {
        if (directDone) return
        directDone = true
        const update: GatewaySubUpdatePayload = {
          roundId,
          index: 0,
          modelId: upstreamModel,
          providerId: provider.baseUrl,
          content: directAcc,
          status,
          durationMs: Date.now() - reqStart
        }
        if (error !== undefined) update.error = error
        if (directUsage !== undefined) update.tokenUsage = directUsage
        dirEmitter.flush(update)
        dirEmitter.dispose()
        broadcastToUi(GATEWAY_ROUND_DONE, {
          roundId,
          success: status === 'success',
          error: status === 'success' ? undefined : (error || '直通请求失败'),
          durationMs: Date.now() - reqStart
        })
      }
      broadcastToUi(GATEWAY_ROUND_START, {
        roundId,
        mode: 'direct',
        subModels: [{ index: 0, modelId: upstreamModel, role: '' }]
      } satisfies GatewayRoundStartPayload)

      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`
        // 上游请求统一走 fetchProxy（本地回环地址自动直连，云端 provider 可走网络代理）
        // 自带超时信号：fetchProxy 不再套用全局 timeoutMs，避免误伤非流式慢速上游
        const upstream = await fetchProxy(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...req.body, model: upstreamModel }),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
        })

        if (!upstream.ok) {
          const errBody = await upstream.text()
          logGatewayRequest({
            moaMode: 'direct',
            success: false,
            prompt: 0,
            completion: 0,
            durationMs: Date.now() - reqStart,
            subCount: 0,
            models: upstreamModel ? [{ modelId: upstreamModel, role: 'sub', prompt: 0, completion: 0 }] : [],
            error: `Upstream ${upstream.status}: ${errBody.slice(0, 300)}`
          })
          res.status(502).json({
            error: { message: `Upstream ${upstream.status}: ${errBody.slice(0, 500)}`, type: 'upstream_error' }
          })
          finishDirectRound('error', `Upstream ${upstream.status}: ${errBody.slice(0, 300)}`)
          return
        }

        if (stream) {
          res.setHeader('Content-Type', 'text/event-stream')
          res.setHeader('Cache-Control', 'no-cache')
          res.setHeader('Connection', 'keep-alive')
          const reader = upstream.body?.getReader()
          if (!reader) {
            res.status(502).json({ error: { message: 'No body', type: 'upstream_error' } })
            finishDirectRound('error', 'No body')
            return
          }
          // P2-6：客户端断开时 cancel 上游读取流，释放上游长连接（否则 SSE 永不结束会一直挂着）
          let clientClosed = false
          res.on('close', () => {
            clientClosed = true
            try { void reader.cancel().catch(() => {}) } catch { /* ignore */ }
          })
          // 旁路直播解析（不改透传字节）：单一 reader 读到的每个 chunk 镜像进 tap 流，
          // readSseStream 增量切事件 → parseOpenAIChunk 提 content 累计 + usage；解析异常静默，不影响透传。
          const tap = createTapStream()
          const tapDone = readSseStream(tap.stream, (data) => {
            const chunk = parseOpenAIChunk(data)
            if (!chunk) return
            if (typeof chunk.content === 'string' && chunk.content !== '') {
              directAcc += chunk.content
              dirEmitter.push({
                roundId,
                index: 0,
                modelId: upstreamModel,
                providerId: provider.baseUrl,
                content: directAcc,
                status: 'running'
              })
            }
            if (chunk.usage) directUsage = chunk.usage
          }).catch(() => { /* 旁路解析异常不影响透传与记账 */ })
          const decoder = new TextDecoder()
          let buffer = ''
          let sawDone = false
          while (true) {
            if (clientClosed) break
            const { done, value } = await reader.read()
            if (done) break
            // 镜像给旁路解析（不 await，不阻塞透传）
            if (value && value.length > 0) {
              try { tap.controller.enqueue(value) } catch { /* tap 已关闭 */ }
            }
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''
            for (const line of lines) {
              // read 返回后到 write 前客户端可能已断开,再 write 到销毁的响应会触发 error
              if (clientClosed) break
              if (line.trim() === 'data: [DONE]') sawDone = true
              // 逐行透传（保留 event:/id: 等非 data 行；data 行的帧分隔由原有换行保留）
              res.write(line + '\n')
            }
          }
          // 上游读完：关闭 tap 并等旁路解析收尾（残余 buffer 按最后一帧处理）
          try { tap.controller.close() } catch { /* 已关闭 */ }
          await tapDone
          // 快照断开标志：res.end() 之后 close 事件仍会触发（正常完成），不得误判为提前断开
          const closedEarly = clientClosed
          if (!closedEarly) {
            if (buffer) {
              // 收尾残片（上游无尾换行时留在 buffer）里也可能带 [DONE]
              if (buffer.trim() === 'data: [DONE]') sawDone = true
              res.write(buffer + '\n\n')
            }
            // 上游已发过 [DONE] 则不再补写，避免重复结束帧
            if (!sawDone) res.write('data: [DONE]\n\n')
            res.end()
          }
          // 流式不做 token 级记账解析（口径不变）；旁路解析结果只用于 UI 直播
          logGatewayRequest({
            moaMode: 'direct',
            success: !closedEarly,
            prompt: 0,
            completion: 0,
            durationMs: Date.now() - reqStart,
            subCount: 1,
            models: upstreamModel ? [{ modelId: upstreamModel, role: 'sub', prompt: 0, completion: 0 }] : [],
            error: closedEarly ? '客户端提前断开' : null
          })
          if (closedEarly) finishDirectRound('error', '客户端提前断开')
          else finishDirectRound('success')
        } else {
          const data = await upstream.json()
          const usage = data.usage || {}
          logGatewayRequest({
            moaMode: 'direct',
            success: true,
            prompt: usage.prompt_tokens || 0,
            completion: usage.completion_tokens || 0,
            durationMs: Date.now() - reqStart,
            subCount: 1,
            models: upstreamModel ? [{
              modelId: upstreamModel,
              role: 'sub' as const,
              prompt: usage.prompt_tokens || 0,
              completion: usage.completion_tokens || 0
            }] : []
          })
          res.json(data)
          // 非流式 direct：完成时一次性终态（content/usage 来自直回 JSON）
          directAcc = typeof data.choices?.[0]?.message?.content === 'string' ? data.choices[0].message.content : ''
          if (typeof usage.prompt_tokens === 'number' || typeof usage.completion_tokens === 'number') {
            directUsage = { prompt: usage.prompt_tokens || 0, completion: usage.completion_tokens || 0 }
          }
          finishDirectRound('success')
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        // SSE 流中被取消/断连：仍记一条失败日志（不计 token）
        if (!(stream && res.headersSent)) {
          logGatewayRequest({
            moaMode: 'direct',
            success: false,
            prompt: 0,
            completion: 0,
            durationMs: Date.now() - reqStart,
            subCount: 0,
            error: msg
          })
        }
        // SSE 已开写后不能再发 JSON 错误体（headers 已发送，Express 会二次抛错挂死响应）——直接收流
        if (stream && res.headersSent) { res.end(); finishDirectRound('error', msg); return }
        res.status(502).json({ error: { message: `Gateway: ${msg}`, type: 'gateway_error' } })
        finishDirectRound('error', msg)
      }
      return
    }

    // ── MoA mode (aggregate / compare) ──
    // X1 修复：executeMoA 主体无整体异常防护，Express 4 又不捕获 async handler 的
    // rejection——任何内部抛错（DB 故障等）都会变成 unhandled rejection 崩溃主进程
    const reqStart = Date.now()
    const roundId = crypto.randomUUID()

    // 客户端断开 → 立即中止引擎（T4）：close 且响应未正常结束（!res.writableEnded）→ controller.abort()。
    // abort 经 MoaRequest.signal 透传——不再发起聚合、进行中调用随即中断（省后续费用）；
    // 正常完成（res.end/res.json）后的 close 不触发（writableEnded 已置位）。
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })

    // 对外写入器（真流式：聚合增量 diff 逐帧写 SSE；finish/[DONE] 收尾）——协议适配层，行为与 T4 一致
    const sink = createOpenAISink(res, Boolean(stream), controller)

    // 执行核心（roundStart 广播 / 子模型与聚合节流广播 / 引擎调用 / 发射器清理）与 /v1/messages 共用
    const result = await executeMoaRound({
      config,
      messages: messages || [],
      roundId,
      controller,
      sink
    })

    // 用量明细（成功子模型 + 聚合器）统一计账
    const moaInputs = usageInputsFromMoa(result)
    const moaEntries = moaInputs.map((m) => ({ ...m, cost: 0 }))
    const moaTotals = sumUsage(buildUsageEntries(moaEntries))

    // 中止判定：客户端断开（close 且未正常结束）→ abort 已发生；success 恒 false（§4.4.4/§4.7）
    const aborted = controller.signal.aborted
    const ok = result.success && !aborted

    // 记账：成功/失败/中止均落一条；中止按已发生用量记，error_detail 标注「客户端断开中止」
    logGatewayRequest({
      moaMode: config.mode,
      success: ok,
      prompt: moaTotals.prompt,
      completion: moaTotals.completion,
      durationMs: Date.now() - reqStart,
      subCount: result.subOutputs.length,
      models: moaInputs,
      error: ok ? null : aborted ? '客户端断开中止' : (result.error || 'MoA execution failed')
    })

    // ── 对外响应收尾 ──
    if (aborted) {
      // 客户端已断开：不再写任何帧（abort 链路已中止引擎；直播停在中断处，UI 靠 aborted 事件标注）
    } else if (!ok && !sink.hasContent()) {
      // 失败且未写过增量（含未开流的流式/非流式客户端）：维持现状 502 JSON
      res.status(502).json({
        error: { message: result.error || 'MoA execution failed', type: 'moa_error' }
      })
    } else if (config.mode === 'compare') {
      // compare 对外 JSON 保持现状（子模型流只直播给 UI）
      res.json({
        id: `chatcmpl-moa-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'moa-compare',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: result.subOutputs.map((o, i) =>
              `=== ${o.modelId} (${o.status}) ===\n${o.content || o.error || ''}`
            ).join('\n\n')
          },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      })
    } else if (stream) {
      // 聚合成功 / 失败但已开流：收流结束（finish_reason:'stop' + [DONE]）
      sink.finish({})
    } else {
      res.json({
        id: `chatcmpl-moa-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'moa-aggregated',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: result.content },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        // 透明模式 extended：附子模型执行明细（x_moa_sub_models）；default 仅标准字段
        ...(readAppSettings().gateway.transparency === 'extended'
          ? { x_moa_sub_models: result.subOutputs.map((o) => ({ modelId: o.modelId, status: o.status, durationMs: o.durationMs })) }
          : {})
      })
    }

    // roundDone 广播：aborted:true = 客户端断开中止（success 恒 false；error 保留引擎文案，如「已中止」）
    broadcastToUi(GATEWAY_ROUND_DONE, {
      roundId,
      success: ok,
      error: ok ? undefined : (result.error || (aborted ? '客户端断开中止' : 'MoA 执行失败')),
      aborted,
      durationMs: Date.now() - reqStart
    } satisfies GatewayRoundDonePayload)
  }))

  // ── Anthropic Messages API（Claude Code 直连）──
  // 原则：Anthropic 格式只在网关边界转换，内部统一走 OpenAI 兼容管线（引擎 / 上游 providers / 事件桥全部复用）。
  // 忽略不报错：anthropic-version / anthropic-beta 头、thinking、cache_control、metadata。
  app.post('/v1/messages', withConcurrency(async (req: Request, res: Response) => {
    const config = getMoaConfig()
    const converted = anthropicToOpenAI(req.body)
    const stream = req.body?.stream === true
    const provider = routeForRequest(req.body?.model)
    if (!provider) {
      res.status(503).json({ type: 'error', error: { type: 'api_error', message: 'No enabled provider configured.' } })
      return
    }

    // ── Direct mode：单模型透传（上游 OpenAI 兼容），响应/事件转换为 Anthropic 形态 ──
    if (config.mode === 'direct' || config.subModels.length === 0) {
      await handleAnthropicDirect({ res, provider, converted, model: req.body?.model, stream })
      return
    }

    // ── MoA mode (aggregate / compare)：与 chat/completions 共用执行核心（事件桥 / abort / 记账同链路）──
    const reqStart = Date.now()
    const roundId = crypto.randomUUID()

    // 客户端断开 → 立即中止引擎：close 且响应未正常结束（!res.writableEnded）→ controller.abort()
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })

    // 对外写入器（Anthropic SSE：文本增量真流式；tool_use 块 / stop_reason / usage 收尾一次性给出）
    const sink = createAnthropicSink(res, stream, controller)

    const result = await executeMoaRound({
      config,
      messages: converted.messages,
      extraBody: converted.extraBody,
      roundId,
      controller,
      sink
    })

    // 用量明细（成功子模型 + 聚合器）统一计账（口径与 chat/completions 相同）
    const moaInputs = usageInputsFromMoa(result)
    const moaTotals = sumUsage(buildUsageEntries(moaInputs.map((m) => ({ ...m, cost: 0 }))))
    const aborted = controller.signal.aborted
    const ok = result.success && !aborted

    logGatewayRequest({
      moaMode: config.mode,
      success: ok,
      prompt: moaTotals.prompt,
      completion: moaTotals.completion,
      durationMs: Date.now() - reqStart,
      subCount: result.subOutputs.length,
      models: moaInputs,
      error: ok ? null : aborted ? '客户端断开中止' : (result.error || 'MoA execution failed')
    })

    // 聚合模型 tool_calls → Anthropic tool_use 块；stop_reason 由转换层映射（有工具 → tool_use）
    const aggToolCalls = result.aggregatorToolCalls
    const finishReason: string = aggToolCalls && aggToolCalls.length > 0 ? 'tool_calls' : 'stop'

    // ── 对外响应收尾 ──
    if (aborted) {
      // 客户端已断开：不再写任何帧（abort 链路已中止引擎）
    } else if (!ok && !sink.hasContent()) {
      // 失败且未开流：Anthropic 错误 JSON（type:'error'，客户端按 Anthropic schema 解析）
      sink.writeError(502, result.error || 'MoA execution failed')
    } else if (config.mode === 'compare') {
      // compare 无聚合模型：最终消息 = 各子模型输出对照汇总（流式按单文本块送出）
      const summary = result.subOutputs
        .map((o) => `=== ${o.modelId} (${o.status}) ===\n${o.content || o.error || ''}`)
        .join('\n\n')
      if (stream) {
        sink.onAggChunk(summary, false)
        sink.finish({ finishReason: 'stop' })
      } else {
        res.json(openAIToAnthropic({ content: summary, finishReason: 'stop' }))
      }
    } else if (stream) {
      // 聚合成功（或失败但已开流）：收尾事件 content_block_stop + [tool_use 块] + message_delta + message_stop
      sink.finish({ toolCalls: aggToolCalls, finishReason, usage: result.aggregatorUsage })
    } else {
      res.json(openAIToAnthropic({
        content: result.content,
        toolCalls: aggToolCalls,
        finishReason,
        usage: result.aggregatorUsage
      }))
    }

    // roundDone 广播（与 chat/completions 同语义：aborted:true = 客户端断开中止）
    broadcastToUi(GATEWAY_ROUND_DONE, {
      roundId,
      success: ok,
      error: ok ? undefined : (result.error || (aborted ? '客户端断开中止' : 'MoA 执行失败')),
      aborted,
      durationMs: Date.now() - reqStart
    } satisfies GatewayRoundDonePayload)
  }))

  // ── Non-completions passthrough ──
  ;['/v1/embeddings', '/v1/images/generations', '/v1/audio/transcriptions', '/v1/audio/speech', '/v1/moderations'].forEach((endpoint) => {
    // baseUrl 已含 /v1 前缀（与 chat 路径同一约定），上游路径需去掉端点的 /v1，避免拼出 /v1/v1/*
    const upstreamPath = endpoint.replace(/^\/v1/, '')
    app.post(endpoint, withConcurrency(async (req: Request, res: Response) => {
      const provider = firstUsableProvider()
      const reqStart = Date.now()
      if (!provider) {
        logGatewayRequest({
          moaMode: 'passthrough',
          success: false,
          prompt: 0,
          completion: 0,
          durationMs: Date.now() - reqStart,
          subCount: 0,
          error: 'No provider configured'
        })
        res.status(503).json({ error: { message: 'No provider configured', type: 'moa_config_error' } }); return
      }
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`
        const upstream = await fetchProxy(`${provider.baseUrl.replace(/\/+$/, '')}${upstreamPath}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(req.body),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
        })
        // passthrough 端点响应体格式各异，不易统一解析 usage；仅记录请求计数与状态
        logGatewayRequest({
          moaMode: 'passthrough',
          success: upstream.ok,
          prompt: 0,
          completion: 0,
          durationMs: Date.now() - reqStart,
          subCount: 0,
          error: upstream.ok ? null : `Upstream ${upstream.status}`
        })
        res.status(upstream.status).json(await upstream.json())
      } catch (err) {
        logGatewayRequest({
          moaMode: 'passthrough',
          success: false,
          prompt: 0,
          completion: 0,
          durationMs: Date.now() - reqStart,
          subCount: 0,
          error: err instanceof Error ? err.message : String(err)
        })
        res.status(502).json({ error: { message: 'Passthrough failed', type: 'gateway_error' } })
      }
    }))
  })

  return app
}

export function startGatewayServer(app: Express, port: number, host: string): Promise<number> {
  return tryListen(app, port, host, 0)

  function tryListen(expressApp: Express, p: number, h: string, attempt: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const s = expressApp.listen(p, h, () => {
        server = s
        if (p !== port) console.log(`[Gateway] Port ${port} in use, using ${p} instead`)
        console.log(`[Gateway] http://${h}:${p}`)
        resolve(p)
      })
      s.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempt < 10) {
          tryListen(expressApp, p + 1, h, attempt + 1).then(resolve, reject)
        } else {
          reject(err)
        }
      })
    })
  }
}

/** 停止网关。返回 Promise：旧 server 真正 close 完成后 resolve；无运行实例时立即 resolve。
 *  本函数不会 reject，调用方可以不 await（before-quit 等场景安全）。 */
export function stopGatewayServer(): Promise<void> {
  const s = server
  server = null
  runningConfig = null
  if (!s) return Promise.resolve()
  return new Promise((resolve) => {
    s.close(() => {
      console.log('[Gateway] stopped')
      resolve()
    })
  })
}

/** apply 串行化链：并发 apply（设置高频变更）排队执行，避免交错 stop/start 造成端口漂移或双监听 */
let applyChain: Promise<unknown> = Promise.resolve()

async function applyGatewayServerInternal(): Promise<number | null> {
  const { enabled, host, port } = readAppSettings().gateway
  if (!enabled) {
    await stopGatewayServer()
    return null
  }
  if (server && runningConfig && runningConfig.host === host && runningConfig.port === port) {
    return (server.address() as AddressInfo | null)?.port ?? port
  }
  // 等待旧 server 真正关闭后再按新配置启动（否则旧实例仍占用端口 → 新实例顺延 port+1）
  await stopGatewayServer()
  const actualPort = await startGatewayServer(createGatewayServer(), port, host)
  runningConfig = { host, port }
  return actualPort
}

/**
 * 按当前设置应用网关运行态（settings.gateway.enabled/host/port 变更即时生效）：
 * - enabled=false → 停止（未运行则无操作）；
 * - enabled=true 且 host/port 未变化 → 保持现状（幂等，不重启）；
 * - host/port 变化 → 停止后按新配置重启。
 * 返回实际监听端口（未启用时 null）。
 */
export function applyGatewayServer(): Promise<number | null> {
  const seq = applyChain.then(() => applyGatewayServerInternal())
  // 排队链上先前的失败不阻塞后续 apply；本次调用的 rejection 仍由 seq 透传给调用方
  applyChain = seq.catch(() => undefined)
  return seq
}
