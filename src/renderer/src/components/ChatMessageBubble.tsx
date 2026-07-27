import React, { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import type { ChatMessage } from '../../../shared/types'
import { useConversationStore } from '../store/conversationStore'

function ChatMessageBubble({ msg }: { msg: ChatMessage }) {
  const mode = useConversationStore((s) => s.mode)
  const isUser = msg.role === 'user'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm leading-relaxed ${
          isUser
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-foreground'
        }`}
      >
        {isUser ? (
          <pre className="whitespace-pre-wrap font-sans m-0">{msg.content}</pre>
        ) : (
          /* In compare mode with sub-outputs, the sub-model block below handles all display */
          (mode === 'aggregate' || !msg.subModelOutputs || msg.subModelOutputs.length === 0) && (
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                {msg.content}
              </ReactMarkdown>
            </div>
          )
        )}

        {/* Sub-model outputs: varies by mode */}
        {!isUser && msg.subModelOutputs && msg.subModelOutputs.length > 0 && (
          mode === 'aggregate' ? (
            /* ── 智能聚合：折叠按钮，默认不展开内容 ── */
            <details className="mt-2 pt-2 border-t border-border/50">
              <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground select-none">
                查看子模型输出 ({msg.subModelOutputs.length})
              </summary>
              <div className="mt-1 space-y-2">
                {msg.subModelOutputs.map((out, i) => (
                  <div key={i} className="text-xs p-2 rounded bg-background/50 border border-border/30">
                    <div className="font-medium text-muted-foreground mb-1">
                      #{i + 1} {out.modelId}
                      {out.durationMs ? ` · ${out.durationMs}ms` : ''}
                      <span className={`ml-1 ${out.status === 'success' ? 'text-green-500' : 'text-red-500'}`}>
                        {out.status === 'success' ? '✓' : '✗'}
                      </span>
                    </div>
                    {out.status === 'success' ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                        {out.content.slice(0, 500)}
                      </ReactMarkdown>
                    ) : (
                      <span className="text-red-400">{out.error}</span>
                    )}
                  </div>
                ))}
              </div>
            </details>
          ) : (
            /* ── 原始对比：直接展开子模型，顶部显示聚合输出或占位提示 ── */
            <div className="mt-2 pt-2 border-t border-border/50">
              {(() => {
                const isRealAggOutput =
                  msg.content &&
                  msg.content.trim() &&
                  !msg.content.startsWith('已调用') &&
                  !msg.content.startsWith('(模型返回了空内容)') &&
                  !msg.content.startsWith('请求失败')
                return isRealAggOutput ? (
                  <div className="mb-2 p-2 rounded bg-background/50 border border-border/30">
                    <p className="text-xs font-medium text-muted-foreground mb-1">聚合模型输出</p>
                    <div className="prose dark:prose-invert max-w-none text-xs">
                      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                        {msg.content}
                      </ReactMarkdown>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground mb-2">
                    以下是 {msg.subModelOutputs.length} 条模型输出的内容
                  </p>
                )
              })()}
              <div className="space-y-2">
                {msg.subModelOutputs.map((out, i) => (
                  <div key={i} className="text-xs p-2 rounded bg-background/50 border border-border/30">
                    <div className="font-medium text-muted-foreground mb-1">
                      #{i + 1} {out.modelId}
                      {out.durationMs ? ` · ${out.durationMs}ms` : ''}
                      <span className={`ml-1 ${out.status === 'success' ? 'text-green-500' : 'text-red-500'}`}>
                        {out.status === 'success' ? '✓' : '✗'}
                      </span>
                    </div>
                    {out.status === 'success' ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                        {out.content.slice(0, 500)}
                      </ReactMarkdown>
                    ) : (
                      <span className="text-red-400">{out.error}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )
        )}
      </div>
    </div>
  )
}

export default memo(ChatMessageBubble)
