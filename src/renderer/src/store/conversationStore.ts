import { create } from 'zustand'
import type { Conversation, ChatMessage, MoAMode, SubModelOutput, SubOutputUpdate, AggregationChunk, TitleSettings } from '../../../shared/types'
import { useNotificationStore } from './notificationStore'

/** 自动标题生成前的 token 消耗预警（执行前弹悬浮通知，仅告知不阻止） */
function notifyAutoTitleCost(titleSettings: TitleSettings): void {
  useNotificationStore.getState().push({
    type: 'warning',
    title: '自动标题生成将消耗 Token',
    message: titleSettings.modelId
      ? `即将调用 "${titleSettings.modelId}" 生成对话标题，将产生 Token 消耗`
      : '即将调用大模型生成对话标题，将产生 Token 消耗'
  })
}

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
  role?: string
}

/** DB conversations 表行结构 */
interface ConversationRow {
  id: string
  title?: string | null
  mode?: string | null
  sub_models?: string | null
  created_at: number
  updated_at: number
  message_count?: number | null
  title_edited?: number | null
}

/** Factory: convert DB row to Conversation type. */
export function convFromRow(c: ConversationRow): Conversation {
  return {
    id: c.id,
    title: c.title || '',
    mode: (c.mode as Conversation['mode']) || 'aggregate',
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
  /** 发送失败被回滚的用户草稿（InputBox 回填后清空）；null = 无待回填草稿 */
  failedDraft: string | null
  /** 会话切换序号：newConversation/selectConversation 递增；发送流程据此判定等待期用户是否切走（F4） */
  convSwitchSeq: number

  // ── Title generation ──
  titleLoading: Record<string, boolean>

  setConversations: (convs: Conversation[]) => void
  setCurrentConversation: (id: string | null) => void
  setMessages: (msgs: ChatMessage[]) => void
  addMessage: (msg: ChatMessage) => void
  setMode: (mode: MoAMode) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  setFailedDraft: (draft: string | null) => void

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
  /** 自动标题（首次 + 实时更新）：须在消息已更新的时机调用，避免基于旧快照生成 */
  maybeAutoTitle: (conversationId: string, messages: ChatMessage[]) => void
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: [],
  currentConversationId: null,
  messages: [],
  mode: 'aggregate',
  loading: false,
  error: null,
  failedDraft: null,
  convSwitchSeq: 0,
  titleLoading: {},

  setConversations: (conversations) => set({ conversations }),
  setCurrentConversation: (currentConversationId) => set({ currentConversationId }),
  setMessages: (messages) => set({ messages }),
  addMessage: (msg) => set((state) => ({ messages: [...state.messages, msg] })),
  setMode: (mode) => set({ mode }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setFailedDraft: (failedDraft) => set({ failedDraft }),

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

  newConversation: () => {
    // 新建会话时同步清空 live 展示，避免监控视图残留上一会话的运行数据（F3）
    get().clearLiveState()
    set((state) => ({ currentConversationId: null, messages: [], convSwitchSeq: state.convSwitchSeq + 1 }))
  },

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
      // 后台刷新失败保持旧列表即可（下次操作会自然重试）
    }
  },

  selectConversation: async (id) => {
    // 切换会话即结束上一会话的 live 展示，监控视图回到历史视图（F3）
    get().clearLiveState()
    set((state) => ({ loading: true, error: null, convSwitchSeq: state.convSwitchSeq + 1 }))
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
      // 删除失败保持现状（列表未刷新），用户可重试
    }
  },

  sendMessage: async (content) => {
    const { mode, currentConversationId } = get()
    if (!content.trim()) return

    // 0. 每次请求唯一 ID：防止上一次 onAllDone 的 cleanup 清掉本次请求的监听
    //    （连续快速发两条消息时，第一次的 onAllDone 会 cleanup 掉第二次刚注册的监听）
    const requestId = crypto.randomUUID()

    // 请求发起时的会话切换序号快照：响应回来时据此判断用户是否已切换/新建会话（F4）。
    // 用序号而非会话 id 比较——「新会话首发（null）」与「期间又点新建（仍 null）」无法用 id 区分
    const snapshotSwitchSeq = get().convSwitchSeq

    // 1. Clear previous live state（live 复位统一走 clearLiveState，避免两处各写一份字段）
    set({ error: null, liveCleanupRef: null })
    get().clearLiveState()

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
        const patch = {
          content: data.content,
          status: data.status,
          error: data.error,
          durationMs: data.durationMs,
          tokenUsage: data.tokenUsage,
          role: data.role
        }
        if (existing) {
          get().updateLiveSubOutput(data.index, patch)
        } else {
          set((state) => ({
            // F10：插入后按 index 升序，面板顺序固定为配置顺序而非子模型完成顺序
            liveSubOutputs: [...state.liveSubOutputs, {
              index: data.index,
              modelId: data.modelId,
              providerId: data.providerId,
              content: data.content,
              status: data.status as LiveSubOutput['status'],
              error: data.error,
              durationMs: data.durationMs,
              tokenUsage: data.tokenUsage,
              role: data.role
            }].sort((a, b) => a.index - b.index)
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
        // 仅刷新会话列表；标题自动生成移到 sendMessage 响应分支执行——
        // 事件先于 invoke 响应到达时 messages 还不含本轮 assistant 回复，
        // 在此触发会基于不完整上下文生成标题。
        get().refreshConversations()
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

    /**
     * 发送失败统一收尾（F2）：释放本轮 IPC 监听并复位聚合运行标记；
     * 未切走时回滚乐观 user 消息、把内容写入 failedDraft 供 InputBox 回填；
     * 已切走时只报错并刷新列表，不触碰当前视图（F4）。
     */
    const settleFailure = (message: string) => {
      cleanupIfCurrent()
      if (get().convSwitchSeq !== snapshotSwitchSeq) {
        set({ error: message, loading: false, aggregatorRunning: false })
        get().refreshConversations()
        return
      }
      set((state) => ({
        messages: state.messages.filter((m) => m.id !== tempId),
        failedDraft: content,
        error: message,
        loading: false,
        aggregatorRunning: false
      }))
    }

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

        // F4：请求在途时用户已切换/新建会话 → 仅刷新会话列表；不注入消息、
        // 不回跳 currentConversationId、不生成标题（否则本次回复会串进别的会话视图与标题）
        if (get().convSwitchSeq !== snapshotSwitchSeq) {
          get().clearLiveState()
          await get().refreshConversations()
          return
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

        // F3：本轮已完成，清空 live 状态 → hasLive=false，监控面板回到历史视图展示刚完成的轮次
        get().clearLiveState()

        // ── 自动标题生成（fire-and-forget）──
        // 此时 messages 已含本轮 assistant 回复，上下文完整；
        // 主进程 first_message 路径与 renderer first_reply/first_and_manual 路径互斥，不会重复生成。
        const finalMessages = [...patchedMessages, asstMsg]
        get().maybeAutoTitle(data.conversationId, finalMessages)
      } else {
        // F2：失败路径同样要释放监听并复位聚合运行标记，否则「生成中/运行中」会永久卡住
        settleFailure(String(res.error || '请求失败'))
      }
    } catch (err) {
      settleFailure(String(err))
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
  },

  // 自动标题触发逻辑（首次 + 实时）；renderer 端 first_reply/first_and_manual 在此统一处理，
  // 主进程仅负责 first_message（见 index.ts）。messages 参数为已含本轮回复的最新消息。
  maybeAutoTitle: async (conversationId, messages) => {
    try {
      const settingsRes = await window.moaAPI.getSettings()
      if (!settingsRes.success) return
      const titleSettings = (settingsRes.data as { title?: TitleSettings } | undefined)?.title
      if (!titleSettings) return
      if (!conversationId) return
      const conv = get().conversations.find((c) => c.id === conversationId)
      if (!conv) return
      // Guard: never overwrite user-edited titles
      if (conv.titleEdited) return

      // ── Branch A: First-time generation ──
      const isDefaultTitle = !conv.title || conv.title === '新对话'
      const isFirstAllowed = titleSettings.autoMode === 'first_reply'
        || titleSettings.autoMode === 'first_and_manual'
      if (isDefaultTitle && isFirstAllowed) {
        notifyAutoTitleCost(titleSettings)
        get().generateAndSetTitle(conversationId, messages, titleSettings)
        return
      }

      // ── Branch B: Realtime update ──
      if (!isDefaultTitle && titleSettings.realtimeMode !== 'off') {
        if (titleSettings.realtimeMode === 'every_reply') {
          notifyAutoTitleCost(titleSettings)
          get().generateAndSetTitle(conversationId, messages, titleSettings)
        } else if (titleSettings.realtimeMode === 'every_n_rounds' && titleSettings.realtimeN > 0) {
          // A "round" = one user question + one assistant reply = 2 messages
          const msgCount = messages.length
          if (msgCount > 0 && msgCount % (titleSettings.realtimeN * 2) === 0) {
            notifyAutoTitleCost(titleSettings)
            get().generateAndSetTitle(conversationId, messages, titleSettings)
          }
        }
      }
    } catch {
      // 标题生成失败不影响主流程
    }
  }
}))
