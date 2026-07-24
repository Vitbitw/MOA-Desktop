import React, { useState } from 'react'
import { useConversationStore } from '../store/conversationStore'

export default function InputBox() {
  const [text, setText] = useState('')
  const mode = useConversationStore((s) => s.mode)
  const setMode = useConversationStore((s) => s.setMode)
  const addMessage = useConversationStore((s) => s.addMessage)

  const handleSend = () => {
    if (!text.trim()) return
    addMessage({
      id: crypto.randomUUID(),
      conversationId: 'new',
      role: 'user',
      content: text,
      mode,
      timestamp: Date.now()
    })
    setText('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="border-t border-border p-4 bg-background">
      {/* Mode toggle + controls */}
      <div className="flex items-center gap-4 mb-2">
        <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
          <button
            onClick={() => setMode('aggregate')}
            className={`px-3 py-1 text-xs rounded-md transition-colors ${
              mode === 'aggregate' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            🧠 智能聚合
          </button>
          <button
            onClick={() => setMode('compare')}
            className={`px-3 py-1 text-xs rounded-md transition-colors ${
              mode === 'compare' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            📊 原始对比
          </button>
        </div>

        <span className="text-xs text-muted-foreground">
          子模型×3 ≈ 1.5K | 总计 ≈ 2.3K tokens
        </span>
      </div>

      {/* Input area */}
      <div className="flex gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入问题... (Enter发送, Shift+Enter换行)"
          rows={2}
          className="flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          onClick={handleSend}
          disabled={!text.trim()}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          发送
        </button>
      </div>
    </div>
  )
}
