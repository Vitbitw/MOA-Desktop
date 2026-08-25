import { create } from 'zustand'
import type { LocalEngine, LocalModel, DownloadProgress, HfSearchResult, RuntimeState, LaunchConfig } from '../../../shared/types'
import { DEFAULT_LAUNCH_CONFIG } from '../../../shared/types'

interface LocalModelState {
  engines: LocalEngine[]
  models: LocalModel[]
  searchResults: HfSearchResult[]
  searching: boolean
  downloads: Record<string, DownloadProgress>
  runtime: RuntimeState | null
  loadingEngines: boolean
  loadingModels: boolean
  error: string | null
  initialized: boolean

  init: () => Promise<void>
  dispose: () => void
  loadEngines: () => Promise<void>
  loadModels: () => Promise<void>
  loadRuntime: () => Promise<void>
  detectEngines: () => Promise<void>
  addManualEngine: (baseUrl: string) => Promise<boolean>
  removeEngine: (id: string) => Promise<void>
  searchHf: (query: string) => Promise<void>
  startDownload: (params: { repo: string; file: string; sizeBytes?: number; quantization?: string }) => Promise<void>
  cancelDownload: (jobId: string) => Promise<void>
  deleteLocalModel: (id: string) => Promise<void>
  startEngine: (modelId: string) => Promise<void>
  stopEngine: () => Promise<void>
  ensureRuntime: (backend?: string) => Promise<void>
  getLaunchConfig: (modelId: string) => Promise<LaunchConfig>
  setLaunchConfig: (modelId: string, config: LaunchConfig) => Promise<void>
  setError: (msg: string | null) => void
}

let unsubDownload: (() => void) | null = null
let unsubEngine: (() => void) | null = null

