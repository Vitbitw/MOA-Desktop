import React, { useState } from 'react'
import { useConversationStore } from '../store/conversationStore'
import { useConfigStore } from '../store/configStore'
import { Search, Settings, MessageSquare, Cpu, Sun, Moon } from 'lucide-react'

export default function Sidebar({
  activeTab,
  onTabChange,
  viewMode,
  onViewModeChange
}: {
  activeTab: string
  onTabChange: (tab: 'chat' | 'providers' | 'moa') => void
  viewMode: 'standard' | 'monitor'
  onViewModeChange: (mode: 'standard' | 'monitor') => void
}) {
  const conversations = useConversationStore((s) => s.conversations)
  const providers = useConfigStore((s) => s.providers)
  const currentId = useConversationStore((s) => s.currentConversationId)
  const selectConversation = useConversationStore((s) => s.selectConversation)
  const newConversation = useConversationStore((s) => s.newConversation)
  const deleteConversation = useConversationStore((s) => s.deleteConversation)
  const [search, setSearch] = useState('')

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

      {/* Tab navigation */}
      <div className="flex border-b border-border">
        <button onClick={() => onTabChange('chat')} className={`flex items-center gap-1.5 flex-1 px-3 py-2 text-xs border-b-2 transition-colors ${activeTab === 'chat' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
          <MessageSquare className="w-3.5 h-3.5" /> 对话
        </button>
        <button onClick={() => onTabChange('providers')} className={`flex items-center gap-1.5 flex-1 px-3 py-2 text-xs border-b-2 transition-colors ${activeTab === 'providers' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
          <Settings className="w-3.5 h-3.5" /> 厂商
        </button>
        <button onClick={() => onTabChange('moa')} className={`flex items-center gap-1.5 flex-1 px-3 py-2 text-xs border-b-2 transition-colors ${activeTab === 'moa' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
          <Cpu className="w-3.5 h-3.5" /> MoA
        </button>
      </div>

      {/* View mode toggle — visible only when chat tab is active */}
      {activeTab === 'chat' && (
        <div className="flex border-b border-border">
          <button
            onClick={() => onViewModeChange('standard')}
            className={`flex items-center gap-1 flex-1 px-3 py-1.5 text-xs border-b-2 transition-colors ${
              viewMode === 'standard'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            标准
          </button>
          <button
            onClick={() => onViewModeChange('monitor')}
            className={`flex items-center gap-1 flex-1 px-3 py-1.5 text-xs border-b-2 transition-colors ${
              viewMode === 'monitor'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            监控
          </button>
        </div>
      )}

      {/* Chat list */}
      {activeTab === 'chat' && (
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
                <div className="truncate font-medium">{conv.title || '新对话'}</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {conv.mode === 'aggregate' ? '聚合' : '对比'} · {conv.messageCount} 条
                </div>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id) }}
                className="absolute top-1 right-1 p-1 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity"
                title="删除对话"
              >✕</button>
            </div>
          ))}
          <div className="pt-2 border-t border-border mt-2">
            <button onClick={newConversation} className="w-full p-2 text-xs text-muted-foreground hover:text-foreground text-center hover:bg-accent/50 rounded-md transition-colors">
              + 新建对话
            </button>
          </div>
        </div>
      )}
    </aside>
  )
}
