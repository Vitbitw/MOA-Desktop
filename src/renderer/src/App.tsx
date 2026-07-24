import React from 'react'
import { useEffect, useState } from 'react'
import { useConfigStore } from './store/configStore'
import { useConversationStore } from './store/conversationStore'
import type { Conversation, MoAMode } from '../../shared/types'
import Sidebar from './components/Sidebar'
import ChatArea from './components/ChatArea'
import InputBox from './components/InputBox'
import ErrorBoundary from './components/ErrorBoundary'
import ProvidersPanel from './components/ProvidersPanel'
import MoAConfigPanel from './components/MoAConfigPanel'

function App() {
  const setProviders = useConfigStore((s) => s.setProviders)
  const setConversations = useConversationStore((s) => s.setConversations)
  const [activeTab, setActiveTab] = useState<'chat' | 'providers' | 'moa'>('chat')

  useEffect(() => {
    window.moaAPI.getProviders().then((res: { success: boolean; data: unknown }) => {
      if (res.success) setProviders(res.data as any)
    })
    window.moaAPI.getConversations().then((res: { success: boolean; data: unknown }) => {
      if (res.success) setConversations(res.data as any)
    })
  }, [])

  return (
    <ErrorBoundary>
      <div className="flex h-screen overflow-hidden bg-background">
        <Sidebar
          activeTab={activeTab}
          onTabChange={setActiveTab}
        />
        <main className="flex flex-col flex-1 min-w-0">
          {activeTab === 'chat' && (
            <>
              <ChatArea />
              <InputBox />
            </>
          )}
          {activeTab === 'providers' && (
            <div className="flex-1 overflow-y-auto p-6">
              <ProvidersPanel />
            </div>
          )}
          {activeTab === 'moa' && (
            <div className="flex-1 overflow-y-auto p-6">
              <MoAConfigPanel />
            </div>
          )}
        </main>
      </div>
    </ErrorBoundary>
  )
}

export default App
