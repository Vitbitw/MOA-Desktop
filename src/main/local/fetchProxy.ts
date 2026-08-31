/**
 * 代理感知的 fetch 封装。
 * 读取 DB 中的 network.proxyUrl，若启用则通过 HTTP CONNECT 隧道代理外发请求。
 * 未启用或代理地址为空时退化为全局 fetch（直连）。
 *
 * 实现：Node.js 原生 http/tls 模块，零外部依赖。
 *
 * 失败快速降级：HTTPS 代理首次失败后标记为不可用（30s 冷却），
 * 后续请求直连，避免每次请求都超时 15s。
 */
import http from 'node:http'
import tls from 'node:tls'
import { Readable } from 'node:stream'
import { getDatabase } from '../db/database'

// ─── 代理状态 ───
/** 代理 HTTPS 不可用的过期时间戳（0 = 可用） */
let proxyBrokenUntil = 0

/**
 * 从 DB 读取 network 设置（同步，sql.js 内存库）。
 */
function getProxyUrl(): string {
  try {
    const row = getDatabase().queryOne<{ value: string }>(
      "SELECT value FROM moa_config WHERE key = 'app_settings'"
    )
    if (!row?.value) return ''
    const settings = JSON.parse(row.value)
    if (settings?.network?.enabled && settings?.network?.proxyUrl) {
      return settings.network.proxyUrl as string
    }
  } catch { /* 静默 */ }
  return ''
}

function parseProxy(url: string): { host: string; port: number } | null {
  try {
    const u = new URL(url)
    return { host: u.hostname, port: Number(u.port) || 80 }
  } catch {
    return null
  }
}

/** 是否本地回环地址（本地引擎/本机服务直连，不走代理——代理普遍拒绝回环目标）。 */
function isLoopbackHost(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0:0:0:0:0:0:0:1'
  } catch {
    return false
  }
}

function safeDestroy(...sockets: (import('net').Socket | null | undefined)[]): void {
  for (const s of sockets) {
    try { s?.destroy() } catch { /* ignore */ }
  }
}

/**
 * 流式 HTTP chunked 传输编码解码器。
 * 输入原始分块字节流（含 `<hex-size>\r\n<data>\r\n` 框架与结尾 `0\r\n\r\n`），
 * 输出去框架后的真实 body 字节。
 *
 * 为什么必须存在：CONNECT 隧道内是手写 HTTP/1.1 客户端，直接读 TLS socket 原始字节。
 * undici 直连 fetch 自动解 chunk，但隧道路径没人解——若把框架字节直接当 body，
 * chunked 响应的 JSON（HF/GitHub API）解析失败，gguf 文件损坏。
 */
class ChunkedDecoder {
  private buf: Buffer = Buffer.alloc(0)
  private done = false

  /** 喂入新字节，返回可输出的 body 片段（可能为空数组）。格式非法时抛错。 */
  push(chunk: Buffer): Buffer[] {
    if (this.done) return []
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    const out: Buffer[] = []
    while (true) {
      const lineEnd = this.buf.indexOf('\r\n')
      if (lineEnd === -1) {
        // chunk-size 行超长仍未见行尾 → 异常（合法 size 行最多十几字节）
        if (this.buf.length > 32) throw new Error('chunked 格式异常: size 行超长')
        break
      }
      // size 行可带扩展（`1a;ext=v`），分号前为长度
      const sizeStr = this.buf.subarray(0, lineEnd).toString('ascii').split(';')[0].trim()
      const size = parseInt(sizeStr, 16)
      if (!Number.isFinite(size) || size < 0) throw new Error(`chunked 格式异常: 非法 size "${sizeStr}"`)
      const dataStart = lineEnd + 2
      // 数据 + 尾随 \r\n 需全部到齐才能切（不足则等下一轮）
      if (this.buf.length < dataStart + size + 2) break
      if (size > 0) out.push(this.buf.subarray(dataStart, dataStart + size))
      this.buf = this.buf.subarray(dataStart + size + 2)
      if (size === 0) {
        // 终止块（0\r\n\r\n）。其后可能的 trailer 头直接丢弃——下载场景无意义。
        this.done = true
        break
      }
    }
    return out
  }

  /** 流正常结束时校验收尾；未收到 0 块即结束 = 截断。 */
  finish(): void {
    if (!this.done) throw new Error('chunked 流提前结束（未收到终止块）')
  }
}

