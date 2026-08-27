import React, { useState } from 'react'
import { useConversationStore } from '../store/conversationStore'
import { useConfigStore } from '../store/configStore'
import { useSettingsStore } from '../store/settingsStore'
import { Search, Sun, Moon, Sparkles, RefreshCw, Plus, BarChart3, Globe } from 'lucide-react'

interface SidebarProps {
  onOpenUsage?: () => void
  onOpenCloud?: () => void
}

export default function Sidebar({ onOpenUsage, onOpenCloud }: SidebarProps) {
  const conversations = useConversationStore((s) => s.conversations)
  const providers = useConfigStore((s) => s.providers)
  const currentId = useConversationStore((s) => s.currentConversationId)
  const selectConversation = useConversationStore((s) => s.selectConversation)
  const newConversation = useConversationStore((s) => s.newConversation)
  const deleteConversation = useConversationStore((s) => s.deleteConversation)
  const updateConversationTitle = useConversationStore((s) => s.updateConversationTitle)
  const generateAndSetTitle = useConversationStore((s) => s.generateAndSetTitle)
  const titleLoading = useConversationStore((s) => s.titleLoading)
  const messages = useConversationStore((s) => s.messages)
  const { settings } = useSettingsStore()
  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')

  const [dark, setDark] = React.useState(
    () => localStorage.getItem('moa-theme') === 'dark' ||
      (!localStorage.getItem('moa-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)
  )

  const toggleTheme = () => {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('moa-theme', next ? 'dark' : 'light')
  }

  const filtered = conversations.filter((c) =>
    !search.trim() || c.title.toLowerCase().includes(search.toLowerCase())
  )

  const handleDoubleClick = (convId: string, currentTitle: string) => {
    setEditingId(convId)
    setEditDraft(currentTitle)
  }

  const handleEditSave = async () => {
    const id = editingId
    if (!id) return
    const trimmed = editDraft.trim()
    if (trimmed) {
      await updateConversationTitle(id, trimmed, true)
    }
    setEditingId(null)
    setEditDraft('')
  }

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleEditSave()
    }
    if (e.key === 'Escape') {
      setEditingId(null)
      setEditDraft('')
    }
  }

  const handleSparkle = async (convId: string) => {
    const titleSettings = settings?.title
    if (!titleSettings?.providerId || !titleSettings?.modelId) {
      alert('请先在设置→对话标题中配置标题模型（选择一个已配置 API Key 的模型）')
      return
    }
    // Fetch messages: use cached if current conversation, otherwise load from server
    let msgs: Array<{ role: string; content: string }> = []
    if (convId === currentId) {
      msgs = messages
    } else {
      const res = await window.moaAPI.getMessages(convId)
      if (res.success && Array.isArray(res.data)) {
        msgs = (res.data as any[]).map((m: any) => ({ role: m.role, content: m.content }))
      }
    }
    if (msgs.length === 0) {
      alert('该对话没有消息，无法生成标题')
      return
    }
    await generateAndSetTitle(convId, msgs, titleSettings)
  }

  return (
    <aside className="w-64 flex-shrink-0 border-r border-border bg-card flex flex-col">
      {/* Header */}
      <div className="p-3 border-b border-border flex items-center justify-between">
        <div>
          <h1 className="text-base font-bold text-foreground">MoA Desktop</h1>
          <p className="text-xs text-muted-foreground mt-0.5">{providers.length} 个厂商</p>
        </div>
        <button onClick={toggleTheme} className="p-1.5 text-muted-foreground hover:text-foreground rounded-md hover:bg-accent/50 transition-colors" title={dark ? '切换亮色' : '切换暗色'}>
          {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
      </div>

      {/* 对话区域标题 + 新建按钮 */}
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <span className="text-xs font-semibold text-muted-foreground">对话</span>
        <button
          onClick={newConversation}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> 新建
        </button>
      </div>

      {/* Chat list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {/* Search bar */}
          <div className="relative mb-2">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              data-search-input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索对话..."
              className="w-full rounded-md border border-input bg-background pl-7 pr-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {filtered.length === 0 && (
            <p className="text-xs text-muted-foreground text-center mt-8">
              {search ? '无匹配对话' : '暂无对话'}
            </p>
          )}
          {filtered.map((conv) => (
            <div key={conv.id} className="group relative">
              <button
                onClick={() => selectConversation(conv.id)}
                className={`w-full text-left p-2 rounded-md text-sm transition-colors ${
                  currentId === conv.id ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50 text-foreground'
                }`}
              >
                {editingId === conv.id ? (
                  <input
                    autoFocus
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onBlur={handleEditSave}
                    onKeyDown={handleEditKeyDown}
                    onClick={(e) => e.stopPropagation()}
                    maxLength={100}
                    className="w-full bg-background border border-input rounded px-1 py-0.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                ) : (
                  <div
                    className="truncate font-medium"
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      handleDoubleClick(conv.id, conv.title || '新对话')
                    }}
                  >
                    {conv.title || '新对话'}
                  </div>
                )}
                <div className="text-xs text-muted-foreground mt-0.5">
                  {conv.mode === 'aggregate' ? '聚合' : '对比'} · {conv.messageCount} 条
                </div>
              </button>

              {/* Right-side action buttons */}
              <div className="absolute top-1 right-1 flex items-center gap-0.5">
                {titleLoading[conv.id] ? (
                  <RefreshCw className="w-3.5 h-3.5 text-primary animate-spin" />
                ) : (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleSparkle(conv.id) }}
                    className="p-1 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground transition-opacity"
                    title="AI 生成标题"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id) }}
                  className="p-1 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity"
                  title="删除对话"
                >✕</button>
              </div>
            </div>
          ))}
        </div>

      {/* 底部：用量入口 */}
      {(onOpenUsage || onOpenCloud) && (
        <div className="p-2 border-t border-border flex flex-col gap-1">
          {onOpenUsage && (
            <button
              onClick={onOpenUsage}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
              title="查看本地用量统计"
            >
              <BarChart3 className="w-4 h-4" /> 用量
            </button>
          )}
          {onOpenCloud && (
            <button
              onClick={onOpenCloud}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
              title="查看 Command Code 云端用量"
            >
              <Globe className="w-4 h-4" /> 云监控
            </button>
          )}
        </div>
      )}
    </aside>
  )
}
