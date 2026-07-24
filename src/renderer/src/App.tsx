import React from 'react'
import { useEffect } from 'react'
import { useConfigStore } from './store/configStore'
import { useConversationStore } from './store/conversationStore'
import Sidebar from './components/Sidebar'
import ChatArea from './components/ChatArea'
import InputBox from './components/InputBox'
import ErrorBoundary from './components/ErrorBoundary'

function App() {
  const setProviders = useConfigStore((s) => s.setProviders)
  const setConversations = useConversationStore((s) => s.setConversations)

  useEffect(() => {
    window.moaAPI.getProviders().then((res) => {
      if (res.success) setProviders(res.data as any)
    })
    window.moaAPI.getConversations().then((res) => {
      if (res.success) setConversations(res.data as any)
    })
  }, [])

  return (
    <ErrorBoundary>
      <div className="flex h-screen overflow-hidden bg-background">
        <Sidebar />
        <main className="flex flex-col flex-1 min-w-0">
          <ChatArea />
          <InputBox />
        </main>
      </div>
    </ErrorBoundary>
  )
}

export default App
