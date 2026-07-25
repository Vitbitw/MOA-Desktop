import { create } from 'zustand'
import type { Conversation, ChatMessage, MoAMode, SubModelOutput } from '../../../shared/types'

/** Factory: convert DB row to Conversation type. */
function convFromRow(c: any): Conversation {
  return {
    id: c.id,
    title: c.title || '',
    mode: c.mode || 'aggregate',
    subModels: c.sub_models ? JSON.parse(c.sub_models) : [],
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    messageCount: c.message_count || 0
  }
}

interface ConversationState {
  conversations: Conversation[]
  currentConversationId: string | null
  messages: ChatMessage[]
  mode: MoAMode
  loading: boolean
  error: string | null

  setConversations: (convs: Conversation[]) => void
  setCurrentConversation: (id: string | null) => void
  setMessages: (msgs: ChatMessage[]) => void
  addMessage: (msg: ChatMessage) => void
  setMode: (mode: MoAMode) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void

  // Async actions
  sendMessage: (content: string) => Promise<void>
  selectConversation: (id: string) => Promise<void>
  newConversation: () => void
  deleteConversation: (id: string) => Promise<void>
  refreshConversations: () => Promise<void>
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: [],
  currentConversationId: null,
  messages: [],
  mode: 'aggregate',
  loading: false,
  error: null,

  setConversations: (conversations) => set({ conversations }),
  setCurrentConversation: (currentConversationId) => set({ currentConversationId }),
  setMessages: (messages) => set({ messages }),
  addMessage: (msg) => set((state) => ({ messages: [...state.messages, msg] })),
  setMode: (mode) => set({ mode }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),

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

    // Optimistic: add user message locally (no conversationId yet for new conversations)
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
      set({ error: String(err), loading: false })
    } finally {
      set({ loading: false })
    }
  }
}))
