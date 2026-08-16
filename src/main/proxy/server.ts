import express, { type Express, type Request, type Response } from 'express'
import cors from 'cors'
import type { Server } from 'node:http'
import { getAllProviders } from '../providers/providerManager'
import { getMoaConfig } from '../moa/moaConfig'
import { executeMoA } from '../moa/moaEngine'

let server: Server | null = null

/** Find first enabled provider (API key or local endpoint) for direct passthrough. */
function firstUsableProvider(): { baseUrl: string; apiKey: string } | null {
  const providers = getAllProviders()
  for (const p of providers) {
    if (p.enabled && (p.apiKey || p.kind === 'local')) return { baseUrl: p.baseUrl, apiKey: p.apiKey || '' }
  }
  return null
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
      activeRequests: 0,
      queueLength: 0,
      moaConfig: { subCount: config.subModels.length, mode: config.mode },
      providers: [{ name: 'default', status: provider ? 'ok' : 'no_key', model: config.mode }]
    })
  })

  // ── Models list (passthrough to first provider) ──
  app.get('/v1/models', async (_req: Request, res: Response) => {
    const provider = firstUsableProvider()
    if (!provider) { res.json({ object: 'list', data: [] }); return }
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`
      const resp = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/models`, {
        headers
      })
      res.json(await resp.json())
    } catch {
      res.json({ object: 'list', data: [] })
    }
  })

  // ── Chat completions ──
  app.post('/v1/chat/completions', async (req: Request, res: Response) => {
    const provider = firstUsableProvider()
    if (!provider) {
      res.status(503).json({
        error: { message: 'No enabled provider with API key configured.', type: 'moa_config_error' }
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
        const upstream = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...req.body, model: req.body.model || '' })
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
          const decoder = new TextDecoder()
          let buffer = ''
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''
            for (const line of lines) { if (line.startsWith('data: ')) res.write(line + '\n\n') }
          }
          if (buffer) res.write(buffer + '\n\n')
          res.write('data: [DONE]\n\n')
          res.end()
        } else {
          const data = await upstream.json()
          res.json(data)
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        res.status(502).json({ error: { message: `Proxy: ${msg}`, type: 'proxy_error' } })
      }
      return
    }

    // ── MoA mode (aggregate / compare) ──
    const result = await executeMoA({
      messages: messages || [],
      subModels: config.subModels,
      aggregator: config.aggregator || undefined,
      mode: config.mode === 'aggregate' ? 'aggregate' : 'compare',
      aggregationPromptVariant: config.aggregationPromptVariant
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
  })

  // ── Non-completions passthrough ──
  ;['/v1/embeddings', '/v1/images/generations', '/v1/audio/transcriptions', '/v1/audio/speech', '/v1/moderations'].forEach((endpoint) => {
    app.post(endpoint, async (req: Request, res: Response) => {
      const provider = firstUsableProvider()
      if (!provider) { res.status(503).json({ error: { message: 'No provider configured', type: 'moa_config_error' } }); return }
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`
        const upstream = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}${endpoint}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(req.body)
        })
        res.status(upstream.status).json(await upstream.json())
      } catch {
        res.status(502).json({ error: { message: 'Passthrough failed', type: 'proxy_error' } })
      }
    })
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
