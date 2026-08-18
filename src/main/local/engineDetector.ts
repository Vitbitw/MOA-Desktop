import type { DetectedEngine, ModelInfo } from '../../shared/types'

const ENGINE_CANDIDATES: Array<{
  engineType: DetectedEngine['engineType']
  name: string
  url: string
  port: number
}> = [
  { engineType: 'lmstudio', name: 'LM Studio', url: 'http://127.0.0.1:1234/v1/models', port: 1234 },
  { engineType: 'ollama', name: 'Ollama', url: 'http://127.0.0.1:11434/v1/models', port: 11434 },
  { engineType: 'llamaserver', name: 'llama-server', url: 'http://127.0.0.1:8080/v1/models', port: 8080 }
]

/** 探测一个 OpenAI 兼容端点，返回模型列表；失败返回 null。 */
async function probe(url: string, timeoutMs = 2000): Promise<{ models: ModelInfo[]; version?: string } | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!resp.ok) return null
    const body = await resp.json()
    // OpenAI 兼容 /v1/models：{ data: [{ id }] }；Ollama /api/tags：{ models: [{ name }] }
    const raw: Array<{ id?: string; name?: string }> = Array.isArray(body.data) ? body.data : (Array.isArray(body.models) ? body.models : [])
    const models: ModelInfo[] = raw
      .map((m) => ({ id: m.id || m.name || '', name: m.id || m.name || '' }))
      .filter((m) => m.id)
      .map((m) => ({ ...m, providerId: '' }))
    return { models }
  } catch {
    return null
  }
}

/**
 * 探测本机已安装的本地推理引擎（只读，不拉起任何进程）。
 * R15：baseUrl 一律以 /v1 结尾（下游 callSubModel 等拼接 /chat/completions 依赖它）。
 */
export async function detectLocalEngines(): Promise<DetectedEngine[]> {
  const results = await Promise.all(ENGINE_CANDIDATES.map(async (c) => {
    const hit = await probe(c.url)
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
  let hit = await probe(`${withV1}/models`)
  if (!hit) {
    // 确认根路径存在（仅诊断），但不用裸根作为端点——避免「能列模型、不能聊天」的死端点
    const rootHit = await probe(`${normalized}/models`)
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
    models: hit.models
  }
}
