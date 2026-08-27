import { create } from 'zustand'
import type { Conversation, ChatMessage, MoAMode, SubModelOutput, SubOutputUpdate, AggregationChunk, TitleSettings } from '../../../shared/types'

// ── Live streaming sub-output state (for Monitor View) ──
export interface LiveSubOutput {
  index: number
  modelId: string
  providerId: string
  content: string
  status: 'pending' | 'running' | 'success' | 'error'
  error?: string
  durationMs?: number
  tokenUsage?: { prompt: number; completion: number }
}

/** Factory: convert DB row to Conversation type. */
export function convFromRow(c: any): Conversation {
  return {
    id: c.id,
    title: c.title || '',
    mode: c.mode || 'aggregate',
    subModels: c.sub_models ? JSON.parse(c.sub_models) : [],
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    messageCount: c.message_count || 0,
    titleEdited: !!c.title_edited
  }
}

interface ConversationState {
  conversations: Conversation[]
  currentConversationId: string | null
  messages: ChatMessage[]
  mode: MoAMode
  loading: boolean
  error: string | null

  // ── Title generation ──
  titleLoading: Record<string, boolean>

  setConversations: (convs: Conversation[]) => void
  setCurrentConversation: (id: string | null) => void
  setMessages: (msgs: ChatMessage[]) => void
  addMessage: (msg: ChatMessage) => void
  setMode: (mode: MoAMode) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void

  // ── Live streaming state ──
  liveSubOutputs: LiveSubOutput[]
  aggregatorText: string
  aggregatorRunning: boolean
  /** 当前 sendMessage 注册的 IPC 事件清理函数（视图切换时调用），null 表示无活跃监听 */
  liveCleanupRef: (() => void) | null

  // ── Live streaming actions ──
  setLiveSubOutputs: (outputs: LiveSubOutput[]) => void
  updateLiveSubOutput: (index: number, update: Partial<LiveSubOutput>) => void
  setAggregatorText: (text: string) => void
  setAggregatorRunning: (running: boolean) => void
  clearLiveState: () => void
  cleanupLiveEvents: () => void

  // Async actions
  sendMessage: (content: string) => Promise<void>
  selectConversation: (id: string) => Promise<void>
  newConversation: () => void
  deleteConversation: (id: string) => Promise<void>
  refreshConversations: () => Promise<void>

  // ── Title actions ──
  updateConversationTitle: (id: string, title: string, titleEdited?: boolean) => Promise<void>
  generateAndSetTitle: (id: string, messages: Array<{ role: string; content: string }>, titleSettings: TitleSettings) => Promise<void>
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: [],
  currentConversationId: null,
  messages: [],
  mode: 'aggregate',
  loading: false,
  error: null,
  titleLoading: {},

  setConversations: (conversations) => set({ conversations }),
  setCurrentConversation: (currentConversationId) => set({ currentConversationId }),
  setMessages: (messages) => set({ messages }),
  addMessage: (msg) => set((state) => ({ messages: [...state.messages, msg] })),
  setMode: (mode) => set({ mode }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),

  // ── Live streaming initial values ──
  liveSubOutputs: [],
  aggregatorText: '',
  aggregatorRunning: false,
  liveCleanupRef: null,

  // ── Live streaming actions ──
  setLiveSubOutputs: (liveSubOutputs) => set({ liveSubOutputs }),
  updateLiveSubOutput: (index, update) =>
    set((state) => ({
      liveSubOutputs: state.liveSubOutputs.map((o) =>
        o.index === index ? { ...o, ...update } : o
      )
    })),
  setAggregatorText: (aggregatorText) => set({ aggregatorText }),
  setAggregatorRunning: (aggregatorRunning) => set({ aggregatorRunning }),
  clearLiveState: () => set({
    liveSubOutputs: [],
    aggregatorText: '',
    aggregatorRunning: false
  }),

  newConversation: () => set({ currentConversationId: null, messages: [] }),

  refreshConversations: async () => {
    try {
      const res = await window.moaAPI.getConversations()
      if (res.success) {
        const convs = ((res.data as any[]) || []).map(convFromRow)
        // Move current conversation to top if it still exists
        const { currentConversationId } = get()
        set({
          conversations: convs,
          currentConversationId: convs.some((c) => c.id === currentConversationId)
            ? currentConversationId
            : null
        })
      }
    } catch {
      // silent
    }
  },

