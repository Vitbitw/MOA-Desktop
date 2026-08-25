import type { DetectedEngine, ModelInfo } from '../../shared/types'

interface EngineCandidate {
  engineType: DetectedEngine['engineType']
  name: string
  port: number
  /** 引擎专属探测逻辑（只读，不拉起进程）；返回模型列表 + 可选版本，失败返回 null。 */
  probe: () => Promise<{ models: ModelInfo[]; version?: string } | null>
}

const ENGINE_CANDIDATES: EngineCandidate[] = [
  {
    engineType: 'lmstudio', name: 'LM Studio', port: 1234,
    probe: () => probeOpenAI('http://127.0.0.1:1234/v1/models')
  },
  {
    engineType: 'ollama', name: 'Ollama', port: 11434,
    probe: probeOllama
  },
  {
    engineType: 'llamaserver', name: 'llama-server', port: 8080,
    probe: () => probeOpenAI('http://127.0.0.1:8080/v1/models')
  }
]

/**
 * 探测一个 OpenAI 兼容端点（/v1/models），返回模型列表 + 可选版本；失败返回 null。
 * 版本提取：LM Studio 在响应头 `lmstudio-version` 暴露版本；其余引擎无则省略。
 */
async function probeOpenAI(url: string, timeoutMs = 2000): Promise<{ models: ModelInfo[]; version?: string } | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!resp.ok) return null
    const body = await resp.json()
    const raw: Array<{ id?: string; name?: string }> = Array.isArray(body.data) ? body.data : (Array.isArray(body.models) ? body.models : [])
    const models: ModelInfo[] = raw
      .map((m) => ({ id: m.id || m.name || '', name: m.id || m.name || '' }))
      .filter((m) => m.id)
      .map((m) => ({ ...m, providerId: '' }))
    const version = resp.headers.get('lmstudio-version') || undefined
    return { models, version }
  } catch {
    return null
  }
}

/**
 * 探测 Ollama（兼容新旧版本）：
 * 1) 先试 OpenAI 兼容端点 /v1/models（新版 Ollama 支持，且 baseUrl 一致供下游 chat 使用）
 * 2) 失败回退 /api/tags（旧版兼容）拿模型列表 + /api/version 拿版本号
 * baseUrl 仍按 /v1 暴露——旧版 Ollama 同时支持 /api/chat 与 /v1/chat/completions（R15 不变）。
 */
async function probeOllama(timeoutMs = 2000): Promise<{ models: ModelInfo[]; version?: string } | null> {
  const openAIHit = await probeOpenAI('http://127.0.0.1:11434/v1/models', timeoutMs)
  if (openAIHit) {
    // /v1/models 成功,但 Ollama 不返回 lmstudio-version 头 → 主动 /api/version 补全
    // Ollama 可达时 /api/version 也快速响应,不会显著增加探测时间
    const version = await fetchOllamaVersion(timeoutMs)
    return { models: openAIHit.models, version: version || openAIHit.version }
  }
  // 旧版回退：/v1/models 不可达 → 试 /api/tags(Ollama 不可达时这里也会快速失败,不浪费时间)
  try {
    const resp = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(timeoutMs) })
    if (!resp.ok) return null
    const body = await resp.json() as { models?: Array<{ name?: string }> }
    const models: ModelInfo[] = (body.models || [])
      .map((m) => ({ id: m.name || '', name: m.name || '', providerId: '' }))
      .filter((m) => m.id)
    // /api/tags 可达 → /api/version 大概率也可达,尝试补全版本
    const version = await fetchOllamaVersion(timeoutMs)
    return { models, version }
  } catch {
    return null
  }
}

/** 拉 Ollama /api/version；失败返回 undefined（版本可选，不阻塞探测）。 */
async function fetchOllamaVersion(timeoutMs = 2000): Promise<string | undefined> {
  try {
    const vResp = await fetch('http://127.0.0.1:11434/api/version', { signal: AbortSignal.timeout(timeoutMs) })
    if (vResp.ok) return ((await vResp.json()) as { version?: string }).version
  } catch { /* 版本可选，忽略 */ }
  return undefined
}

/**
 * 探测本机已安装的本地推理引擎（只读，不拉起任何进程）。
 * R15：baseUrl 一律以 /v1 结尾（下游 callSubModel 等拼接 /chat/completions 依赖它）。
 */
export async function detectLocalEngines(): Promise<DetectedEngine[]> {
  const results = await Promise.all(ENGINE_CANDIDATES.map(async (c) => {
    const hit = await c.probe()
    return {
      engineType: c.engineType,
      name: c.name,
      baseUrl: `http://127.0.0.1:${c.port}/v1`,
      port: c.port,
      reachable: hit !== null,
      version: hit?.version,
      models: hit?.models || []
    } satisfies DetectedEngine
  }))
  return results
}

/**
 * 手动地址探测（用于「手动添加本地引擎」）。
 * R15 + 语义修正：只接受 OpenAI 兼容端点——先剥尾 /，若地址已以 /v1 结尾则直接使用
 * （不再重复拼接成 /v1/v1），否则补 /v1 再试 ${norm}/v1/models；
 * 失败再试 ${norm}/models 仅用于「确认根路径存在」，但**不接受裸根**（裸根会在后续
 * callSubModel 拼 /chat/completions 时 404）。裸根可用时视为「不支持」，
 * 返回带明确错误的 null，由调用方提示用户。返回的 baseUrl 一律以 /v1 结尾。
 */
export async function probeCustomBaseUrl(baseUrl: string): Promise<DetectedEngine | null> {
  const normalized = baseUrl.replace(/\/+$/, '')
  const withV1 = normalized.endsWith('/v1') ? normalized : `${normalized}/v1`
  let hit = await probeOpenAI(`${withV1}/models`)
  if (!hit) {
    // 确认根路径存在（仅诊断），但不用裸根作为端点——避免「能列模型、不能聊天」的死端点
    const rootHit = await probeOpenAI(`${normalized}/models`)
    if (rootHit) {
      console.warn(`[Local] ${normalized} 的 /models 在根路径可达但 /v1/models 不可达——不采用裸根（OpenAI 兼容端点需要 /v1 前缀）`)
    }
    return null
  }
  return {
    engineType: 'manual',
    name: (() => {
      try {
        const u = new URL(normalized)
        return `${u.hostname}${u.port ? ':' + u.port : ''}` || normalized
      } catch { return normalized }
    })(),
    baseUrl: withV1,
    port: 0,
    reachable: true,
    version: hit.version,
    models: hit.models
  }
}
