import React, { useEffect, useState } from 'react'
import { Plus, RefreshCw, Trash2, Download, Square, X } from 'lucide-react'
import { useLocalModelStore } from '../store/localModelStore'
import { useConfigStore } from '../store/configStore'
import type { LocalEngine } from '../../../shared/types'

/**
 * 内置运行时卡（llama.cpp / bundled）。
 * 数据源 = runtime（RuntimeState），永远可见（引擎行在首启前不存在于 engines）。
 * 状态词表 = RuntimeStatus：not-installed | downloading | ready | running | error
 * 职责 = ensureRuntime（下载/重试）+ 状态展示 + 停止（仅 running）。
 * 注意：无启动按钮——start 归 6d（模型列表行内「启动」）。
 */
function RuntimeCard() {
  const runtime = useLocalModelStore((s) => s.runtime)
  const ensureRuntime = useLocalModelStore((s) => s.ensureRuntime)
  const stopEngine = useLocalModelStore((s) => s.stopEngine)
  const setError = useLocalModelStore((s) => s.setError)
  const [busy, setBusy] = useState(false)

  const handleEnsure = async () => {
    setError(null)
    setBusy(true)
    try { await ensureRuntime() } finally { setBusy(false) }
  }

  const handleStop = async () => {
    setError(null)
    setBusy(true)
    try { await stopEngine() } finally { setBusy(false) }
  }

  return (
    <div className="rounded-lg border border-border p-3 text-sm space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="font-medium text-foreground">内置运行时（llama.cpp）</span>
        <span className="text-xs text-muted-foreground">bundled</span>
      </div>

      {/* not-installed：下载入口 */}
      {(!runtime || runtime.status === 'not-installed') && (
        <button
          onClick={handleEnsure}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-xs font-medium hover:opacity-90 disabled:opacity-50"
        >
          <Download className="w-3.5 h-3.5" />
          {busy ? '处理中...' : '下载运行时'}
        </button>
      )}

      {/* downloading：进度条（runtime.progress 0-100） */}
      {runtime?.status === 'downloading' && (
        <div className="space-y-1">
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all"
              style={{ width: `${Math.min(100, runtime.progress ?? 0)}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground">下载中 {runtime.progress ?? 0}%</span>
        </div>
      )}

      {/* ready：提示启动入口在模型列表（6d 接入） */}
      {runtime?.status === 'ready' && (
        <p className="text-xs text-muted-foreground">已就绪。在模型列表中选择模型后启动（后续任务接入）</p>
      )}

      {/* running：端口 + 停止按钮 */}
      {runtime?.status === 'running' && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-green-500">运行中 · 端口 {runtime.port ?? '?'}</span>
          <button
            onClick={handleStop}
            disabled={busy}
            className="flex items-center gap-1 px-2 py-1 border border-border rounded-md text-xs text-muted-foreground hover:text-destructive hover:border-destructive/50 disabled:opacity-50"
          >
            <Square className="w-3 h-3" />
            {busy ? '处理中...' : '停止'}
          </button>
        </div>
      )}

      {/* error：错误信息 + 重试（= 重新 ensureRuntime） */}
      {runtime?.status === 'error' && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-red-400 truncate">{runtime.error || '运行时错误'}</span>
          <button
            onClick={handleEnsure}
            disabled={busy}
            className="flex items-center gap-1 px-2 py-1 border border-border rounded-md text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className="w-3 h-3" />
            重试
          </button>
        </div>
      )}
    </div>
  )
}

/** 引擎状态徽标文案（LocalEngineStatus 词表：stopped | running | error）。 */
function engineStatusLabel(status: LocalEngine['status']): string {
  switch (status) {
    case 'running': return '运行中'
    case 'error': return '错误'
    default: return '已停止'
  }
}

/** 引擎状态徽标样式（Tailwind class）。 */
function engineStatusClass(status: LocalEngine['status']): string {
  switch (status) {
    case 'running': return 'text-green-500 border-green-500/40'
    case 'error': return 'text-red-400 border-red-400/40'
    default: return 'text-muted-foreground border-border'
  }
}

/**
 * 已装引擎卡（非 bundled）。
 * 数据源 = engine（LocalEngine）；模型 = useConfigStore.providers 按 p.engineId === engine.id join。
 * 状态词表 = LocalEngineStatus：stopped | running | error（注意与 RuntimeStatus 不同）。
 * 离线引擎（R12）无 provider 行 → models 为空，正常显示「离线/已停止」。
 */
function EngineCard({ engine, onRemove }: { engine: LocalEngine; onRemove: () => void }) {
  const providers = useConfigStore((s) => s.providers)
  const provider = providers.find((p) => p.engineId === engine.id)
  const models = provider?.models ?? []

  return (
    <div className="rounded-lg border border-border p-3 text-sm space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="font-medium text-foreground">{engine.name}</span>
        <div className="flex items-center gap-1.5">
          <span className={`text-xs px-1.5 py-0.5 rounded border ${engineStatusClass(engine.status)}`}>
            {engineStatusLabel(engine.status)}
          </span>
          <button
            onClick={onRemove}
            className="p-1.5 text-muted-foreground hover:text-destructive rounded-md hover:bg-accent/50 transition-colors"
            title="删除引擎"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div className="text-muted-foreground truncate text-xs">{engine.baseUrl}</div>
      <div className="text-xs text-muted-foreground">{models.length} 个模型</div>
    </div>
  )
}

/**
 * 本地模型 UI 区（引擎卡片 + 手动添加）。
 * 挂载生命周期：init() 订阅事件 + 初始三路加载；卸载 dispose() 解绑。
 * R-C 刷新：单一 useEffect 盯 runtime.status 变化 → loadEngines() + getProviders() 刷 providers
 *   （stop → R16 把 provider enabled=0 直写 DB，UI 不刷不可见；运行崩溃 exit → stop → 同样覆盖）。
 * 禁止在此组件加第二个引擎状态事件原始监听（store 已持有该订阅）。
 */
export default function LocalModelsSection() {
  const engines = useLocalModelStore((s) => s.engines)
  const runtime = useLocalModelStore((s) => s.runtime)
  const loadingEngines = useLocalModelStore((s) => s.loadingEngines)
  const error = useLocalModelStore((s) => s.error)
  const setError = useLocalModelStore((s) => s.setError)
  const init = useLocalModelStore((s) => s.init)
  const dispose = useLocalModelStore((s) => s.dispose)
  const loadEngines = useLocalModelStore((s) => s.loadEngines)
  const detectEngines = useLocalModelStore((s) => s.detectEngines)
  const addManualEngine = useLocalModelStore((s) => s.addManualEngine)
  const removeEngine = useLocalModelStore((s) => s.removeEngine)
  const setProviders = useConfigStore((s) => s.setProviders)

  const [showAdd, setShowAdd] = useState(false)
  const [manualUrl, setManualUrl] = useState('')
  const [adding, setAdding] = useState(false)

  // 挂载生命周期：订阅 + 初始加载；卸载解绑（6d 注册进 SettingsPanel 后才真正运行）
  useEffect(() => {
    void init()
    return () => dispose()
  }, [init, dispose])

  // R-C：runtime.status 变化（含初始 null→有值）→ 刷引擎列表 + 刷 providers
  useEffect(() => {
    void loadEngines()
    window.moaAPI.getProviders().then((res: { success: boolean; data: unknown }) => {
      if (res.success) setProviders(res.data as any)
    })
  }, [runtime?.status, loadEngines, setProviders])

  // 已装引擎卡 = engines 过滤 bundled（bundled 行首启后以 stopped 残留，语义归 RuntimeCard）
  const nonBundledEngines = engines.filter((e) => e.engineType !== 'bundled')

  const handleDetect = async () => {
    setError(null)
    await detectEngines()
    // 探测成功后主进程 upsertDetectedEngine 已新建/更新 provider 行（带 model_list），
    // 但 detectEngines 只刷 engines 不刷 providers——必须显式刷新，否则新引擎卡 models 显示 0
    const res = await window.moaAPI.getProviders()
    if (res.success) setProviders(res.data as any)
  }

  const handleAddManual = async () => {
    if (!manualUrl.trim()) return
    setError(null)
    setAdding(true)
    try {
      const ok = await addManualEngine(manualUrl.trim())
      if (ok) {
        // 同 handleDetect：新 provider 行已入库，显式刷 providers 否则模型数显示 0
        const res = await window.moaAPI.getProviders()
        if (res.success) setProviders(res.data as any)
        setManualUrl('')
        setShowAdd(false)
      }
    } finally {
      setAdding(false)
    }
  }

  const handleRemove = async (id: string) => {
    setError(null)
    await removeEngine(id)
    // 删除引擎会连带删 provider 行（removeEngine 主进程 DELETE 级联），UI providers 同步刷新
    const res = await window.moaAPI.getProviders()
    if (res.success) setProviders(res.data as any)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">本地推理引擎（无需 API Key）</p>
        <button
          onClick={handleDetect}
          disabled={loadingEngines}
          className="flex items-center gap-1 text-sm text-primary hover:text-primary/80 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loadingEngines ? 'animate-spin' : ''}`} />
          重新探测
        </button>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <RuntimeCard />

      <div className="space-y-2">
        {nonBundledEngines.map((engine) => (
          <EngineCard key={engine.id} engine={engine} onRemove={() => handleRemove(engine.id)} />
        ))}
        {nonBundledEngines.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4 border border-dashed border-border rounded-md">
            未发现已安装的本地引擎，点击下方按钮手动添加
          </p>
        )}
      </div>

      {!showAdd ? (
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1 text-sm text-primary hover:text-primary/80"
        >
          <Plus className="w-3.5 h-3.5" /> 手动添加引擎
        </button>
      ) : (
        <div className="flex gap-2 items-center">
          <input
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
            placeholder="http://127.0.0.1:1234/v1"
            className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            onClick={handleAddManual}
            disabled={adding || !manualUrl.trim()}
            className="flex items-center gap-1 px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-xs font-medium hover:opacity-90 disabled:opacity-50"
          >
            {adding ? '添加中...' : '添加'}
          </button>
          <button
            onClick={() => { setShowAdd(false); setManualUrl('') }}
            className="p-1.5 text-muted-foreground hover:text-foreground rounded-md"
            title="取消"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  )
}
