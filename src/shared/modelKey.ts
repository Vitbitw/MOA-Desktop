/**
 * 'providerId:modelId' → 两段：按【首个】冒号切分。
 * providerId 不含冒号；modelId 可含冒号（如 Ollama 的 llama3.1:8b、llama3.2:latest），必须无损保留。
 * 无冒号时整个 key 视为 providerId、modelId 为空串（与旧 split(':') 默认值行为一致）。
 */
export function splitModelKey(key: string): { providerId: string; modelId: string } {
  const i = key.indexOf(':')
  if (i === -1) return { providerId: key, modelId: '' }
  return { providerId: key.slice(0, i), modelId: key.slice(i + 1) }
}