/** 标记代理 HTTPS 不可用（30s 冷却期） */
function markProxyBroken(): void {
  proxyBrokenUntil = Date.now() + 30_000
  console.warn('[Network] proxy HTTPS unavailable, direct connection for 30s')
}

function isProxyBroken(): boolean {
  if (proxyBrokenUntil > 0 && Date.now() < proxyBrokenUntil) return true
  if (proxyBrokenUntil > 0) proxyBrokenUntil = 0 // 冷却结束
  return false
}

/**
 * 通过 HTTP CONNECT 隧道发起 HTTPS 请求。
 * CONNECT 超时 8s，TLS 握手超时 8s。
 * 全程流式（不缓冲完整响应体，GB 级文件不爆内存）；
 * abort 在响应建立后也生效（销毁 socket + readable，让 reader.read() 抛错）。
 */
function fetchViaConnect(
  urlStr: string,
  proxy: { host: string; port: number },
  init?: RequestInit
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const target = new URL(urlStr)
    let settled = false
    let tlsSocket: import('tls').TLSSocket | null = null
    let rawSocket: import('net').Socket | null = null
    let bodyReadable: import('node:stream').Readable | null = null

    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }

    const cleanup = () => safeDestroy(tlsSocket, rawSocket)

    // ── AbortSignal ──
    // 注意:不能包在 settle 里——响应建立(settled)后 abort 仍需销毁底层流,
    // 否则已 resolve 的 Response body 流不会被中断,取消下载失效(下载继续跑到完)
    const onAbort = () => {
      bodyReadable?.destroy(new Error('The operation was aborted'))
      cleanup()
      settle(() => reject(new Error('The operation was aborted')))
    }
    if (init?.signal?.aborted) { onAbort(); return }
    init?.signal?.addEventListener('abort', onAbort, { once: true })

    // ── CONNECT 请求（8s 超时）──
    const connectReq = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      timeout: 8_000
    })

    connectReq.on('connect', (res, socket) => {
      if (settled) { socket.destroy(); return }
      rawSocket = socket

      if (res.statusCode !== 200) {
        settle(() => { cleanup(); reject(new Error(`代理 CONNECT 失败: HTTP ${res.statusCode}`)) })
        return
      }

      // TLS 握手（8s 超时）
      tlsSocket = tls.connect({ socket, servername: target.hostname, timeout: 8_000 })

      tlsSocket.on('secureConnect', () => {
        if (settled) return

        const reqPath = target.pathname + target.search
        const hdrs: Record<string, string> = {
          'Host': target.host,
          'Connection': 'close',
          ...(init?.headers as Record<string, string> || {})
        }
        if (!hdrs['User-Agent']) hdrs['User-Agent'] = 'moa-desktop'

        const headerLines = [`GET ${reqPath} HTTP/1.1`]
        for (const [k, v] of Object.entries(hdrs)) headerLines.push(`${k}: ${v}`)
        headerLines.push('', '')
        tlsSocket!.write(headerLines.join('\r\n'))

        // ── 统一流式响应：chunked 响应经解码器去框架，其余直推 ──
        const readable = new Readable({ read() {} })
        bodyReadable = readable

        let headerBuf = Buffer.alloc(0)
        let parsed = false
        let decoder: ChunkedDecoder | null = null

        /** 处理解析完头部后的 body 字节（过解码器或直推）。格式异常 → 销毁流。 */
        const emitBody = (raw: Buffer): boolean => {
          if (!decoder) { readable.push(raw); return true }
          try {
            for (const piece of decoder.push(raw)) readable.push(piece)
            return true
          } catch (e) {
            readable.destroy(e instanceof Error ? e : new Error(String(e)))
            cleanup()
            return false
          }
        }

        tlsSocket!.on('data', (chunk: Buffer) => {
          if (readable.destroyed) return
          if (!parsed) {
            // 累积直到头部完整；64KB 上限防异常服务器无限撑内存
            headerBuf = Buffer.concat([headerBuf, chunk])
            if (headerBuf.length > 64 * 1024) {
              const e = new Error('代理隧道响应头超长')
              readable.destroy(e); cleanup()
              settle(() => reject(e))
              return
            }
            const headerEnd = headerBuf.indexOf('\r\n\r\n')
            if (headerEnd === -1) return
            parsed = true

            const headerPart = headerBuf.subarray(0, headerEnd).toString('utf-8')
            const bodyStart = headerEnd + 4
            const statusLine = headerPart.split('\r\n')[0]
            const statusCode = parseInt(statusLine.split(' ')[1] || '', 10)

            const respHeaders = new Headers()
            for (const line of headerPart.split('\r\n').slice(1)) {
              const idx = line.indexOf(':')
              if (idx > 0) respHeaders.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim())
            }
            if ((respHeaders.get('transfer-encoding') || '').includes('chunked')) {
              decoder = new ChunkedDecoder()
              // 已代解框架，该头对上层无意义且会误导（undici 不会二次解码）
              respHeaders.delete('transfer-encoding')
            }

            // Response 构造防护：status 必须 200-599，非法/缺失归一为 502；
            // 不防护则构造函数抛错会逃逸到 data 事件 → uncaught exception
            const safeStatus = Number.isFinite(statusCode) && statusCode >= 200 && statusCode <= 599 ? statusCode : 502
            let resp: Response
            try {
              resp = new Response(Readable.toWeb(readable) as ReadableStream, {
                status: safeStatus, headers: respHeaders
              })
            } catch (e) {
              const err = e instanceof Error ? e : new Error(String(e))
              readable.destroy(err); cleanup()
              settle(() => reject(err))
              return
            }
            settle(() => resolve(resp))

            const bodyChunk = headerBuf.subarray(bodyStart)
            if (bodyChunk.length > 0) emitBody(bodyChunk)
            return
          }
          emitBody(chunk)
        })

        tlsSocket!.on('end', () => {
          // 响应头到达前连接就关闭 → reject(否则 promise 永不 settle 挂死)
          if (!parsed && !settled) {
            cleanup()
            settle(() => reject(new Error('代理隧道连接提前关闭')))
            return
          }
          // chunked 流必须已收到终止块，否则 = 截断，标记流损坏让 reader 抛错
          if (decoder && !readable.destroyed) {
            try { decoder.finish() } catch (e) {
              readable.destroy(e instanceof Error ? e : new Error(String(e)))
              cleanup()
              return
            }
          }
          readable.push(null)
          cleanup()
        })
        tlsSocket!.on('error', (e: Error) => {
          readable.destroy(e)
          cleanup()
          settle(() => reject(e))
        })
      })

      tlsSocket.on('error', (e: Error) => settle(() => { cleanup(); reject(e) }))
      tlsSocket.on('timeout', () => settle(() => { cleanup(); reject(new Error('TLS 握手超时')) }))
    })

    connectReq.on('error', (e: Error) => settle(() => { cleanup(); reject(e) }))
    connectReq.on('timeout', () => settle(() => { connectReq.destroy(); cleanup(); reject(new Error('代理连接超时')) }))
    connectReq.end()
  })
}

