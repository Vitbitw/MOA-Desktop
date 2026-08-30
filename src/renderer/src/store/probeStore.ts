import { create } from 'zustand'
import type { ProbeProgressEvent } from '../../../shared/types'

/**
 * 定价探查运行状态（全局）。
 * 放在全局 store 是为了在切换页面/组件卸载后仍能保留"探查中"状态，
 * 切回定价页时正确显示 busy / runningIds / messages / progress。
 */
interface ProbeState {
  busy: boolean
  runningIds: Set<string>
  messages: Record<string, string>
  /** 当前探查进度（main 进程实时推送） */
  progress: ProbeProgressEvent | null
  setBusy: (busy: boolean) => void
  setRunningIds: (ids: Set<string>) => void
  setMessages: (messages: Record<string, string>) => void
  setProgress: (progress: ProbeProgressEvent | null) => void
  reset: () => void
}

export const useProbeStore = create<ProbeState>((set) => ({
  busy: false,
  runningIds: new Set(),
  messages: {},
  progress: null,
  setBusy: (busy) => set({ busy }),
  setRunningIds: (runningIds) => set({ runningIds }),
  setMessages: (messages) => set({ messages }),
  setProgress: (progress) => set({ progress }),
  reset: () => set({ busy: false, runningIds: new Set(), messages: {}, progress: null })
}))
