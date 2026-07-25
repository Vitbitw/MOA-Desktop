import { create } from 'zustand'
import type { AppSettings } from '../../../shared/types'
import { DEFAULT_SETTINGS } from '../../../shared/defaults'

interface SettingsState {
  settings: AppSettings
  loaded: boolean
  loadSettings: () => Promise<void>
  setSettings: (settings: AppSettings) => void
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
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

  updateSetting: (key, value) => {
    set((state) => ({
      settings: { ...state.settings, [key]: value }
    }))
    // Persist to main process (fire-and-forget)
    window.moaAPI.setSetting(key, value).catch(() => {})
  }
}))