  selectConversation: async (id) => {
    set({ loading: true, error: null })
    try {
      const res = await window.moaAPI.getMessages(id)
      if (res.success) {
        const msgs = ((res.data as any[]) || []).map((m: any) => ({
          id: m.id,
          conversationId: m.conversation_id,
          role: m.role as 'user' | 'assistant' | 'system',
          content: m.content,
          mode: m.mode as MoAMode,
          subModelOutputs: m.sub_outputs ? JSON.parse(m.sub_outputs) as SubModelOutput[] : undefined,
          timestamp: m.timestamp
        }))
        set({ currentConversationId: id, messages: msgs, loading: false })
      } else {
        set({ error: String(res.error), loading: false })
      }
    } catch (err) {
      set({ error: String(err), loading: false })
    }
  },

  deleteConversation: async (id) => {
    try {
      await window.moaAPI.deleteConversation(id)
      await get().refreshConversations()
      const { currentConversationId } = get()
      if (currentConversationId === id) {
        set({ currentConversationId: null, messages: [] })
      }
    } catch {
      // silent
    }
  },

  sendMessage: async (content) => {
    const { mode, currentConversationId } = get()
    if (!content.trim()) return

    // 0. 每次请求唯一 ID：防止上一次 onAllDone 的 cleanup 清掉本次请求的监听
    //    （连续快速发两条消息时，第一次的 onAllDone 会 cleanup 掉第二次刚注册的监听）
    const requestId = crypto.randomUUID()

    // 1. Clear previous live state
    set({
      liveSubOutputs: [],
      aggregatorText: '',
      aggregatorRunning: false,
      error: null,
      liveCleanupRef: null
    })

    // 2. Register IPC event listeners (BEFORE sending)
    const unsubs: (() => void)[] = []
    const cleanup = () => { unsubs.forEach(fn => fn()); unsubs.length = 0 }

    // 仅在「当前仍是本次请求」时清理（防旧请求的 onAllDone 清掉新请求的监听）
    const cleanupIfCurrent = () => {
      if (get().liveCleanupRef === cleanup) {
        cleanup()
        set({ liveCleanupRef: null })
      }
    }

    if (window.moaAPI.onSubOutputUpdate) {
      unsubs.push(window.moaAPI.onSubOutputUpdate((data: SubOutputUpdate) => {
        const existing = get().liveSubOutputs.find((o) => o.index === data.index)
        if (existing) {
          get().updateLiveSubOutput(data.index, {
            content: data.content,
            status: data.status,
            error: data.error,
            durationMs: data.durationMs,
            tokenUsage: data.tokenUsage
          })
        } else {
          set((state) => ({
            liveSubOutputs: [...state.liveSubOutputs, {
              index: data.index,
              modelId: data.modelId,
              providerId: data.providerId,
              content: data.content,
              status: data.status as LiveSubOutput['status'],
              error: data.error,
              durationMs: data.durationMs,
              tokenUsage: data.tokenUsage
            }]
          }))
        }
      }))
    }

    if (window.moaAPI.onAggregationStart) {
      unsubs.push(window.moaAPI.onAggregationStart(() => {
        set({ aggregatorRunning: true })
      }))
    }

    if (window.moaAPI.onAggregationChunk) {
      unsubs.push(window.moaAPI.onAggregationChunk((data: AggregationChunk) => {
        if (typeof data.text === 'string') {
          set({ aggregatorText: data.text, aggregatorRunning: !data.done })
        }
      }))
    }

    if (window.moaAPI.onAllDone) {
      unsubs.push(window.moaAPI.onAllDone((_data: { conversationId: string; conversations: unknown[] }) => {
        cleanupIfCurrent()
        // Keep the liveSubOutputs and aggregatorText for display
        // Refresh conversations list
        get().refreshConversations()

        // ── Auto-trigger title generation (fire-and-forget, non-blocking) ──
        window.moaAPI.getSettings().then((settingsRes: any) => {
          if (!settingsRes.success) return
          const titleSettings = settingsRes.data?.title as TitleSettings | undefined
          if (!titleSettings) return
          // Read fresh state inside async callback to avoid stale closure
          const currentState = get()
          const cId = _data.conversationId || currentState.currentConversationId
          if (!cId) return
          const conv = currentState.conversations.find((c) => c.id === cId)
          if (!conv) return

          // Guard: never overwrite user-edited titles
          if (conv.titleEdited) return

          // ── Branch A: First-time generation ──
          const isDefaultTitle = !conv.title || conv.title === '新对话'
          const isFirstAllowed = titleSettings.autoMode === 'first_reply'
            || titleSettings.autoMode === 'first_and_manual'
          if (isDefaultTitle && isFirstAllowed) {
            get().generateAndSetTitle(cId, currentState.messages, titleSettings)
            return
          }

          // ── Branch B: Realtime update ──
          // Only trigger when realtime mode is enabled and a title already exists
          if (!isDefaultTitle && titleSettings.realtimeMode !== 'off') {
            if (titleSettings.realtimeMode === 'every_reply') {
              get().generateAndSetTitle(cId, currentState.messages, titleSettings)
            } else if (titleSettings.realtimeMode === 'every_n_rounds' && titleSettings.realtimeN > 0) {
              // A "round" = one user question + one assistant reply = 2 messages
              // Check if the message count is divisible by (realtimeN * 2)
              const msgCount = currentState.messages.length
              if (msgCount > 0 && msgCount % (titleSettings.realtimeN * 2) === 0) {
                get().generateAndSetTitle(cId, currentState.messages, titleSettings)
              }
            }
          }
        }).catch(() => {})
      }))
    }

    // 3. Save the cleanup function (for view switching cleanup)
    set({ liveCleanupRef: cleanup })

    // 4. Optimistic: add user message locally (no conversationId yet for new conversations)
    const tempId = crypto.randomUUID()
    const userMsg: ChatMessage = {
      id: tempId,
      conversationId: currentConversationId || '',
      role: 'user',
      content,
      mode,
      timestamp: Date.now()
    }

    set((state) => ({
      messages: [...state.messages, userMsg],
      loading: true,
      error: null
    }))

    // 5. Call backend (existing code continues for backward compatibility)
    try {
      const res = await window.moaAPI.sendMessage({
        conversationId: currentConversationId || undefined,
        content,
        mode
      })

      if (res.success) {
        const data = res.data as {
          conversationId: string
          moaResult: { content: string; subOutputs?: SubModelOutput[]; error?: string; success?: boolean }
          conversations: any[]
        }

        const moaResult = data.moaResult

        // Build assistant message content from moaResult
        let content: string
        if (moaResult.success) {
          content = moaResult.content
            ? moaResult.content
            : moaResult.subOutputs?.length
              ? `已调用 ${moaResult.subOutputs.length} 个子模型`
              : '(模型返回了空内容)'
        } else {
          // Use error from moaResult, or moaResult.content as fallback
          content = moaResult.error || moaResult.content || '请求失败'
        }

        // Patch the optimistic user message's conversationId
        const patchedMessages = get().messages.map((m) =>
          m.id === tempId && (!m.conversationId || m.conversationId === '')
            ? { ...m, conversationId: data.conversationId }
            : m
        )

        const asstMsg: ChatMessage = {
          id: crypto.randomUUID(),
          conversationId: data.conversationId,
          role: 'assistant',
          content,
          mode,
          subModelOutputs: moaResult.subOutputs,
          timestamp: Date.now()
        }

        const convs = ((data.conversations || []) as any[]).map(convFromRow)

        set((state) => ({
          messages: [...patchedMessages, asstMsg],
          conversations: convs,
          currentConversationId: data.conversationId || state.currentConversationId,
          loading: false
        }))
      } else {
        set({ error: String(res.error || '请求失败'), loading: false })
      }
    } catch (err) {
      cleanupIfCurrent()
      set({ error: String(err), loading: false })
    } finally {
      set({ loading: false })
    }
  },

