import express, { type Express, type Request, type Response } from 'express'
import cors from 'cors'
import type { Server } from 'node:http'
import { getAllProviders } from '../providers/providerManager'
import { getMoaConfig } from '../moa/moaConfig'
import { executeMoA } from '../moa/moaEngine'
import { getDatabase } from '../db/database'
import type { Provider } from '../../shared/types'
import { fetchProxy } from '../local/fetchProxy'
import { DEFAULT_MAX_CONCURRENCY } from '../../shared/defaults'

let server: Server | null = null

// ── 并发计数与限流 ──
// 此前 /health 的 activeRequests/queueLength 硬编码 0，maxConcurrency 设置从未生效。
let activeRequests = 0
let queueLength = 0
const waiters: Array<() => void> = []

/** 读取代理最大并发数（settings.proxy.maxConcurrency），无效/未配置回退默认。 */
function getMaxConcurrency(): number {
  try {
    const row = getDatabase().queryOne<{ value: string }>(
      "SELECT value FROM moa_config WHERE key = 'app_settings'"
    )
    if (row?.value) {
      const saved = JSON.parse(row.value)
      const n = Number(saved?.proxy?.maxConcurrency)
      if (Number.isFinite(n) && n > 0) return n
    }
  } catch {
    // 读取失败回退默认
  }
  return DEFAULT_MAX_CONCURRENCY
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

export function createProxyServer(): Express {
  const app: Express = express()
  app.use(cors())
  app.use(express.json({ limit: '2mb' }))

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
    const requestedModel: string | undefined = req.body?.model
    // 智能路由：请求的 model 命中某 provider（含本地引擎）则路由之，否则回落第一个可用
    const provider = routeForRequest(requestedModel)
    if (!provider) {
      res.status(503).json({
        error: { message: 'No enabled provider configured.', type: 'moa_config_error' }
      })
      return
    }

    const config = getMoaConfig()
    const { messages, stream } = req.body

    // ── Direct mode ──
    if (config.mode === 'direct' || config.subModels.length === 0) {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`
        // 请求名不在该 provider 模型列表时回落到其第一个模型；否则透传原名
        let upstreamModel = requestedModel || ''
        if (!provider.models.some((m) => m.id === upstreamModel)) {
          upstreamModel = provider.models[0]?.id || upstreamModel
        }
        // 上游请求统一走 fetchProxy（本地回环地址自动直连，云端 provider 可走网络代理）
        const upstream = await fetchProxy(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...req.body, model: upstreamModel })
        })

        if (!upstream.ok) {
          const errBody = await upstream.text()
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
              if (line.startsWith('data: ')) res.write(line + '\n\n')
            }
          }
          if (!clientClosed) {
            if (buffer) res.write(buffer + '\n\n')
            res.write('data: [DONE]\n\n')
            res.end()
          }
        } else {
          const data = await upstream.json()
          res.json(data)
        }
      } catch (err: unknown) {
        // SSE 已开写后不能再发 JSON 错误体（headers 已发送，Express 会二次抛错挂死响应）——直接收流
        if (stream && res.headersSent) { res.end(); return }
        const msg = err instanceof Error ? err.message : String(err)
        res.status(502).json({ error: { message: `Proxy: ${msg}`, type: 'proxy_error' } })
      }
      return
    }

    // ── MoA mode (aggregate / compare) ──
    // X1 修复：executeMoA 主体无整体异常防护，Express 4 又不捕获 async handler 的
    // rejection——任何内部抛错（DB 故障等）都会变成 unhandled rejection 崩溃主进程
    const result = await executeMoA({
      messages: messages || [],
      subModels: config.subModels,
      aggregator: config.aggregator || undefined,
      mode: config.mode === 'aggregate' ? 'aggregate' : 'compare',
      aggregationPromptVariant: config.aggregationPromptVariant
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

    if (!result.success) {
      res.status(502).json({
        error: { message: result.error || 'MoA execution failed', type: 'moa_error' }
      })
      return
    }

    if (config.mode === 'compare') {
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
        ...(stream ? {} : { x_moa_sub_models: result.subOutputs.map(o => ({ modelId: o.modelId, status: o.status, durationMs: o.durationMs })) })
      })
    }
  }))

  // ── Non-completions passthrough ──
  ;['/v1/embeddings', '/v1/images/generations', '/v1/audio/transcriptions', '/v1/audio/speech', '/v1/moderations'].forEach((endpoint) => {
    app.post(endpoint, withConcurrency(async (req: Request, res: Response) => {
      const provider = firstUsableProvider()
      if (!provider) { res.status(503).json({ error: { message: 'No provider configured', type: 'moa_config_error' } }); return }
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`
        const upstream = await fetchProxy(`${provider.baseUrl.replace(/\/+$/, '')}${endpoint}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(req.body)
        })
        res.status(upstream.status).json(await upstream.json())
      } catch {
        res.status(502).json({ error: { message: 'Passthrough failed', type: 'proxy_error' } })
      }
    }))
  })

  return app
}

export function startProxyServer(app: Express, port: number, host: string): Promise<number> {
  return tryListen(app, port, host, 0)

  function tryListen(expressApp: Express, p: number, h: string, attempt: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const s = expressApp.listen(p, h, () => {
        server = s
        if (p !== port) console.log(`[Proxy] Port ${port} in use, using ${p} instead`)
        console.log(`[Proxy] http://${h}:${p}`)
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

export function stopProxyServer(): void {
  if (server) { server.close(); server = null; console.log('[Proxy] stopped') }
}
