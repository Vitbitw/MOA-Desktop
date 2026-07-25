import React from 'react'
import { useEffect, useState } from 'react'
import { useConfigStore } from './store/configStore'
import { useConversationStore, convFromRow } from './store/conversationStore'
import Sidebar from './components/Sidebar'
import ChatArea from './components/ChatArea'
import InputBox from './components/InputBox'
import ErrorBoundary from './components/ErrorBoundary'
import MonitorView from './components/MonitorView'
import SettingsPanel from './components/SettingsPanel'

function App() {
  const setProviders = useConfigStore((s) => s.setProviders)
  const setConversations = useConversationStore((s) => s.setConversations)
  const [activeTab, setActiveTab] = useState<'chat' | 'settings'>('chat')
  const [viewMode, setViewMode] = useState<'standard' | 'monitor'>('standard')

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

  return (
    <ErrorBoundary>
      <div className="flex h-screen overflow-hidden bg-background">
        <Sidebar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
        />
        <main className="flex flex-col flex-1 min-w-0">
          {activeTab === 'chat' && viewMode === 'monitor' ? (
            <>
              <MonitorView />
              <InputBox />
            </>
          ) : activeTab === 'chat' ? (
            <>
              <ChatArea />
              <InputBox />
            </>
          ) : null}
          {activeTab === 'settings' && (
            <SettingsPanel />
          )}
        </main>
      </div>
    </ErrorBoundary>
  )
}

export default App
