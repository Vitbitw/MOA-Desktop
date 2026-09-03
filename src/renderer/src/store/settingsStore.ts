import { create } from 'zustand'
import type { AppSettings } from '../../../shared/types'
import { DEFAULT_SETTINGS } from '../../../shared/defaults'
import { useNotificationStore } from './notificationStore'

interface SettingsState {
  settings: AppSettings
  loaded: boolean
  loadSettings: () => Promise<void>
  setSettings: (settings: AppSettings) => void
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>
  /** 由带保存按钮的模块（如 MoA 配置）在保存完成后上报结果，统一以悬浮通知提示 */
  notifySaveResult: (ok: boolean, error?: string) => void
}

/** 保存成功/失败 → 右下角全局悬浮通知（沿用统一 Toast 风格） */
function pushSaveToast(ok: boolean, error?: string): void {
  useNotificationStore.getState().push({
    type: ok ? 'success' : 'error',
    title: ok ? '设置已保存' : '保存失败',
    message: ok ? undefined : (error || '未知错误'),
    // 保存行为高频且轻量，成功提示短留避免打扰；失败保留默认时长便于阅读
    duration: ok ? 2000 : undefined
  })
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  loadSettings: async () => {
    try {
      const res = await window.moaAPI.getSettings()
      if (res.success && res.data) {
        set({ settings: { ...DEFAULT_SETTINGS, ...(res.data as Partial<AppSettings>) }, loaded: true })
      }
    } catch {
      // fallback to defaults
      set({ loaded: true })
    }
  },

  setSettings: (settings) => set({ settings }),

  updateSetting: async (key, value) => {
    // 先更新本地状态（即时反馈），再持久化到主进程
    set({ settings: { ...get().settings, [key]: value } })
    try {
      const res = await window.moaAPI.setSetting(key, value)
      pushSaveToast(res.success, res.error || undefined)
    } catch (err) {
      pushSaveToast(false, String(err))
    }
  },

  notifySaveResult: (ok, error) => pushSaveToast(ok, error)
}))