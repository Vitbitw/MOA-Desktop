import { create } from 'zustand'
import type { ProbeProgressEvent } from '../../../shared/types'

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
