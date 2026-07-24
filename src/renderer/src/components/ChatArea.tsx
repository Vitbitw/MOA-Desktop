import React from 'react'
import { useConversationStore } from '../store/conversationStore'
import ChatMessageBubble from './ChatMessageBubble'

export default function ChatArea() {
  const messages = useConversationStore((s) => s.messages)
  const mode = useConversationStore((s) => s.mode)
  const loading = useConversationStore((s) => s.loading)
  const error = useConversationStore((s) => s.error)

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {/* Mode indicator */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
        <span className="font-medium">
          {mode === 'aggregate' ? '🧠 智能聚合 A' : '📊 原始对比 D'}
        </span>
      </div>

      {/* Error banner */}
      {error && (
        <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Empty state */}
      {messages.length === 0 && !loading && (
        <div className="flex items-center justify-center h-full">
          <div className="text-center text-muted-foreground">
            <p className="text-sm">配置厂商后选择模式并输入问题开始</p>
          </div>
        </div>
      )}

      {/* Messages */}
      {messages.map((msg) => (
        <ChatMessageBubble key={msg.id} msg={msg} />
      ))}

      {/* Loading indicator */}
      {loading && (
        <div className="flex justify-start">
          <div className="max-w-[80%] rounded-xl px-4 py-3 bg-muted text-foreground">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse delay-75" />
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse delay-150" />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
