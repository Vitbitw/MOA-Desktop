import React from 'react'
import { useEffect, useState } from 'react'
import { useConfigStore } from './store/configStore'
import { useConversationStore, convFromRow } from './store/conversationStore'
import { useSettingsStore } from './store/settingsStore'
import Sidebar from './components/Sidebar'
import ChatArea from './components/ChatArea'
import InputBox from './components/InputBox'
import ErrorBoundary from './components/ErrorBoundary'
import MonitorView from './components/MonitorView'
import SettingsPanel from './components/SettingsPanel'
import UsageView from './components/UsageView'
import UsageBar from './components/UsageBar'
import CloudMonitorView from './components/CloudMonitorView'
import ToastCenter from './components/ToastCenter'
import { useNotificationStore } from './store/notificationStore'

function App() {
  const setProviders = useConfigStore((s) => s.setProviders)
  const setConversations = useConversationStore((s) => s.setConversations)
  const [showSettings, setShowSettings] = useState(false)
  const [viewMode, setViewMode] = useState<'standard' | 'monitor' | 'usage' | 'cloud'>('standard')

  // Listen for menu "设置" (Ctrl+,)
  useEffect(() => {
    const unsub = window.moaAPI.onMenuOpenSettings(() => setShowSettings(true))
    return unsub
  }, [])

  // 用量悬浮窗右键「打开用量页」→ 切换到用量视图
  useEffect(() => {
    const unsub = window.moaAPI.onUsageOpen(() => setViewMode('usage'))
    return unsub
  }, [])

  // Task 7: cleanup live events when switching back to standard view
  useEffect(() => {
    if (viewMode === 'standard') {
      useConversationStore.getState().cleanupLiveEvents?.()
    }
  }, [viewMode])

  useEffect(() => {
    window.moaAPI.getProviders().then((res: { success: boolean; data: unknown }) => {
      if (res.success) setProviders(res.data as any)
    })
    window.moaAPI.getConversations().then((res: { success: boolean; data: unknown }) => {
      if (res.success && Array.isArray(res.data)) setConversations((res.data as any[]).map(convFromRow))
    })
    // Load settings on mount so Sidebar ✨ button can check title model config
    useSettingsStore.getState().loadSettings()
  }, [])

  // Ctrl+K / Cmd+K → focus sidebar search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        const input = document.querySelector<HTMLInputElement>('[data-search-input]')
        input?.focus()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Menu event listeners (Ctrl+N → new conversation, API proxy URL copy)
  useEffect(() => {
    const unsub = window.moaAPI.onMenuNewConversation(() => {
      useConversationStore.getState().newConversation()
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = window.moaAPI.onMenuCopyProxyUrl((url) => {
      // The main process already copied to clipboard; show a hint
      console.log(`Proxy URL ${url} copied to clipboard`)
    })
    return unsub
  }, [])

  // Title update event — refresh conversation list when title changes asynchronously
  useEffect(() => {
    const unsub = window.moaAPI.onTitleUpdated((data) => {
      const convs = ((data.conversations || []) as any[]).map(convFromRow)
      useConversationStore.getState().setConversations(convs)
    })
    return unsub
  }, [])

  // 主进程 → 渲染进程悬浮通知（如定价自动刷新等后台任务）
  useEffect(() => {
    const unsub = window.moaAPI.onRendererToast((data) => {
      useNotificationStore.getState().push(data)
    })
    return unsub
  }, [])

  return (
    <ErrorBoundary>
      <div className="flex h-screen overflow-hidden bg-background">
        <Sidebar onOpenUsage={() => setViewMode('usage')} onOpenCloud={() => setViewMode('cloud')} />
        <main className="flex flex-col flex-1 min-w-0">
          {/* View mode toolbar — only when chat is showing */}
          {!showSettings && (
            <div className="flex items-center gap-1 px-4 py-2 border-b border-border bg-card/50 flex-shrink-0">
              <button
                onClick={() => setViewMode('standard')}
                className={`px-3 py-1 text-xs rounded-md border transition-colors ${
                  viewMode === 'standard'
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-accent'
                }`}
              >
                标准
              </button>
              <button
                onClick={() => setViewMode('monitor')}
                className={`px-3 py-1 text-xs rounded-md border transition-colors ${
                  viewMode === 'monitor'
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-accent'
                }`}
              >
                监控
              </button>
              <button
                onClick={() => setViewMode('usage')}
                className={`px-3 py-1 text-xs rounded-md border transition-colors ${
                  viewMode === 'usage'
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-accent'
                }`}
              >
                用量
              </button>
              <button
                onClick={() => setViewMode('cloud')}
                className={`px-3 py-1 text-xs rounded-md border transition-colors ${
                  viewMode === 'cloud'
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-accent'
                }`}
              >
                云监控
              </button>
            </div>
          )}
          {!showSettings && viewMode === 'monitor' ? (
            <>
              <UsageBar onOpenUsage={() => setViewMode('usage')} />
              <MonitorView />
              <InputBox />
            </>
          ) : !showSettings && viewMode === 'usage' ? (
            <>
              <UsageView />
              <InputBox />
            </>
          ) : !showSettings && viewMode === 'cloud' ? (
            <CloudMonitorView />
          ) : !showSettings ? (
            <>
              <UsageBar onOpenUsage={() => setViewMode('usage')} />
              <ChatArea />
              <InputBox />
            </>
          ) : null}
          {showSettings && (
            <SettingsPanel onClose={() => setShowSettings(false)} />
          )}
        </main>
      </div>
      {/* 全局悬浮通知（右下角） */}
      <ToastCenter />
    </ErrorBoundary>
  )
}

export default App
