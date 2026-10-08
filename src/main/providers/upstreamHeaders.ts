// ─── 上游请求头统一构建 ───
// OpenCode Zen / Go 系列要求请求携带稳定的 x-opencode-session（缺失时直接 400 MissingSessionID），
// 用于服务端路由优化与 prompt 缓存（官方文档"Where can I use it?"）。
// 仅对 opencode.ai 域名附加该头，其余上游保持原样，避免向无关服务发送自定义头。
import { randomUUID } from 'node:crypto'

/** 是否为 opencode.ai 系上游（OpenCode Zen / Go）：只有该域名的上游需要 x-opencode-session */
export function isOpencodeUpstream(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'opencode.ai' || host.endsWith('.opencode.ai')
  } catch {
    return false
  }
}

/**
 * 构建发往上游的请求头：Content-Type + Bearer（apiKey 有则加）。
 * opencode.ai 系上游附加 x-opencode-session：优先用调用方传入的会话 ID（同一对话/同一批任务复用，
 * 供服务端路由与 prompt 缓存），缺省生成一次性 ID 兜底——头缺失时 opencode 直接 400。
 */
export function buildUpstreamHeaders(baseUrl: string, apiKey?: string | null, sessionId?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  if (isOpencodeUpstream(baseUrl)) headers['x-opencode-session'] = sessionId || randomUUID()
  return headers
}

/** 生成一次性上游会话 ID（无对话上下文时使用；同一对话应复用调用方自身的会话标识） */
export function newUpstreamSessionId(): string {
  return randomUUID()
}