export const useLocalModelStore = create<LocalModelState>((set, get) => ({
  engines: [],
  models: [],
  searchResults: [],
  searching: false,
  downloads: {},
  runtime: null,
  loadingEngines: false,
  loadingModels: false,
  error: null,
  initialized: false,

  init: async () => {
    // 幂等：已初始化则跳过（防 StrictMode 双挂 / 重复调用重复订阅）
    if (get().initialized) return
    set({ initialized: true })

    // 事件订阅（unsubscribe 存模块级，dispose 用）
    unsubDownload = window.moaAPI.onDownloadProgress((data: unknown) => {
      // 载荷判别：DownloadProgress 有 jobId/modelId 字段
      const p = data as DownloadProgress
      if (!p || typeof p.jobId !== 'string') return
      // 按 jobId 键控（modelId 只是文件名 basename，跨 repo 同名会碰撞，不可做反向匹配）
      set((s) => ({ downloads: { ...s.downloads, [p.jobId]: p } }))
      // 终态后刷新模型列表（下载中 → 已下载/取消/失败的状态同步）
      if (p.status === 'done' || p.status === 'cancelled' || p.status === 'error') {
        void get().loadModels()
      }
    })

    unsubEngine = window.moaAPI.onEngineStatusChanged((data: unknown) => {
      // 双载荷判别：先判数组（Task 3 启动探测的 DetectedEngine[]）
      if (Array.isArray(data)) {
        // 主进程探测完成广播 → 刷新引擎列表（防 loadEngines 跑在探测完成前的竞态窗口）
        void get().loadEngines()
        return
      }
      // 单对象载荷：{ engineType: 'bundled', ...runtimeState }
      const d = data as { engineType?: string } & RuntimeState
      if (d && d.engineType === 'bundled') {
        const { engineType, ...runtimeState } = d
        void engineType // 显式消费，防 noUnusedLocals（TS 不豁免下划线前缀局部变量）
        set({ runtime: runtimeState })
      }
      // 其他形状：忽略
    })

    // 初始加载：引擎/模型/运行时三路并行
    await Promise.all([get().loadEngines(), get().loadModels(), get().loadRuntime()])
  },

  dispose: () => {
    unsubDownload?.()
    unsubDownload = null
    unsubEngine?.()
    unsubEngine = null
    set({ initialized: false })
  },

  loadEngines: async () => {
    set({ loadingEngines: true })
    try {
      const res = await window.moaAPI.listLocalEngines()
      if (res.success) set({ engines: res.data })
      else set({ error: String(res.error || '加载引擎失败') })
    } catch (err) {
      set({ error: String(err) })
    } finally {
      set({ loadingEngines: false })
    }
  },

  loadModels: async () => {
    set({ loadingModels: true })
    try {
      const res = await window.moaAPI.listLocalModels()
      if (res.success) set({ models: res.data })
      else set({ error: String(res.error || '加载模型失败') })
    } catch (err) {
      set({ error: String(err) })
    } finally {
      set({ loadingModels: false })
    }
  },

  loadRuntime: async () => {
    try {
      const res = await window.moaAPI.getRuntimeState()
      if (res.success) set({ runtime: res.data })
      // 失败不 set error：runtime 未安装/未下载是合法业务态，不是错误
    } catch { /* 保留 null，同左 */ }
  },

  detectEngines: async () => {
    try {
      const res = await window.moaAPI.detectLocalEngines()
      if (res.success) {
        await get().loadEngines()
      } else {
        set({ error: String(res.error || '引擎探测失败') })
      }
    } catch (err) {
      set({ error: String(err) })
    }
  },

  addManualEngine: async (baseUrl: string) => {
    try {
      const res = await window.moaAPI.addManualEngine(baseUrl)
      if (res.success) {
        await get().loadEngines()
        return true
      }
      set({ error: String(res.error || '添加引擎失败') })
      return false
    } catch (err) {
      set({ error: String(err) })
      return false
    }
  },

  removeEngine: async (id: string) => {
    try {
      const res = await window.moaAPI.removeLocalEngine(id)
      if (!res.success) set({ error: String(res.error || '删除引擎失败') })
      await get().loadEngines()
    } catch (err) {
      set({ error: String(err) })
    }
  },

  searchHf: async (query: string) => {
    set({ searching: true })
    try {
      const res = await window.moaAPI.searchHf(query)
      if (res.success) set({ searchResults: res.data as HfSearchResult[] })
      else set({ error: String(res.error || '搜索失败') })
    } catch (err) {
      set({ error: String(err) })
    } finally {
      set({ searching: false })
    }
  },

  startDownload: async (params: { repo: string; file: string; sizeBytes?: number; quantization?: string }) => {
    try {
      const res = await window.moaAPI.startDownload(params)
      if (res.success) {
        // 触发 loadModels 让「下载中」条目入列
        await get().loadModels()
      } else {
        set({ error: String(res.error || '开始下载失败') })
      }
    } catch (err) {
      set({ error: String(err) })
    }
  },

  cancelDownload: async (jobId: string) => {
    try {
      const res = await window.moaAPI.cancelDownload(jobId)
      if (!res.success) set({ error: String(res.error || '取消下载失败') })
    } catch (err) {
      set({ error: String(err) })
    }
  },

  deleteLocalModel: async (id: string) => {
    try {
      const res = await window.moaAPI.deleteLocalModel(id)
      if (!res.success) set({ error: String(res.error || '删除模型失败') })
      await get().loadModels()
    } catch (err) {
      set({ error: String(err) })
    }
  },

  startEngine: async (modelId: string) => {
    // 注意：wire 实参 = LocalModel.id（UUID 主键）！preload 形参 modelId 实际承载主键，非推理名
    try {
      const res = await window.moaAPI.startEngine(modelId)
      if (res.success) {
        // 引擎状态由事件驱动更新 runtime；模型列表状态刷新
        await get().loadModels()
      } else {
        set({ error: String(res.error || '启动引擎失败') })
      }
    } catch (err) {
      set({ error: String(err) })
    }
  },

  stopEngine: async () => {
    try {
      const res = await window.moaAPI.stopEngine()
      if (!res.success) set({ error: String(res.error || '停止引擎失败') })
    } catch (err) {
      set({ error: String(err) })
    }
  },

  ensureRuntime: async (backend?: string) => {
    try {
      const res = await window.moaAPI.ensureRuntime(backend)
      if (res.success) set({ runtime: res.data })
      else set({ error: String(res.error || '运行时就绪失败') })
    } catch (err) {
      set({ error: String(err) })
    }
  },

  getLaunchConfig: async (modelId: string) => {
    try {
      const res = await window.moaAPI.getLaunchConfig(modelId)
      if (res.success) return res.data as LaunchConfig
    } catch { /* 用默认 */ }
    return { ...DEFAULT_LAUNCH_CONFIG }
  },

  setLaunchConfig: async (modelId: string, config: LaunchConfig) => {
    try {
      const res = await window.moaAPI.setLaunchConfig(modelId, config)
      if (!res.success) set({ error: String(res.error || '保存启动配置失败') })
    } catch (err) {
      set({ error: String(err) })
    }
  },

  setError: (msg) => set({ error: msg })
}))
