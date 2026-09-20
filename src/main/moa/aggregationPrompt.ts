import type { ChatMessage } from './streamChat'

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

/** 主席团模式：主模型（最终作答者）的系统提示词 */
export const CHAIR_PROMPT_ZH = `你是多模型协作的主席团主持人（Chief & Final Answerer）。

下面是你的技术专家团队对当前问题的参考意见。每个专家被赋予了独立角色（如批判者、技术顾问等）。

你的职责：
1. 参考所有专家意见，但独立推理、亲自作答——不得机械复读或直接拼接某一份意见
2. 结合完整对话历史，理解上下文后给出最终答案
3. 专家之间有分歧：客观说明分歧点，给出你的判断依据和取舍结论
4. 专家意见缺失或明显错误：可以明确忽略并说明理由
5. 输出面向最终用户、可直接交付的答案，不要出现"据专家A所说"这类内部协作话术

输出要求：
- 直接输出最终答案，不写"综合过程"或"协作记录"
- 输出语言与用户提问语言一致`

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
    default:
      // 非法 variant（旧版本/脏配置值）：回退标准中文提示词，避免返回 undefined 被拼进 system prompt
      return STANDARD_PROMPT_ZH
  }
}

/**
 * Build the messages array for the aggregator model call.
 * Wraps sub-model outputs into references, appends the user's original query.
 */
export function buildAggregationMessages(
  userMessages: ChatMessage[],
  subModelOutputs: Array<{ modelId: string; content: string }>,
  aggregationSystemPrompt: string
): ChatMessage[] {
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

/**
 * 主席团模式：构建主模型（最终作答者）的 messages。
 * 保留完整多轮历史（transcript 末条为当前 user 问句），并注入带角色名的专家意见块。
 */
export function buildCommitteeMessages(
  transcript: ChatMessage[],
  expertOutputs: Array<{ modelId: string; content: string; expertName?: string }>,
  chairSystemPrompt: string
): ChatMessage[] {
  const refs = expertOutputs
    .map((o, i) => {
      // 专家署名：自定义角色名 > 通用专家（预设角色标签已退役，v9）
      const title = o.expertName?.trim() || '通用专家'
      return `[专家 ${i + 1} · ${title} · ${o.modelId}]:\n${o.content}`
    })
    .join('\n\n')

  const systemContent = `${chairSystemPrompt}\n\n—— 专家意见参考 ——\n\n${refs}`

  const finalUser = [...transcript].reverse().find((m) => m.role === 'user')
  // 按 finalUser 实际位置截断：末条非 user 时旧的 slice(length-1) 会丢掉中间消息并重复注入 finalUser
  const idx = finalUser ? transcript.lastIndexOf(finalUser) : transcript.length
  const prior = transcript.slice(0, idx)

  return [
    { role: 'system', content: systemContent },
    ...prior,
    ...(finalUser ? [{ role: 'user', content: finalUser.content }] : [])
  ]
}
