import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import cors, { type CorsOptions } from 'cors'
import crypto from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { getAllProviders } from '../providers/providerManager'
import { getMoaConfig } from '../moa/moaConfig'
import { executeMoA } from '../moa/moaEngine'
import { getDatabase } from '../db/database'
import { readAppSettings } from '../config/appSettings'
import { buildUsageEntries, sumUsage } from '../moa/usage'
import type { Provider, SubModelOutput } from '../../shared/types'
import { fetchProxy } from '../local/fetchProxy'

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

/** 直连模式选路由：优先按 model 精确匹配，回落第一个可用 provider。 */
function routeForRequest(model: string | undefined): { baseUrl: string; apiKey: string; models: Provider['models'] } | null {
  return (model && findProviderForModel(model)) || firstUsableProvider()
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
      providers: [{ name: 'default', status: provider ? 'ok' : 'no_key', model: config.mode }]
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
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`
        // 请求名不在该 provider 模型列表时回落到其第一个模型；否则透传原名
        let upstreamModel = requestedModel || ''
        if (!provider.models.some((m) => m.id === upstreamModel)) {
          upstreamModel = provider.models[0]?.id || upstreamModel
        }
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
          return
        }

        if (stream) {
          res.setHeader('Content-Type', 'text/event-stream')
          res.setHeader('Cache-Control', 'no-cache')
          res.setHeader('Connection', 'keep-alive')
          const reader = upstream.body?.getReader()
          if (!reader) { res.status(502).json({ error: { message: 'No body', type: 'upstream_error' } }); return }
          // P2-6：客户端断开时 cancel 上游读取流，释放上游长连接（否则 SSE 永不结束会一直挂着）
          let clientClosed = false
          res.on('close', () => {
            clientClosed = true
            try { void reader.cancel().catch(() => {}) } catch { /* ignore */ }
          })
          const decoder = new TextDecoder()
          let buffer = ''
          let sawDone = false
          while (true) {
            if (clientClosed) break
            const { done, value } = await reader.read()
            if (done) break
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
          if (!clientClosed) {
            if (buffer) {
              // 收尾残片（上游无尾换行时留在 buffer）里也可能带 [DONE]
              if (buffer.trim() === 'data: [DONE]') sawDone = true
              res.write(buffer + '\n\n')
            }
            // 上游已发过 [DONE] 则不再补写，避免重复结束帧
            if (!sawDone) res.write('data: [DONE]\n\n')
            res.end()
          }
          // 流式不做 token 级解析，仅记录请求计数与成功状态
          logGatewayRequest({
            moaMode: 'direct',
            success: !clientClosed,
            prompt: 0,
            completion: 0,
            durationMs: Date.now() - reqStart,
            subCount: 1,
            models: upstreamModel ? [{ modelId: upstreamModel, role: 'sub', prompt: 0, completion: 0 }] : [],
            error: clientClosed ? '客户端提前断开' : null
          })
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
        if (stream && res.headersSent) { res.end(); return }
        res.status(502).json({ error: { message: `Gateway: ${msg}`, type: 'gateway_error' } })
      }
      return
    }

    // ── MoA mode (aggregate / compare) ──
    // X1 修复：executeMoA 主体无整体异常防护，Express 4 又不捕获 async handler 的
    // rejection——任何内部抛错（DB 故障等）都会变成 unhandled rejection 崩溃主进程
    const reqStart = Date.now()
    const result = await executeMoA({
      messages: messages || [],
      subModels: config.subModels,
      aggregator: config.aggregator || undefined,
      mode: config.mode === 'aggregate' ? 'aggregate' : 'compare',
      aggregationPromptVariant: config.aggregationPromptVariant,
      architecture: config.architecture
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

    // 用量明细（成功子模型 + 聚合器）统一计账
    const moaInputs = usageInputsFromMoa(result)
    const moaEntries = moaInputs.map((m) => ({ ...m, cost: 0 }))
    const moaTotals = sumUsage(buildUsageEntries(moaEntries))

    if (!result.success) {
      logGatewayRequest({
        moaMode: config.mode,
        success: false,
        prompt: moaTotals.prompt,
        completion: moaTotals.completion,
        durationMs: Date.now() - reqStart,
        subCount: result.subOutputs.length,
        models: moaInputs,
        error: result.error || 'MoA execution failed'
      })
      res.status(502).json({
        error: { message: result.error || 'MoA execution failed', type: 'moa_error' }
      })
      return
    }

    if (config.mode === 'compare') {
      logGatewayRequest({
        moaMode: 'compare',
        success: true,
        prompt: moaTotals.prompt,
        completion: moaTotals.completion,
        durationMs: Date.now() - reqStart,
        subCount: result.subOutputs.length,
        models: moaInputs
      })
      // Return sub-model outputs as a structured JSON for external tools
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
      return
    }

    // ── Aggregate mode ──
    logGatewayRequest({
      moaMode: 'aggregate',
      success: true,
      prompt: moaTotals.prompt,
      completion: moaTotals.completion,
      durationMs: Date.now() - reqStart,
      subCount: result.subOutputs.length,
      models: moaInputs
    })
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      const content = result.content
      // Simulate token-by-token streaming from the aggregated content
      const tokens = content.split(/(?<=\s|(?<=[，。！？、；：]))/g)
      for (const token of tokens) {
        const payload = JSON.stringify({
          id: `chatcmpl-moa-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'moa-aggregated',
          choices: [{ index: 0, delta: { content: token }, finish_reason: null }]
        })
        res.write(`data: ${payload}\n\n`)
      }
      const donePayload = JSON.stringify({
        id: `chatcmpl-moa-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'moa-aggregated',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      })
      res.write(`data: ${donePayload}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
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

export function stopGatewayServer(): void {
  if (server) { server.close(); server = null; console.log('[Gateway] stopped') }
  runningConfig = null
}

/**
 * 按当前设置应用网关运行态（settings.gateway.enabled/host/port 变更即时生效）：
 * - enabled=false → 停止（未运行则无操作）；
 * - enabled=true 且 host/port 未变化 → 保持现状（幂等，不重启）；
 * - host/port 变化 → 停止后按新配置重启。
 * 返回实际监听端口（未启用时 null）。
 */
export async function applyGatewayServer(): Promise<number | null> {
  const { enabled, host, port } = readAppSettings().gateway
  if (!enabled) {
    stopGatewayServer()
    return null
  }
  if (server && runningConfig && runningConfig.host === host && runningConfig.port === port) {
    return (server.address() as AddressInfo | null)?.port ?? port
  }
  stopGatewayServer()
  const actualPort = await startGatewayServer(createGatewayServer(), port, host)
  runningConfig = { host, port }
  return actualPort
}
