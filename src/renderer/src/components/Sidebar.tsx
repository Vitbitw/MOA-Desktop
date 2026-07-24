import React, { useState } from 'react'
import { useConversationStore } from '../store/conversationStore'
import { useConfigStore } from '../store/configStore'

export default function Sidebar() {
  const conversations = useConversationStore((s) => s.conversations)
  const providers = useConfigStore((s) => s.providers)
  const currentId = useConversationStore((s) => s.currentConversationId)
  const selectConversation = useConversationStore((s) => s.selectConversation)
  const newConversation = useConversationStore((s) => s.newConversation)
  const [deleting, setDeleting] = useState<string | null>(null)

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (deleting) return
    setDeleting(id)
    try {
      await window.moaAPI.deleteConversation(id)
      // Refresh conversation list
      const res = await window.moaAPI.getConversations()
      if (res.success) {
        const convs = (res.data as any[]).map((c: any) => ({
          id: c.id,
          title: c.title,
          mode: c.mode,
          createdAt: c.created_at,
          updatedAt: c.updated_at,
          messageCount: c.message_count
        }))
        useConversationStore.setState({
          conversations: convs,
          currentConversationId:
            id === currentId ? null : currentId,
          messages: id === currentId ? [] : useConversationStore.getState().messages
        })
      }
    } catch {
      // silent
    } finally {
      setDeleting(null)
    }
  }

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
          <div key={conv.id} className="group relative">
            <button
              onClick={() => selectConversation(conv.id)}
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
            <button
              onClick={(e) => handleDelete(e, conv.id)}
              className="absolute top-1 right-1 p-1 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity"
              title="删除对话"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="p-2 border-t border-border">
        <button
          onClick={newConversation}
          className="w-full p-2 text-xs text-muted-foreground hover:text-foreground text-center hover:bg-accent/50 rounded-md transition-colors"
        >
          + 新建对话
        </button>
      </div>
    </aside>
  )
}
