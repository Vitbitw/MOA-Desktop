import React from 'react'
import { useConversationStore } from '../store/conversationStore'

export default function ChatArea() {
  const messages = useConversationStore((s) => s.messages)
  const mode = useConversationStore((s) => s.mode)

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {/* Mode indicator */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
        <span className="font-medium">{mode === 'aggregate' ? '智能聚合 A' : '原始对比 D'}</span>
      </div>

      {messages.length === 0 && (
        <div className="flex items-center justify-center h-full">
          <div className="text-center text-muted-foreground">
            <p className="text-sm">选择模式并输入问题开始</p>
          </div>
        </div>
      )}

      {messages.map((msg) => (
        <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
          <div
            className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm leading-relaxed ${
              msg.role === 'user'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-foreground'
            }`}
          >
            <pre className="whitespace-pre-wrap font-sans m-0">{msg.content}</pre>
          </div>
        </div>
      ))}
    </div>
  )
}
