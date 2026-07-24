import React, { useState } from 'react'
import { useConversationStore } from '../store/conversationStore'
import { useConfigStore } from '../store/configStore'

export default function InputBox() {
  const [text, setText] = useState('')
  const mode = useConversationStore((s) => s.mode)
  const setMode = useConversationStore((s) => s.setMode)
  const sendMessage = useConversationStore((s) => s.sendMessage)
  const loading = useConversationStore((s) => s.loading)
  const subModels = useConfigStore((s) => s.subModels)

  const estimatedTokens = Math.ceil(text.length * 0.4) // ~2.5 chars per token
  const subModelEstimate = estimatedTokens + 200 // system prompt overhead
  const subCount = subModels.length || 3

  const handleSend = () => {
    if (!text.trim() || loading) return
    sendMessage(text)
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
      {/* Mode toggle */}
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
          子模型×{subCount} ≈ {subModelEstimate} | 总计 ≈ {estimatedTokens + subCount * subModelEstimate} tokens
        </span>

        {loading && (
          <span className="text-xs text-blue-500 animate-pulse">处理中...</span>
        )}
      </div>

      {/* Input area */}
      <div className="flex gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入问题... (Enter发送, Shift+Enter换行)"
          rows={2}
          disabled={loading}
          className="flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={!text.trim() || loading}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loading ? '...' : '发送'}
        </button>
      </div>
    </div>
  )
}
