// ─── 模型定价表 ───
// 单位为 USD / 1K tokens，取 2025 年中的公开定价（各厂商官方定价页）。
// pattern 为模型 ID 前缀，lookupPrice() 会先按完整 modelId 精确匹配，
// 再按最长前缀匹配（如 'gpt-4o' 可匹配 'gpt-4o-2024-08-06'）。

export interface PriceEntry {
  pattern: string
  input: number
  output: number
}

export const DEFAULT_PRICING: PriceEntry[] = [
  // ── OpenAI ──
  { pattern: 'gpt-4o', input: 2.5, output: 10 },
  { pattern: 'gpt-4o-mini', input: 0.15, output: 0.6 },
  { pattern: 'gpt-3.5-turbo', input: 0.5, output: 1.5 },
  { pattern: 'o1', input: 15, output: 60 },
  { pattern: 'o1-mini', input: 1.1, output: 4.4 },

  // ── Anthropic ──
  { pattern: 'claude-3-5-sonnet', input: 3, output: 15 },
  { pattern: 'claude-3-7-sonnet', input: 3, output: 15 },
  { pattern: 'claude-3-haiku', input: 0.25, output: 1.25 },

  // ── DeepSeek ──
  { pattern: 'deepseek-chat', input: 0.27, output: 1.1 },
  { pattern: 'deepseek-reasoner', input: 0.55, output: 2.19 },

  // ── Google Gemini ──
  { pattern: 'gemini-1.5-pro', input: 1.25, output: 5 },
  { pattern: 'gemini-1.5-flash', input: 0.075, output: 0.3 },

  // ── Qwen ──
  { pattern: 'qwen2.5-72b', input: 1.4, output: 4.2 },
  { pattern: 'qwen2.5-7b', input: 0.3, output: 0.6 },

  // ── Llama ──
  { pattern: 'llama-3.1-405b', input: 3, output: 3 },
  { pattern: 'llama-3.1-8b', input: 0.05, output: 0.05 },

  // ── Mistral ──
  { pattern: 'mistral-large', input: 2, output: 6 },
  { pattern: 'mistral-small', input: 0.2, output: 0.6 },

  // ── 国内厂商 ──
  { pattern: 'glm-4', input: 1.0, output: 1.0 },
  { pattern: 'kimi', input: 0.6, output: 2.0 },
  { pattern: 'minimax', input: 0.2, output: 1.1 }
]

// 按 pattern 长度降序排列，保证前缀匹配时"最长优先"
// （例如 'gpt-4o-mini' 不会被 'gpt-4o' 前缀吃掉）
const PRICING_SORTED_BY_LENGTH = [...DEFAULT_PRICING].sort((a, b) => b.pattern.length - a.pattern.length)

/**
 * 根据模型 ID 查找定价。
 * 1. 先按完整 modelId 精确匹配；
 * 2. 再按最长前缀匹配；
 * 3. 均未命中返回 null。
 */
export function lookupPrice(modelId: string): { input: number; output: number } | null {
  if (!modelId) return null

  // 1) 完整精确匹配
  const exact = DEFAULT_PRICING.find((p) => p.pattern === modelId)
  if (exact) return { input: exact.input, output: exact.output }

  // 2) 最长前缀匹配（数组已按 pattern 长度降序，首个命中即最长）
  const prefix = PRICING_SORTED_BY_LENGTH.find((p) => modelId.startsWith(p.pattern))
  if (prefix) return { input: prefix.input, output: prefix.output }

  return null
}
