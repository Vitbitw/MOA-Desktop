import React, { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage } from '../../../shared/types'

function ChatMessageBubble({ msg }: { msg: ChatMessage }) {
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
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {msg.content}
            </ReactMarkdown>
          </div>
        )}

        {/* Sub-model outputs for compare mode */}
        {!isUser && msg.subModelOutputs && msg.subModelOutputs.length > 0 && (
          <details className="mt-2 pt-2 border-t border-border/50">
            <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
              查看子模型输出 ({msg.subModelOutputs.length})
            </summary>
            <div className="mt-1 space-y-2">
              {msg.subModelOutputs.map((out, i) => (
                <div key={i} className="text-xs p-2 rounded bg-background/50 border border-border/30">
                  <div className="font-medium text-muted-foreground mb-1">
                    {out.modelId}
                    {out.durationMs ? ` · ${out.durationMs}ms` : ''}
                    <span className={`ml-1 ${out.status === 'success' ? 'text-green-500' : 'text-red-500'}`}>
                      {out.status === 'success' ? '✓' : '✗'}
                    </span>
                  </div>
                  {out.status === 'success' ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {out.content.slice(0, 500)}
                    </ReactMarkdown>
                  ) : (
                    <span className="text-red-400">{out.error}</span>
                  )}
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  )
}

export default memo(ChatMessageBubble)
