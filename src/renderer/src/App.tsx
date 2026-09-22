import React from 'react'
import { useEffect, useState } from 'react'
import { useConfigStore } from './store/configStore'
import { useConversationStore, convFromRow } from './store/conversationStore'
import { initGatewaySubscriptions } from './store/gatewayStore'
import { useSettingsStore } from './store/settingsStore'
import { initProbeStateSubscription } from './store/probeStore'
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
import { BarChart3, Globe } from 'lucide-react'

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

  // 网关代理请求直播（T5）：挂载时注册 5 个 gateway 事件订阅 → gatewayStore；
  // roundStart 到达时自动切监控视图（不锁定：用户可手动切走，dismiss 也不影响轮次执行）
  useEffect(() => {
    return initGatewaySubscriptions(() => setViewMode('monitor'))
  }, [])

  // Task 7: cleanup live events when switching back to standard view
  useEffect(() => {
    if (viewMode === 'standard') {
      useConversationStore.getState().cleanupLiveEvents?.()
      // F3：退订后同步清空 live 状态，避免监控视图残留半途数据与「生成中/运行中」标记
      useConversationStore.getState().clearLiveState()
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

  // Menu event listeners (Ctrl+N → new conversation, MoA gateway URL copy)
  useEffect(() => {
    const unsub = window.moaAPI.onMenuNewConversation(() => {
      useConversationStore.getState().newConversation()
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = window.moaAPI.onMenuCopyGatewayUrl((url) => {
      // The main process already copied to clipboard; show a hint
      console.log(`Gateway URL ${url} copied to clipboard`)
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

  // 定价探查运行状态（含后台自动刷新）：全局订阅，设置页据此显示「正在刷新」并禁用按钮
  useEffect(() => {
    return initProbeStateSubscription()
  }, [])

  // 厂商模型列表变更（主进程 /models 拉取后广播：探查 fetchModelsBeforeProbe 与手动「获取模型列表」共用）
  // → 重拉 providers，使设置页厂商卡片、定价源模型列表、模型下拉实时同步（原先仅启动时拉一次）
  // 一次探查可能连续变更多个厂商，500ms 内的多次广播合并为一次重拉
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const reload = () => {
      window.moaAPI.getProviders().then((res: { success: boolean; data: unknown }) => {
        if (res.success) setProviders(res.data as any)
      })
    }
    const unsub = window.moaAPI.onProvidersChanged(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        reload()
      }, 500)
    })
    return () => {
      if (timer) clearTimeout(timer)
      unsub()
    }
  }, [setProviders])

  return (
    <ErrorBoundary>
      <div className="flex h-screen overflow-hidden bg-background">
        <Sidebar onOpenUsage={() => setViewMode('usage')} onOpenCloud={() => setViewMode('cloud')} />
        <main className="flex flex-col flex-1 min-w-0">
          {/* 视图切换栏：两组视觉语言 —— 工作区组（标准/监控）用分段容器，
              数据面板组（用量/云监控）用带图标幽灵按钮 */}
          {!showSettings && (
            <div className="flex items-center gap-1.5 px-4 py-2 border-b border-border bg-card/50 flex-shrink-0">
              {/* 工作区组：分段控件 */}
              <div className="inline-flex gap-0.5 p-[3px] rounded-[10px] bg-accent">
                <button
                  onClick={() => setViewMode('standard')}
                  className={`px-4 py-1 text-xs rounded-[7px] transition-colors ${
                    viewMode === 'standard'
                      ? 'bg-primary text-primary-foreground font-semibold'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  标准
                </button>
                <button
                  onClick={() => setViewMode('monitor')}
                  className={`px-4 py-1 text-xs rounded-[7px] transition-colors ${
                    viewMode === 'monitor'
                      ? 'bg-primary text-primary-foreground font-semibold'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  监控
                </button>
              </div>
              {/* 组间分隔线 */}
              <div className="w-px h-6 mx-2.5 rounded-full bg-foreground/25" />
              {/* 数据面板组：带图标幽灵按钮 */}
              <button
                onClick={() => setViewMode('usage')}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border transition-colors ${
                  viewMode === 'usage'
                    ? 'border-foreground/20 bg-foreground/10 text-foreground font-semibold'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-accent'
                }`}
              >
                <BarChart3 className="w-3.5 h-3.5" /> 用量
              </button>
              <button
                onClick={() => setViewMode('cloud')}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border transition-colors ${
                  viewMode === 'cloud'
                    ? 'border-foreground/20 bg-foreground/10 text-foreground font-semibold'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-accent'
                }`}
              >
                <Globe className="w-3.5 h-3.5" /> 云监控
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
