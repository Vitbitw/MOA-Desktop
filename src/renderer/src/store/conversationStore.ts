import { create } from 'zustand'
import type { Conversation, ChatMessage, MoAMode } from '../../../shared/types'

interface ConversationState {
  conversations: Conversation[]
  currentConversationId: string | null
  messages: ChatMessage[]
  mode: MoAMode
  loading: boolean
  setConversations: (convs: Conversation[]) => void
  setCurrentConversation: (id: string | null) => void
  setMessages: (msgs: ChatMessage[]) => void
  addMessage: (msg: ChatMessage) => void
  setMode: (mode: MoAMode) => void
  setLoading: (loading: boolean) => void
}

export const useConversationStore = create<ConversationState>((set) => ({
  conversations: [],
  currentConversationId: null,
  messages: [],
  mode: 'aggregate',
  loading: false,
  setConversations: (conversations) => set({ conversations }),
  setCurrentConversation: (currentConversationId) => set({ currentConversationId }),
  setMessages: (messages) => set({ messages }),
  addMessage: (msg) => set((state) => ({ messages: [...state.messages, msg] })),
  setMode: (mode) => set({ mode }),
  setLoading: (loading) => set({ loading })
}))
