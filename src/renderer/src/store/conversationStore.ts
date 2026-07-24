import { create } from 'zustand'
import type { Conversation, ChatMessage, MoAMode, SubModelOutput } from '../../../shared/types'

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

  selectConversation: async (id) => {
    set({ loading: true, error: null })
    try {
      const res = await window.moaAPI.getMessages(id)
      if (res.success) {
        const msgs = (res.data as any[]).map((m: any) => ({
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

  sendMessage: async (content) => {
    const { mode, currentConversationId } = get()
    if (!content.trim()) return

    // Optimistic: add user message locally
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
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
          moaResult: { content: string; subOutputs?: SubModelOutput[] }
          conversations: any[]
        }

        // Patch the optimistic user message's conversationId
        const patchedMessages = get().messages.map((m) =>
          m.role === 'user' && (!m.conversationId || m.conversationId === '')
            ? { ...m, conversationId: data.conversationId }
            : m
        )

        const asstMsg: ChatMessage = {
          id: crypto.randomUUID(),
          conversationId: data.conversationId,
          role: 'assistant',
          content: data.moaResult.content || '(空响应)',
          mode,
          subModelOutputs: data.moaResult.subOutputs,
          timestamp: Date.now()
        }

        const convs = (data.conversations || []).map((c: any) => ({
          id: c.id,
          title: c.title,
          mode: c.mode as MoAMode,
          subModels: [],
          createdAt: c.created_at,
          updatedAt: c.updated_at,
          messageCount: c.message_count
        }))

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
    }
  }
}))