/**
 * 通过 HTTP 代理发起 HTTP（非 HTTPS）请求。
 */
function fetchViaHttpProxy(
  urlStr: string,
  proxy: { host: string; port: number },
  init?: RequestInit
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(init?.headers as Record<string, string> || {}) }
    if (!headers['User-Agent']) headers['User-Agent'] = 'moa-desktop'

    // ── 透传 method/body：此前写死 GET 且不带 body，HTTP 明文代理路径下
    // POST /chat/completions 会退化成无 body 的 GET，上游必然 4xx/5xx ──
    const method = (init?.method || 'GET').toUpperCase()
    let bodyBuffer: Buffer | null = null
    if (init?.body != null) {
      if (typeof init.body === 'string') bodyBuffer = Buffer.from(init.body, 'utf-8')
      else if (init.body instanceof Uint8Array) bodyBuffer = Buffer.from(init.body)
      else if (init.body instanceof ArrayBuffer) bodyBuffer = Buffer.from(new Uint8Array(init.body))
      // ReadableStream body（如流式上传）不在此路径处理——退化为无 body 请求
      if (bodyBuffer) {
        headers['Content-Length'] = String(bodyBuffer.length)
      }
    }

    const req = http.request({
      host: proxy.host, port: proxy.port,
      method, path: urlStr, headers, timeout: 30_000
    }, (res) => {
      const readable = Readable.from(res)
      const respHeaders = new Headers()
      for (const [k, v] of Object.entries(res.headers)) {
        if (v) respHeaders.set(k, Array.isArray(v) ? v.join(', ') : v)
      }
      // ── 响应建立后的 abort:销毁 res 流,让 reader.read() 抛错(否则取消下载失效)──
      if (init?.signal) {
        const destroyRes = () => { res.destroy(new Error('The operation was aborted')) }
        if (init.signal.aborted) destroyRes()
        else init.signal.addEventListener('abort', destroyRes, { once: true })
      }
      // safeStatus 防护(与 fetchViaConnect 对齐):服务器在发状态行前关闭连接时
      // res.statusCode 为 undefined,new Response({status: undefined}) 会抛 TypeError;
      // 该抛错发生在 http.request 异步回调内 → 逃逸为 uncaught exception 崩溃主进程。
      // 非法/缺失状态归一为 502。
      const safeStatus = Number.isFinite(res.statusCode) && res.statusCode! >= 200 && res.statusCode! <= 599
        ? res.statusCode!
        : 502
      let resp: Response
      try {
        resp = new Response(Readable.toWeb(readable) as ReadableStream, {
          status: safeStatus, headers: respHeaders
        })
      } catch (e) {
        res.destroy(e instanceof Error ? e : new Error(String(e)))
        reject(e instanceof Error ? e : new Error(String(e)))
        return
      }
      resolve(resp)
    })

    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('代理请求超时')) })
    req.end(bodyBuffer || undefined)

    if (init?.signal) {
      if (init.signal.aborted) { req.destroy(); reject(new Error('The operation was aborted')); return }
      init.signal.addEventListener('abort', () => { req.destroy(); reject(new Error('The operation was aborted')) }, { once: true })
    }
  })
}

