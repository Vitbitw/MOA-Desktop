export const STANDARD_PROMPT_ZH = `你是一个多模型融合器（Mixture-of-Agents Synthesizer）。

以下是 N 个不同模型对同一用户问题的独立回答，标记为 [参考1] 到 [参考N]。
你的任务是将它们融合成一个高质量、全面的最终答案。

融合要求：
1. 提取精华——从各回答中提取最准确、最有价值的信息
2. 消除矛盾——回答矛盾时客观呈现不同立场，不做虚假折中
3. 补全遗漏——确保最终答案覆盖各回答中的独特贡献，不遗漏关键信息
4. 结构优化——用逻辑清晰的段落、适当的分层来组织，避免机械拼接

输出要求：
- 直接输出最终答案，不要写"融合过程"或"模型对比"
- 输出语言与用户提问语言一致
- 如果无法融合（如事实性矛盾无法判断），在对应位置注明"不同来源存在分歧"`

export const CONCISE_PROMPT_EN = `You are the aggregator. Below are independent responses from multiple models to the same user query. Synthesize them into the best possible answer — accurate, comprehensive, and coherent. Resolve contradictions, preserve unique insights, and output directly to the user. Use the same language as the user's query.`

export type AggregationPromptVariant = 'standard-zh' | 'concise-en' | 'custom'

/** Return the aggregation system prompt string for a given variant. */
export function getAggregationPrompt(variant: AggregationPromptVariant, customPrompt?: string): string {
  switch (variant) {
    case 'standard-zh':
      return STANDARD_PROMPT_ZH
    case 'concise-en':
      return CONCISE_PROMPT_EN
    case 'custom':
      return customPrompt || STANDARD_PROMPT_ZH
  }
}

/**
 * Build the messages array for the aggregator model call.
 * Wraps sub-model outputs into references, appends the user's original query.
 */
export function buildAggregationMessages(
  userMessages: Array<{ role: string; content: string }>,
  subModelOutputs: Array<{ modelId: string; content: string }>,
  aggregationSystemPrompt: string
): Array<{ role: string; content: string }> {
  // Build references block
  const refs = subModelOutputs
    .map((out, i) => `Reference ${i + 1} — ${out.modelId}:\n${out.content}`)
    .join('\n\n')

  // System prompt with references injected
  const systemContent = `${aggregationSystemPrompt}\n\nBelow are the reference responses:\n\n${refs}`

  // Find the last user message for the user query
  const userQuery = [...userMessages].reverse().find((m) => m.role === 'user')
  const queryContent = userQuery?.content || ''

  return [
    { role: 'system', content: systemContent },
    ...(queryContent ? [{ role: 'user', content: queryContent }] : [])
  ]
}
