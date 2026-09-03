// ─── 全局悬浮通知（Toast）store ───
// 职责：
//   1. 统一管理右下角悬浮通知的入队/堆叠/自动消失
//   2. 供渲染进程各处（conversationStore / SettingsPanel / 主进程推送等）push
// 约定：
//   - duration <= 0 时不自动消失（交由用户手动关闭，当前无此场景，预留）
//   - 超出最大可见数时丢弃最旧的（slice 截尾）
import { create } from 'zustand'
import type { ToastData, ToastType } from '../../../shared/types'

export type { ToastType }

export interface ToastItem extends ToastData {
  id: string
  createdAt: number
}

const DEFAULT_DURATION_MS = 4500
const MAX_VISIBLE = 4

interface NotificationState {
  toasts: ToastItem[]
  push: (data: ToastData) => void
  dismiss: (id: string) => void
  clear: () => void
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  toasts: [],
  push: (data) => {
    const id = crypto.randomUUID()
    const duration = data.duration ?? DEFAULT_DURATION_MS
    set((state) => ({
      toasts: [
        ...state.toasts,
        { ...data, id, createdAt: Date.now() }
      ].slice(-MAX_VISIBLE)
    }))
    if (duration > 0) {
      setTimeout(() => get().dismiss(id), duration)
    }
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] })
}))