/**
 * 单次代理请求(不跟随重定向)。
 */
async function fetchOnce(
  url: string | URL,
  init?: RequestInit
): Promise<Response> {
  const proxyUrl = getProxyUrl()

  const urlStr = typeof url === 'string' ? url : url.toString()
  // 本地回环地址直连：即使配置了代理，本机引擎/代理自身的请求也不走代理
  if (isLoopbackHost(urlStr)) return fetch(url, init)

  // 无代理 → 直连
  if (!proxyUrl) return fetch(url, init)

  const proxy = parseProxy(proxyUrl)
  if (!proxy) {
    console.warn(`[Network] invalid proxy URL: ${proxyUrl}, fallback to direct`)
    return fetch(url, init)
  }

  const isHttps = urlStr.startsWith('https:')

  // HTTPS 代理已标记不可用 → 直连
  if (isHttps && isProxyBroken()) {
    return fetch(url, init)
  }

  try {
    return isHttps
      ? await fetchViaConnect(urlStr, proxy, init)
      : await fetchViaHttpProxy(urlStr, proxy, init)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 取消场景(signal 已触发):不再降级直连,直接抛 abort 错误,避免直连 fetch 无 signal 继续下载
    if (init?.signal?.aborted) {
      throw err
    }
    if (isHttps) markProxyBroken()
    console.warn(`[Network] proxy request failed: ${msg}, fallback to direct`)
    // 保留 init(含 headers/method/body/signal 未触发时也能响应后续取消)
    return fetch(url, init)
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
/** 幂等方法下可安全重试的状态码：429、5xx（服务端瞬时故障） */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])

/** GET/HEAD/OPTIONS 幂等，可对 5xx 状态码自动重试；POST 等非幂等请求只对「未收到响应」的错误重试，避免重复计费 */
function isIdempotentMethod(method?: string): boolean {
  const m = (method ?? 'GET').toUpperCase()
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS'
}

