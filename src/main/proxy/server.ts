import express, { type Express, type Request, type Response } from 'express'
import cors from 'cors'
import type { Server } from 'node:http'

let server: Server | null = null
let currentTargetUrl = 'https://api.openai.com/v1'
let currentApiKey = ''

export function setProxyConfig(targetUrl: string, apiKey: string) {
  currentTargetUrl = targetUrl
  currentApiKey = apiKey
}

export function createProxyServer(): Express {
  const app: Express = express()

  app.use(cors())
  app.use(express.json({ limit: '2mb' }))

  // ── Health ──
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      version: '1.0.0',
      uptimeSeconds: Math.floor(process.uptime()),
      activeRequests: 0,
      queueLength: 0,
      moaConfig: { subCount: 1, mode: 'direct' },
      providers: [
        { name: 'default', status: currentApiKey ? 'ok' : 'no_key', model: 'passthrough' }
      ]
    })
  })

  // ── Models list ──
  app.get('/v1/models', async (_req: Request, res: Response) => {
    try {
      const resp = await fetch(`${currentTargetUrl}/models`, {
        headers: { Authorization: `Bearer ${currentApiKey}` }
      })
      const data = await resp.json()
      res.json(data)
    } catch {
      res.json({ object: 'list', data: [] })
    }
  })

  // ── Chat completions (direct passthrough) ──
  app.post('/v1/chat/completions', async (req: Request, res: Response) => {
    if (!currentApiKey) {
      res.status(503).json({
        error: { message: 'No API key configured. Configure a provider first.', type: 'moa_config_error' }
      })
      return
    }

    const { stream } = req.body

    try {
      const upstream = await fetch(`${currentTargetUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${currentApiKey}`
        },
        body: JSON.stringify(req.body)
      })

      if (!upstream.ok) {
        const errBody = await upstream.text()
        res.status(502).json({
          error: {
            message: `Upstream returned ${upstream.status}: ${errBody.slice(0, 500)}`,
            type: 'upstream_error'
          }
        })
        return
      }

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')

        const reader = upstream.body?.getReader()
        if (!reader) {
          res.status(502).json({ error: { message: 'No response body from upstream', type: 'upstream_error' } })
          return
        }

        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              res.write(line + '\n\n')
            }
          }
        }

        if (buffer) res.write(buffer + '\n\n')
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        const data = await upstream.json()
        // Ensure standard OpenAI format
        res.json({
          id: data.id || `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: data.created || Math.floor(Date.now() / 1000),
          model: data.model || 'moa-passthrough',
          choices: data.choices || [],
          usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        })
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      res.status(502).json({
        error: { message: `Proxy error: ${msg}`, type: 'proxy_error' }
      })
    }
  })

  return app
}

export function startProxyServer(app: Express, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server = app.listen(port, host, () => {
      console.log(`[Proxy] http://${host}:${port}`)
      resolve()
    })
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[Proxy] Port ${port} in use`)
        reject(new Error(`Port ${port} in use`))
      } else {
        reject(err)
      }
    })
  })
}

export function stopProxyServer(): void {
  if (server) {
    server.close()
    server = null
    console.log('[Proxy] stopped')
  }
}
