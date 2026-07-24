import React from 'react'
import { useConversationStore } from '../store/conversationStore'
import { useConfigStore } from '../store/configStore'

export default function Sidebar() {
  const conversations = useConversationStore((s) => s.conversations)
  const providers = useConfigStore((s) => s.providers)
  const setCurrentId = useConversationStore((s) => s.setCurrentConversation)
  const currentId = useConversationStore((s) => s.currentConversationId)

  return (
    <aside className="w-64 flex-shrink-0 border-r border-border bg-card flex flex-col">
      <div className="p-3 border-b border-border">
        <h1 className="text-base font-bold text-foreground">MoA Desktop</h1>
        <p className="text-xs text-muted-foreground mt-0.5">{providers.length} 个厂商</p>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {conversations.length === 0 && (
          <p className="text-xs text-muted-foreground text-center mt-8">暂无对话</p>
        )}
        {conversations.map((conv) => (
          <button
            key={conv.id}
            onClick={() => setCurrentId(conv.id)}
            className={`w-full text-left p-2 rounded-md text-sm transition-colors ${
              currentId === conv.id
                ? 'bg-accent text-accent-foreground'
                : 'hover:bg-accent/50 text-foreground'
            }`}
          >
            <div className="truncate font-medium">{conv.title || '新对话'}</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {conv.mode === 'aggregate' ? '聚合' : '对比'} · {conv.messageCount} 条
            </div>
          </button>
        ))}
      </div>

      <div className="p-2 border-t border-border">
        <button className="w-full p-2 text-xs text-muted-foreground hover:text-foreground text-center">
          + 新建对话
        </button>
      </div>
    </aside>
  )
}
