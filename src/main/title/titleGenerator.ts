import { getAllProviders } from '../providers/providerManager'
import { callSubModel } from '../moa/subModelCaller'
import type { SubModelOutput } from '../../shared/types'

export interface TitleGenerateRequest {
  messages: Array<{ role: string; content: string }>
  providerId: string
  modelId: string
  maxLength: number
  language: 'auto' | 'zh' | 'en'
}

/** Resolve the title model's provider base URL and API key. */
function resolveTitleModel(providerId: string): { baseUrl: string; apiKey: string } | null {
  const providers = getAllProviders()
  const p = providers.find((prov) => prov.id === providerId)
  if (!p) {
    console.error(`[Title] Provider ${providerId} not found`)
    return null
  }
  if (!p.apiKey) {
    console.error(`[Title] Provider ${p.name} has no API key`)
    return null
  }
  return { baseUrl: p.baseUrl, apiKey: p.apiKey }
}

/**
 * Build the prompt for title generation.
 * We pass the last few conversation messages to give the model enough context.
 */
function buildTitlePrompt(
  messages: Array<{ role: string; content: string }>,
  maxLength: number,
  language: 'auto' | 'zh' | 'en'
): string {
  // Take last N messages to stay within token budget (up to 6 messages, roughly 1K tokens)
  const recent = messages.slice(-6)
  const conversationText = recent
    .map((m) => {
      const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '系统'
      return `${role}: ${m.content}`
    })
    .join('\n')

  const langHint =
    language === 'zh'
      ? '用中文'
      : language === 'en'
        ? 'in English'
        : '使用与对话相同的语言'

  return `你是一个对话标题提炼助手。
根据以下对话内容，提炼一个简洁的标题（不超过${maxLength}字，${langHint}）。

对话：
${conversationText}

只输出标题文本，不要引号、不要解释、不要多余内容。`
}

/**
 * Generate a title from conversation messages by calling the configured lightweight model.
 * Returns null if generation fails (silent fallback).
 */
export async function generateTitle(req: TitleGenerateRequest): Promise<string | null> {
  const { providerId, modelId, messages, maxLength, language } = req

  // No model configured — silent fallback
  if (!providerId || !modelId) return null

  // Empty messages guard — don't waste an API call on nothing
  if (!messages || messages.length === 0) return null

  const resolved = resolveTitleModel(providerId)
  if (!resolved) return null

  const prompt = buildTitlePrompt(messages, maxLength, language)

  const result: SubModelOutput = await callSubModel({
    providerBaseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    modelId,
    messages: [{ role: 'user', content: prompt }],
    timeoutMs: 30_000
  })

  if (result.status !== 'success' || !result.content) {
    console.error(`[Title] API call failed:`, result.status, result.error || 'empty content')
    return null
  }

  // Sanitize: strip quotes, whitespace, clamp to maxLength
  let title = result.content.trim().replace(/^[""''""']+|[""''""']+$/g, '').trim()
  if (title.length > maxLength) {
    title = title.slice(0, maxLength)
  }
  if (!title) return null

  return title
}
