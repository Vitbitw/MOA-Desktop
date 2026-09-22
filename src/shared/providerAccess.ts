/**
 * 厂商凭据可用性判定（主进程与渲染层共用，保证「本地免 Key」口径一致）。
 */

/**
 * 是否本地回环地址：localhost / 127.0.0.0/8 / ::1。
 * 回环地址上的推理服务（Ollama、LM Studio、LocalAI、Jan 等）默认不校验 Authorization，
 * 因此这类厂商允许不配置 API Key。
 */
export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return host === 'localhost' || /^127(?:\.\d{1,3}){3}$/.test(host) || host === '::1'
  } catch {
    return false
  }
}

/** 是否具备发起调用的凭据：已配置 API Key，或本地回环地址（免 Key）。 */
export function hasProviderAccess(provider: { baseUrl: string; apiKey?: string | null }): boolean {
  return !!provider.apiKey || isLocalBaseUrl(provider.baseUrl)
}