  // ── Cleanup live events externally (e.g., when switching views) ──
  cleanupLiveEvents: () => {
    const cleanup = get().liveCleanupRef
    if (cleanup) {
      cleanup()
      set({ liveCleanupRef: null })
    }
  },

  // ── Title actions ──
  updateConversationTitle: async (id, title, titleEdited) => {
    try {
      const res = await window.moaAPI.updateConversationTitle(id, title, titleEdited)
      if (res.success) {
        const convs = ((res.conversations || []) as any[]).map(convFromRow)
        set({ conversations: convs })
      }
    } catch (err) {
      console.error('[Title] updateConversationTitle failed:', err)
    }
  },

  generateAndSetTitle: async (id, messages, titleSettings) => {
    if (!titleSettings.providerId || !titleSettings.modelId) return
    const { titleLoading } = get()
    if (titleLoading[id]) return // Already generating

    set((state) => ({
      titleLoading: { ...state.titleLoading, [id]: true }
    }))

    try {
      const res = await window.moaAPI.generateTitle({
        conversationId: id,
        messages,
        providerId: titleSettings.providerId,
        modelId: titleSettings.modelId,
        maxLength: titleSettings.maxLength || 50,
        language: titleSettings.language || 'auto'
      })

      if (res.success && res.title) {
        await get().updateConversationTitle(id, res.title, false)
      } else if (res.error) {
        console.error('[Title] generateAndSetTitle error:', res.error)
        set({ error: `标题生成失败：${res.error}` })
      }
    } catch (err) {
      console.error('[Title] generateAndSetTitle exception:', err)
      set({ error: `标题生成异常：${String(err)}` })
    } finally {
      set((state) => {
        const next = { ...state.titleLoading }
        delete next[id]
        return { titleLoading: next }
      })
    }
  }
}))
