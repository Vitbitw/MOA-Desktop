import React, { useEffect, useState } from 'react'
import { Plus, RefreshCw, Trash2, Download, Square, X, Search, Ban, Play } from 'lucide-react'
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

      {/* ready：提示启动入口在下方本地模型库 */}
      {runtime?.status === 'ready' && (
        <p className="text-xs text-muted-foreground">已就绪。在下方本地模型库中选择模型后启动</p>
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

/** 文件大小格式化（B/KB/MB/GB）。 */
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

/**
 * HF GGUF 搜索 + 下载触发区。
 * 数据源 = store.searchResults（searchHf 是 void 型，结果落状态，不从返回值读）。
 * 下载 = startDownload({ repo: result.id, file, sizeBytes })——后端 downloadManager 自带
 *   量化名解析兜底（params.quantization 缺省时按文件名自动解析），UI 不传 quantization；
 *   也禁止 import 主进程专属的量化解析工具（src/main/local/hfHub.ts，preload 未暴露）。
 */
function HfSearchPanel() {
  const searchResults = useLocalModelStore((s) => s.searchResults)
  const searching = useLocalModelStore((s) => s.searching)
  const searchHf = useLocalModelStore((s) => s.searchHf)
  const startDownload = useLocalModelStore((s) => s.startDownload)
  const setError = useLocalModelStore((s) => s.setError)
  const [query, setQuery] = useState('')
  const [downloadingFiles, setDownloadingFiles] = useState<Record<string, boolean>>({})

  const handleSearch = async () => {
    if (!query.trim()) return
    setError(null)
    await searchHf(query.trim())
  }

  const handleDownload = async (repo: string, file: string, sizeBytes: number) => {
    setError(null)
    const key = `${repo}::${file}`
    setDownloadingFiles((s) => ({ ...s, [key]: true }))
    try {
      await startDownload({ repo, file, sizeBytes })
    } finally {
      setDownloadingFiles((s) => ({ ...s, [key]: false }))
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">从 Hugging Face 下载模型</p>
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleSearch() }}
          placeholder="搜索 GGUF 模型（如 Qwen2.5-7B）"
          className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          onClick={() => void handleSearch()}
          disabled={searching || !query.trim()}
          className="flex items-center gap-1 px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-xs font-medium hover:opacity-90 disabled:opacity-50"
        >
          <Search className="w-3.5 h-3.5" />
          {searching ? '搜索中...' : '搜索'}
        </button>
      </div>

      <div className="space-y-2">
        {searchResults.map((r) => (
          <div key={r.id} className="rounded-lg border border-border p-3 text-sm space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-medium text-foreground">{r.author}/{r.name}</span>
              <span className="text-xs text-muted-foreground">{r.downloads.toLocaleString()} 下载 · {r.likes} 赞</span>
            </div>
            <div className="space-y-1">
              {r.ggufFiles.map((f) => {
                const key = `${r.id}::${f.filename}`
                return (
                  <div key={key} className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground truncate flex-1">{f.filename}</span>
                    <span className="text-xs text-muted-foreground flex-shrink-0">{formatBytes(f.sizeBytes)}</span>
                    <button
                      onClick={() => void handleDownload(r.id, f.filename, f.sizeBytes)}
                      disabled={downloadingFiles[key]}
                      className="flex items-center gap-1 px-2 py-1 bg-primary text-primary-foreground rounded-md text-xs hover:opacity-90 disabled:opacity-50 flex-shrink-0"
                    >
                      <Download className="w-3 h-3" />
                      {downloadingFiles[key] ? '开始中...' : '下载'}
                    </button>
                  </div>
                )
              })}
              {r.ggufFiles.length === 0 && (
                <p className="text-xs text-muted-foreground">该仓库暂无 GGUF 文件</p>
              )}
            </div>
          </div>
        ))}
        {searchResults.length === 0 && !searching && (
          <p className="text-xs text-muted-foreground">搜索 GGUF 模型仓库后在此显示结果</p>
        )}
      </div>
    </div>
  )
}

/**
 * 下载进度区。
 * 骨架 = models 中 status==='downloading' 的行（面板重开立即有行，不依赖事件）。
 * 覆盖 = downloads map 按 (repo, file) 匹配实时 percent/speedBps。
 *   join 键 = (repo, file) ↔ (hfRepo, hfFile)——绝不能拿 LocalModel.id 或 modelId 匹配：
 *   modelId 是文件名去 .gguf，跨 repo 同名文件会串线（如两仓库都有 model.gguf）。
 * 取消 = 仅当 progress entry 存在时渲染取消按钮（jobId 只活在 downloads entry 里，骨架行无 jobId）。
 * downloads map 只增不删（6a 设计）→ 只匹配 status==='downloading' 的 entry，终态自动过滤。
 */
function DownloadList() {
  const models = useLocalModelStore((s) => s.models)
  const downloads = useLocalModelStore((s) => s.downloads)
  const cancelDownload = useLocalModelStore((s) => s.cancelDownload)
  const [cancelling, setCancelling] = useState<string | null>(null)

  const skeleton = models.filter((m) => m.status === 'downloading')

  const handleCancel = async (jobId: string) => {
    setCancelling(jobId)
    try { await cancelDownload(jobId) } finally { setCancelling(null) }
  }

  if (skeleton.length === 0) return null

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">下载进度</p>
      <div className="space-y-2">
        {skeleton.map((m) => {
          // join 键 = (repo, file) ↔ (hfRepo, hfFile)；只匹配进行中 entry
          const entry = Object.values(downloads).find(
            (p) => p.repo === m.hfRepo && p.file === m.hfFile && p.status === 'downloading'
          )
          // 事件到达前退化为 downloadedBytes/sizeBytes（0.5s 节流窗口）
          const percent = entry?.percent ?? (m.sizeBytes > 0 ? Math.min(100, Math.round((m.downloadedBytes / m.sizeBytes) * 100)) : 0)
          return (
            <div key={m.id} className="rounded-lg border border-border p-3 text-sm space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground truncate">{m.name}</span>
                {entry && (
                  <button
                    onClick={() => void handleCancel(entry.jobId)}
                    disabled={cancelling === entry.jobId}
                    className="flex items-center gap-1 px-2 py-1 border border-border rounded-md text-xs text-muted-foreground hover:text-destructive hover:border-destructive/50 disabled:opacity-50 flex-shrink-0"
                  >
                    <Ban className="w-3 h-3" />
                    {cancelling === entry.jobId ? '取消中...' : '取消'}
                  </button>
                )}
              </div>
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all"
                  style={{ width: `${Math.min(100, percent)}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{percent}%</span>
                {entry ? (
                  <span>{formatBytes(entry.speedBps)}/s</span>
                ) : (
                  <span>{formatBytes(m.downloadedBytes)} / {formatBytes(m.sizeBytes)}</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * 本地模型列表区（已下载 GGUF 库）。
 * 数据源 = store.models（local_models 库）；运行中信号活在 runtime（RuntimeState），不在模型行——
 *   startEngine 成功后模型行保持 'downloaded'，禁止启动时改模型行状态。
 * 启动链路 = handleStart(m.id) → 动作内发起引擎启动——wire 实参 = LocalModel.id（UUID 主键），绝不传推理名！
 * 删除 = deleteLocalModel(id) 仅用于 downloaded/error 行；downloading 行走上方进度区取消（cancelDownload）。
 * 启动 gating：仅 runtime.status === 'ready' 可点；其余分态禁用 + hint。
 */
function ModelList() {
  const models = useLocalModelStore((s) => s.models)
  const runtime = useLocalModelStore((s) => s.runtime)
  const startEngine = useLocalModelStore((s) => s.startEngine)
  const deleteLocalModel = useLocalModelStore((s) => s.deleteLocalModel)
  const setError = useLocalModelStore((s) => s.setError)
  const [busyId, setBusyId] = useState<string | null>(null)

  // 仅 ready 可启动；not-installed/downloading/running/error 均禁用 + 分态 hint
  const canStart = runtime?.status === 'ready'
  const startHint =
    runtime?.status === 'not-installed' ? '先下载运行时'
    : runtime?.status === 'downloading' ? '运行时下载中…'
    : runtime?.status === 'running' ? '引擎运行中，先停止'
    : runtime?.status === 'error' ? '运行时错误，请重试'
    : '运行时未就绪'

  const handleStart = async (id: string) => {
    setError(null)
    setBusyId(id)
    try { await startEngine(id) } finally { setBusyId(null) }
  }

  const handleDelete = async (id: string) => {
    setError(null)
    setBusyId(id)
    try { await deleteLocalModel(id) } finally { setBusyId(null) }
  }

  if (models.length === 0) return null

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">本地模型库</p>
      <div className="space-y-2">
        {models.map((m) => (
          <div key={m.id} className="rounded-lg border border-border p-3 text-sm space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium text-foreground truncate">{m.name}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {m.quantization ? `${m.quantization} · ` : ''}{formatBytes(m.sizeBytes)} · {m.hfRepo}/{m.hfFile}
                </div>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {m.status === 'downloaded' && (
                  <button
                    onClick={() => void handleStart(m.id)}
                    disabled={!canStart || busyId === m.id}
                    title={canStart ? '启动引擎加载此模型' : startHint}
                    className="flex items-center gap-1 px-2 py-1 bg-primary text-primary-foreground rounded-md text-xs hover:opacity-90 disabled:opacity-50"
                  >
                    <Play className="w-3 h-3" />
                    {busyId === m.id ? '启动中...' : '启动'}
                  </button>
                )}
                {m.status !== 'downloading' && (
                  <button
                    onClick={() => void handleDelete(m.id)}
                    disabled={busyId === m.id}
                    className="p-1.5 text-muted-foreground hover:text-destructive rounded-md hover:bg-accent/50 transition-colors"
                    title="删除模型"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              {m.status === 'downloaded' && '已就绪'}
              {m.status === 'downloading' && '下载中（见上方下载进度）'}
              {m.status === 'error' && '下载失败（可在上方搜索后重新下载）'}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * 本地模型 UI 区（引擎卡片 + 手动添加 + HF 搜索 + 下载进度 + 本地模型库）。
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

      <HfSearchPanel />

      <DownloadList />

      <ModelList />
    </div>
  )
}
