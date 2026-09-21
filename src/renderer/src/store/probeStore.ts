import { create } from 'zustand'
import type { PricingProbeResultItem, PricingProbeState, ProbeProgressEvent } from '../../../shared/types'
import { useSettingsStore } from './settingsStore'

/** 定价表格可排序字段 */
export type PricingSortKey = 'modelId' | 'input' | 'output' | 'cacheRead' | 'cacheCreation'
export type PricingSortDir = 'asc' | 'desc'
export interface PricingSortState {
  key: PricingSortKey
  dir: PricingSortDir
}

/**
 * 定价探查相关 UI 状态（全局）。
 * 放在全局 store 是为了在切换页面/组件卸载后仍能保留状态：
 * - busy / runningIds / messages / progress：探查运行状态
 * - collapsed：各源内「模型列表」的折叠状态
 * - sorts：各源内表格的排序状态（按模型 ID / 输入 / 输出 / 缓存读 / 缓存写）
 */
interface ProbeState {
  busy: boolean
  runningIds: Set<string>
  messages: Record<string, string>
  /** 当前探查进度（main 进程实时推送） */
  progress: ProbeProgressEvent | null
  /** 已折叠模型列表的源 id 集合 */
  collapsed: Set<string>
  /** 各源表格排序：sourceId → 当前排序字段与方向 */
  sorts: Record<string, PricingSortState>
  setBusy: (busy: boolean) => void
  setRunningIds: (ids: Set<string>) => void
  setMessages: (messages: Record<string, string>) => void
  setProgress: (progress: ProbeProgressEvent | null) => void
  toggleCollapsed: (sourceId: string) => void
  /** 点击表头切换排序：同列切换方向，新列默认升序 */
  setSort: (sourceId: string, key: PricingSortKey) => void
  reset: () => void
}

export const useProbeStore = create<ProbeState>((set) => ({
  busy: false,
  runningIds: new Set(),
  messages: {},
  progress: null,
  collapsed: new Set(),
  sorts: {},
  setBusy: (busy) => set({ busy }),
  setRunningIds: (runningIds) => set({ runningIds }),
  setMessages: (messages) => set({ messages }),
  setProgress: (progress) => set({ progress }),
  toggleCollapsed: (sourceId) =>
    set((s) => {
      const next = new Set(s.collapsed)
      if (next.has(sourceId)) {
        next.delete(sourceId)
      } else {
        next.add(sourceId)
      }
      return { collapsed: next }
    }),
  setSort: (sourceId, key) =>
    set((s) => {
      const cur = s.sorts[sourceId]
      const next: PricingSortState =
        cur && cur.key === key
          ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
          : { key, dir: 'asc' }
      return { sorts: { ...s.sorts, [sourceId]: next } }
    }),
  reset: () =>
    set({ busy: false, runningIds: new Set(), messages: {}, progress: null, collapsed: new Set(), sorts: {} })
}))

/** 探查结果 → 各源提示文案（设置页手动探查与全局状态订阅共用）；键为源 id */
export function probeResultsToMessages(results: PricingProbeResultItem[]): Record<string, string> {
  const messages: Record<string, string> = {}
  for (const r of results) {
    messages[r.sourceId] = r.ok
      ? r.skipped
        ? `页面无变化（沿用 ${r.entryCount} 条）`
        : `已更新 ${r.entryCount} 条定价`
      : `失败：${r.error}`
  }
  return messages
}

/**
 * 订阅 main 进程的探查运行状态（App 挂载时调用一次，返回退订函数）。
 *
 * 必须全局订阅而非在定价页内订阅：探查可能在页面卸载后开始/结束（如后台自动刷新），
 * 页面内订阅会漏掉这些事件，把 busy 卡在错误状态（表现为「不显示刷新中」或按钮长期禁用）。
 * 订阅建立前先查询一次当前状态，覆盖订阅注册前已开始的后台自动刷新。
 */
export function initProbeStateSubscription(): () => void {
  const apply = (s: PricingProbeState): void => {
    const st = useProbeStore.getState()
    if (s.running) {
      st.setBusy(true)
      st.setRunningIds(new Set(s.sourceIds))
      return
    }
    st.setBusy(false)
    st.setRunningIds(new Set())
    st.setProgress(null)
    // 后台自动刷新：结果文案与数据刷新在此补上（手动探查由 runProbe 自行处理）
    if (s.trigger === 'auto') {
      if (s.results && s.results.length > 0) st.setMessages(probeResultsToMessages(s.results))
      void useSettingsStore.getState().loadSettings()
    }
  }
  // 查询当前状态：仅在「正在运行」时应用，避免与本地刚触发的探查响应互相覆盖
  void window.moaAPI.getProbeStatus().then((res) => {
    if (res.success && res.data?.running) apply(res.data)
  })
  // 进度事件同在此订阅：定价页打开前发生的进度也不丢（页面直接读 store）
  const offProgress = window.moaAPI.onProbeProgress((p) => useProbeStore.getState().setProgress(p))
  const offState = window.moaAPI.onProbeState(apply)
  return () => {
    offProgress()
    offState()
  }
}