/** 读取 DB 中 network.timeoutMs / network.retryCount（同步，sql.js 内存库） */
function getApiRequestConfig(): { timeoutMs: number; retryCount: number } {
  const DEFAULT_TIMEOUT_MS = 15_000
  const DEFAULT_RETRY_COUNT = 2
  try {
    const row = getDatabase().queryOne<{ value: string }>(
      "SELECT value FROM moa_config WHERE key = 'app_settings'"
    )
    if (!row?.value) return { timeoutMs: DEFAULT_TIMEOUT_MS, retryCount: DEFAULT_RETRY_COUNT }
    const settings = JSON.parse(row.value)
    const network = settings?.network
    const timeoutMs =
      typeof network?.timeoutMs === 'number' && Number.isFinite(network.timeoutMs) && network.timeoutMs >= 0
        ? network.timeoutMs
        : DEFAULT_TIMEOUT_MS
    const retryCount =
      typeof network?.retryCount === 'number' && Number.isFinite(network.retryCount) && network.retryCount >= 0
        ? Math.floor(network.retryCount)
        : DEFAULT_RETRY_COUNT
    return { timeoutMs, retryCount }
  } catch {
    return { timeoutMs: DEFAULT_TIMEOUT_MS, retryCount: DEFAULT_RETRY_COUNT }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 单次尝试：跟随重定向（最多 maxRedirects 跳），不做超时/重试。
 * 直连模式 undici 原生跟随重定向，但手写代理路径不会——
 * HF `resolve` 下载链与 GitHub `browser_download_url` 均为 302 → CDN，
 * 不跟随则代理模式下下载全部失败(302 被当失败状态)。此处统一在封装层补齐。
 */
async function fetchFollowRedirects(
  url: string | URL,
  init?: RequestInit,
  maxRedirects = 5
): Promise<Response> {
  let current: string | URL = url
  let lastResp: Response | null = null
  for (let hops = 0; hops <= maxRedirects; hops++) {
    const resp = await fetchOnce(current, init)
    lastResp = resp
    if (REDIRECT_STATUSES.has(resp.status)) {
      const loc = resp.headers.get('location')
      if (loc) {
        // 释放重定向响应体再跳转
        try { await resp.body?.cancel() } catch { /* ignore */ }
        current = new URL(loc, current).toString()
        continue
      }
    }
    return resp
  }
  // 重定向跳数超限：返回最后一个 3xx 响应（语义与旧实现一致，交由上层处理）
  return lastResp!
}

/**
 * 代理感知 fetch，自动跟随重定向（最多 5 跳）并支持超时 + 自动重试。
 *
 * 超时重试语义（配置见 app_settings.network，UI 在「云端用量监控」页）：
 *  - 超时：单次尝试的等待时长上限（timeoutMs，默认 15s，0 = 不限制），覆盖连接 + 首字节
 *  - 重试：timeoutMs/网络错误/代理失败 → 自动重试（重试次数 = retryCount，默认 2）
 *  - GET/HEAD 额外对 429/5xx 响应重试；POST 等非幂等请求不按状态码重试（避免重复计费）
 *  - 调用方若自带 signal（如 AbortSignal.timeout），则视为调用方自行管理超时预算，
 *    本层不再套用全局 timeoutMs 硬超时；调用方主动取消 → 立即抛错、不重试
 */
export async function fetchProxy(
  url: string | URL,
  init?: RequestInit,
  maxRedirects = 5
): Promise<Response> {
  const { timeoutMs, retryCount } = getApiRequestConfig()
  const callerSignal = init?.signal
  const maxAttempts = Math.max(1, retryCount + 1)

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (callerSignal?.aborted) throw new Error('The operation was aborted')
    // 重试前短暂退避（300ms 起指数增长，封顶 1.5s）
    if (attempt > 1) await sleep(Math.min(1500, 300 * 2 ** (attempt - 2)))

    const attemptCtrl = new AbortController()
    let timedOut = false
    const onCallerAbort = () => attemptCtrl.abort()
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })

    // 调用方自带信号 → 不叠加全局硬超时（尊重其自身的超时预算）
    let timer: ReturnType<typeof setTimeout> | undefined
    if (!callerSignal && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        attemptCtrl.abort()
      }, timeoutMs)
    }

    try {
      const resp = await fetchFollowRedirects(url, { ...init, signal: attemptCtrl.signal }, maxRedirects)
      if (
        isIdempotentMethod(init?.method) &&
        RETRYABLE_STATUSES.has(resp.status) &&
        attempt < maxAttempts
      ) {
        try { await resp.body?.cancel() } catch { /* ignore */ }
        console.warn(`[Network] HTTP ${resp.status}, retrying (attempt ${attempt}/${maxAttempts}): ${String(url)}`)
        continue
      }
      return resp
    } catch (err) {
      // 调用方主动取消（含其自带 timeout 到期）→ 原样抛出、不重试
      if (callerSignal?.aborted) throw err instanceof Error ? err : new Error(String(err))
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < maxAttempts) {
        console.warn(`[Network] ${timedOut ? 'request timed out' : 'request failed'}, retrying (attempt ${attempt}/${maxAttempts}): ${lastError.message}`)
      }
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    }
  }

  throw lastError ?? new Error(`请求失败: ${String(url)}`)
}

/**
 * 代理设置变更后调用：重置「代理 HTTPS 不可用」冷却，立即重新尝试代理。
 */
export function invalidateProxyCache(): void {
  proxyBrokenUntil = 0
}
