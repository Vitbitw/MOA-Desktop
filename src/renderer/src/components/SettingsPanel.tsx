import React, { useEffect, useState } from 'react'
import { useSettingsStore } from '../store/settingsStore'
import { useConfigStore } from '../store/configStore'
import { useConversationStore } from '../store/conversationStore'
import { useProbeStore, type PricingSortKey } from '../store/probeStore'
import { useNotificationStore } from '../store/notificationStore'
import { Plus, Trash2, RefreshCw, Eye, EyeOff, Save, Sparkles, X, Mountain, ChevronDown, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react'
import type { PricingConfig, SubModelConfig, AggregatorConfig, TitleSettings, ProbedPricingEntry, PricingProbeSource, PricingWindow, Provider } from '../../../shared/types'
import { BUILT_IN_PROVIDER_TEMPLATES, defaultPricingProbeUrlByName } from '../../../shared/defaults'

type SettingsSection = 'moa' | 'providers' | 'proxy' | 'network' | 'display' | 'pricing' | 'title'

export default function SettingsPanel({ onClose }: { onClose?: () => void }) {
  const { settings, loaded, loadSettings, updateSetting } = useSettingsStore()
  const [activeSection, setActiveSection] = useState<SettingsSection>('moa')

  useEffect(() => {
    if (!loaded) loadSettings()
  }, [loaded, loadSettings])

  if (!loaded) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <p className="text-muted-foreground text-sm">加载设置中...</p>
      </div>
    )
  }

  const sections: { key: SettingsSection; label: string }[] = [
    { key: 'moa', label: 'MoA' },
    { key: 'providers', label: '厂商' },
    { key: 'proxy', label: '代理服务' },
    { key: 'network', label: '网络代理' },
    { key: 'title', label: '对话标题' },
    { key: 'display', label: '显示设置' },
    { key: 'pricing', label: '定价' }
  ]

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-foreground">设置</h2>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            title="返回对话"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Section tabs */}
      <div className="flex gap-1 border-b border-border mb-6 flex-wrap">
        {sections.map((s) => (
          <button
            key={s.key}
            onClick={() => setActiveSection(s.key)}
            className={`px-4 py-2 text-sm border-b-2 transition-colors ${
              activeSection === s.key
                ? 'border-primary text-foreground font-medium'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* MoA Section */}
      {activeSection === 'moa' && <MoASection />}

      {/* Providers Section */}
      {activeSection === 'providers' && <ProvidersSection />}

      {/* Proxy Section */}
      {activeSection === 'proxy' && (
        <div className="space-y-5 max-w-xl">
          <SettingRow label="启用代理" hint="开启内置 API 代理服务器">
            <ToggleSwitch
              checked={settings.proxy.enabled}
              onChange={(v) => updateSetting('proxy', { ...settings.proxy, enabled: v })}
            />
          </SettingRow>

          {settings.proxy.enabled && (
            <>
              <SettingRow label="监听地址" hint="默认 127.0.0.1">
                <input
                  type="text"
                  value={settings.proxy.host}
                  onChange={(e) => updateSetting('proxy', { ...settings.proxy, host: e.target.value })}
                  className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground"
                />
              </SettingRow>

              <SettingRow label="监听端口" hint="默认 28888">
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={settings.proxy.port}
                  onChange={(e) => updateSetting('proxy', { ...settings.proxy, port: Number(e.target.value) || 28888 })}
                  className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground"
                />
              </SettingRow>

              <SettingRow label="最大并发" hint="同时处理的最大请求数">
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={settings.proxy.maxConcurrency}
                  onChange={(e) => updateSetting('proxy', { ...settings.proxy, maxConcurrency: Number(e.target.value) || 3 })}
                  className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground"
                />
              </SettingRow>

              <SettingRow label="默认模型" hint="代理未指定模型时的默认值">
                <input
                  type="text"
                  value={settings.proxy.defaultModelId}
                  onChange={(e) => updateSetting('proxy', { ...settings.proxy, defaultModelId: e.target.value })}
                  placeholder="gpt-4o"
                  className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground"
                />
              </SettingRow>

              <SettingRow label="启用认证" hint="为代理请求添加 API Key 鉴权">
                <ToggleSwitch
                  checked={settings.proxy.authEnabled}
                  onChange={(v) => updateSetting('proxy', { ...settings.proxy, authEnabled: v })}
                />
              </SettingRow>

              {settings.proxy.authEnabled && (
                <SettingRow label="代理密钥" hint="第三方调用代理时的鉴权 Key">
                  <input
                    type="password"
                    value={settings.proxy.proxyKey}
                    onChange={(e) => updateSetting('proxy', { ...settings.proxy, proxyKey: e.target.value })}
                    className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground"
                  />
                </SettingRow>
              )}

              <SettingRow label="记录模式" hint="代理请求的日志记录级别">
                <select
                  value={settings.proxy.recording}
                  onChange={(e) => updateSetting('proxy', { ...settings.proxy, recording: e.target.value as 'full' | 'stats' })}
                  className="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground"
                >
                  <option value="full">完整记录</option>
                  <option value="stats">仅统计</option>
                </select>
              </SettingRow>

              <SettingRow label="透明模式" hint="代理是否透传模型输出">
                <select
                  value={settings.proxy.transparency}
                  onChange={(e) => updateSetting('proxy', { ...settings.proxy, transparency: e.target.value as 'default' | 'extended' })}
                  className="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground"
                >
                  <option value="default">标准</option>
                  <option value="extended">扩展</option>
                </select>
              </SettingRow>
            </>
          )}
        </div>
      )}

      {/* Network Proxy Section */}
      {activeSection === 'network' && (
        <div className="space-y-5 max-w-xl">
          <SettingRow label="启用网络代理" hint="通过代理服务器访问外部网络（运行时下载、HuggingFace 搜索等）">
            <ToggleSwitch
              checked={settings.network?.enabled ?? false}
              onChange={(v) => updateSetting('network', { ...settings.network, enabled: v, proxyUrl: settings.network?.proxyUrl ?? '' })}
            />
          </SettingRow>

          {settings.network?.enabled && (
            <SettingRow label="代理地址" hint="如 http://127.0.0.1:7897">
              <input
                type="text"
                value={settings.network?.proxyUrl ?? ''}
                onChange={(e) => updateSetting('network', { ...settings.network, enabled: true, proxyUrl: e.target.value })}
                placeholder="http://127.0.0.1:7897"
                className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground"
              />
            </SettingRow>
          )}

          <SettingRow label="请求超时" hint="单次外发 API 请求等待上限（秒），0 = 不限制；超时或网络错误后自动重试">
            <input
              type="number"
              min={0}
              step={1}
              value={Math.round((settings.network?.timeoutMs ?? 15_000) / 1000)}
              onChange={(e) => {
                const sec = Number(e.target.value)
                updateSetting('network', {
                  ...settings.network,
                  timeoutMs: Number.isFinite(sec) && sec >= 0 ? Math.round(sec * 1000) : 0
                })
              }}
              className="w-28 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground"
            />
          </SettingRow>

          <SettingRow label="重试次数" hint="超时/网络错误后的自动重试次数（不含首次请求）。POST 类请求不按状态码重试，避免重复计费">
            <input
              type="number"
              min={0}
              step={1}
              value={settings.network?.retryCount ?? 2}
              onChange={(e) => {
                const n = Number(e.target.value)
                updateSetting('network', {
                  ...settings.network,
                  retryCount: Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
                })
              }}
              className="w-28 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground"
            />
          </SettingRow>
        </div>
      )}

      {/* Display Section */}
      {activeSection === 'display' && (
        <div className="space-y-5 max-w-xl">
          <SettingRow label="子模型输出" hint="子模型输出在对话中的显示方式">
            <select
              value={settings.display.subModelShow}
              onChange={(e) =>
                updateSetting('display', {
                  ...settings.display,
                  subModelShow: e.target.value as 'always' | 'hidden' | 'perConversation'
                })
              }
              className="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground"
            >
              <option value="always">始终显示</option>
              <option value="hidden">始终隐藏</option>
              <option value="perConversation">按对话设置</option>
            </select>
          </SettingRow>

          <SettingRow label="默认展开子模型" hint="新对话中子模型输出默认是否展开">
            <ToggleSwitch
              checked={settings.display.defaultSubModelExpanded}
              onChange={(v) => updateSetting('display', { ...settings.display, defaultSubModelExpanded: v })}
            />
          </SettingRow>

          <SettingRow label="自动清除" hint="发送新消息时自动清除之前的子模型输出">
            <ToggleSwitch
              checked={settings.display.autoClearSubOutputs}
              onChange={(v) => updateSetting('display', { ...settings.display, autoClearSubOutputs: v })}
            />
          </SettingRow>

          <SettingRow label="桌面用量悬浮窗" hint="在桌面角落显示今日/总计用量数字徽章">
            <ToggleSwitch
              checked={settings.display.usageOverlay}
              onChange={(v) => updateSetting('display', { ...settings.display, usageOverlay: v })}
            />
          </SettingRow>
        </div>
      )}

      {/* Pricing Section（每个定价源内含自动探查 + 手动定价覆盖） */}
      {activeSection === 'pricing' && <ProbeSection />}

      {/* Title Settings Section */}
      {activeSection === 'title' && <TitleSettingsSection />}
    </div>
  )
}

// ── MoA Section ──

function MoASection() {
  const providers = useConfigStore((s) => s.providers)
  const setMoaMode = useConversationStore((s) => s.setMode)
  const moaMode = useConversationStore((s) => s.mode)
  const notifySaveResult = useSettingsStore((s) => s.notifySaveResult)

  const [subModels, setSubModels] = useState<SubModelConfig[]>([])
  const [aggModelId, setAggModelId] = useState('')
  const [aggProviderId, setAggProviderId] = useState('')
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)

  // Load existing config on mount
  useEffect(() => {
    window.moaAPI.getMoaConfig().then((config: any) => {
      if (config) {
        setSubModels(config.subModels || [])
        setAggModelId(config.aggregator?.primaryModelId || '')
        setAggProviderId(config.aggregator?.primaryProviderId || '')
        if (config.mode) setMoaMode(config.mode)
      }
      setLoaded(true)
    })
  }, [])

  // Reload when providers change
  useEffect(() => {
    if (loaded) {
      window.moaAPI.getMoaConfig().then((config: any) => {
        if (config) {
          setSubModels(config.subModels || [])
          setAggModelId(config.aggregator?.primaryModelId || '')
          setAggProviderId(config.aggregator?.primaryProviderId || '')
        }
      })
    }
  }, [providers.length])

  // All usable models flattened from all providers
  const allModelOptions = providers.flatMap((p) =>
    (p.models || []).map((m) => ({
      label: `${p.name} · ${m.id}`,
      value: `${p.id}:${m.id}`,
      providerId: p.id,
      modelId: m.id
    }))
  )

  const addSubModel = (value: string) => {
    const [providerId, modelId] = value.split(':')
    if (!providerId || !modelId) return
    if (subModels.some((s) => s.providerId === providerId && s.modelId === modelId)) return
    setSubModels((prev) => [
      ...prev,
      { providerId, modelId, order: prev.length }
    ])
  }

  const removeSubModel = (idx: number) => {
    setSubModels((prev) => prev.filter((_, i) => i !== idx).map((s, i) => ({ ...s, order: i })))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const aggregator: AggregatorConfig | null = aggModelId && aggProviderId
        ? { primaryModelId: aggModelId, primaryProviderId: aggProviderId, allowQuickSwitch: true }
        : null

      await window.moaAPI.setMoaConfig({
        mode: moaMode,
        subModels,
        aggregator,
        aggregationPromptVariant: 'standard-zh'
      })
      notifySaveResult(true)
    } catch (err) {
      console.error('Failed to save MoA config:', err)
      notifySaveResult(false, String(err))
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) return <p className="text-sm text-muted-foreground">加载配置中...</p>

  return (
    <div className="max-w-lg space-y-6">
      <p className="text-sm text-muted-foreground">配置子模型和聚合模型</p>

      {/* Sub-model selection */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-foreground">子模型</label>
          <span className="text-xs text-muted-foreground">已选 {subModels.length} 个</span>
        </div>

        {subModels.map((sm, i) => {
          const p = providers.find((pr) => pr.id === sm.providerId)
          return (
            <div key={i} className="flex items-center justify-between p-2 mb-1 rounded-md bg-muted/50 border border-border text-sm">
              <span className="text-foreground">{p?.name || sm.providerId} · {sm.modelId}</span>
              <button onClick={() => removeSubModel(i)} className="text-muted-foreground hover:text-destructive">✕</button>
            </div>
          )
        })}

        {allModelOptions.length > 0 && (
          <select
            value=""
            onChange={(e) => { if (e.target.value) { addSubModel(e.target.value); e.target.value = '' } }}
            className="w-full mt-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">+ 添加子模型...</option>
            {allModelOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        )}

        {allModelOptions.length === 0 && (
          <p className="text-xs text-muted-foreground mt-1">
            请先在「设置 → 厂商」配置厂商并获取模型列表
          </p>
        )}
      </div>

      {/* Aggregator model */}
      <div>
        <label className="text-sm font-medium text-foreground block mb-2">聚合模型（可选）</label>
        <select
          value={aggProviderId ? `${aggProviderId}:${aggModelId}` : ''}
          onChange={(e) => {
            const [pid, mid] = e.target.value.split(':')
            setAggProviderId(pid || '')
            setAggModelId(mid || '')
          }}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">不使用聚合（D 模式直接对比）</option>
          {allModelOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground mt-1">
          聚合模型将综合所有子模型输出生成最终答案。选择后 A 模式可用。
        </p>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="flex items-center gap-1.5 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50"
      >
        <Save className="w-3.5 h-3.5" />
        {saving ? '保存中...' : '保存配置'}
      </button>
    </div>
  )
}

// ── Providers Section ──

function ProvidersSection() {
  const providers = useConfigStore((s) => s.providers)
  const setProviders = useConfigStore((s) => s.setProviders)
  const [loading, setLoading] = useState<string | null>(null)
  const [showKey, setShowKey] = useState<Record<string, boolean>>({})
  const [showAdd, setShowAdd] = useState(false)

  const refresh = async () => {
    const res = await window.moaAPI.getProviders()
    if (res.success) setProviders(res.data as any)
  }

  useEffect(() => { refresh() }, [])

  const fetchModels = async (id: string) => {
    setLoading(id)
    await window.moaAPI.getModels(id)
    await refresh()
    setLoading(null)
  }

  const handleDelete = async (id: string) => {
    await window.moaAPI.removeProvider(id)
    await refresh()
  }

  // 仅显示已配置 API Key 的厂商，未配置的（如内置模板占位）不展示
  const keyedProviders = providers.filter((p) => p.apiKey)

  return (
    <div className="max-w-xl">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-muted-foreground">管理 LLM API 厂商及密钥</p>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1 text-sm text-primary hover:text-primary/80"
        >
          <Plus className="w-3.5 h-3.5" /> 添加厂商
        </button>
      </div>

      {keyedProviders.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8 border border-dashed border-border rounded-md">
          暂无已配置 API Key 的厂商，点击上方按钮添加
        </p>
      )}

      <div className="space-y-2">
        {keyedProviders.map((p) => (
          <div key={p.id} className="rounded-lg border border-border p-3 text-sm space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-medium text-foreground">{p.name}</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => fetchModels(p.id)}
                  disabled={loading === p.id || !p.apiKey}
                  className="p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-30 rounded-md hover:bg-accent/50 transition-colors"
                  title="获取模型列表"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loading === p.id ? 'animate-spin' : ''}`} />
                </button>
                <button
                  onClick={() => handleDelete(p.id)}
                  className="p-1.5 text-muted-foreground hover:text-destructive rounded-md hover:bg-accent/50 transition-colors"
                  title="删除厂商"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <div className="text-muted-foreground truncate text-xs">{p.baseUrl}</div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className={p.apiKey ? 'text-green-500' : 'text-red-400'}>
                  {p.apiKey ? '●' : '○'}
                </span>
                <span className="font-mono truncate max-w-[140px]">
                  {p.apiKey
                    ? showKey[p.id] ? p.apiKey : `${p.apiKey.slice(0, 4)}...${p.apiKey.slice(-4)}`
                    : '未配置 Key'}
                </span>
                {p.apiKey && (
                  <button
                    onClick={() => setShowKey((s) => ({ ...s, [p.id]: !s[p.id] }))}
                    className="text-muted-foreground hover:text-foreground p-0.5"
                  >
                    {showKey[p.id] ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                  </button>
                )}
              </div>
              <span className="text-xs text-muted-foreground">{p.models?.length || 0} 模型</span>
            </div>
          </div>
        ))}
      </div>

      {showAdd && (
        <AddProviderDialog
          onClose={() => setShowAdd(false)}
          onDone={() => { setShowAdd(false); refresh() }}
        />
      )}
    </div>
  )
}

function AddProviderDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    if (!name.trim() || !apiKey.trim()) {
      setError('名称和 API Key 为必填')
      return
    }
    setSaving(true)
    setError(null)
    try {
      // baseUrl 为空且选中了内置模板 → 用模板 URL；否则要求用户填 URL（不能拿 name 当 URL）
      const selectedTemplate = BUILT_IN_PROVIDER_TEMPLATES.find((t) => t.name === name.trim())
      const finalBaseUrl = baseUrl.trim() || selectedTemplate?.baseUrl || ''
      if (!finalBaseUrl) {
        setError('请填写 API 地址（或从上方快速选择内置厂商）')
        setSaving(false)
        return
      }
      const res = await window.moaAPI.addProvider({
        name: name.trim(),
        baseUrl: finalBaseUrl,
        apiKey: apiKey.trim()
      })
      if (res.success) {
        onDone()
      } else {
        setError(String(res.error || '保存失败'))
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-card border border-border rounded-xl p-5 w-96 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-foreground mb-4">添加厂商</h3>

        <div className="mb-3">
          <p className="text-xs text-muted-foreground mb-1.5">快速选择：</p>
          <div className="flex flex-wrap gap-1.5">
            {BUILT_IN_PROVIDER_TEMPLATES.map((t) => (
              <button
                key={t.name}
                onClick={() => { setName(t.name); setBaseUrl(t.baseUrl) }}
                className={`px-2 py-1 text-xs rounded-md border transition-colors ${
                  name === t.name
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:border-primary/50'
                }`}
              >
                {t.name}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">名称 *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="例如：OpenAI"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">API 地址</label>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="例如：https://api.openai.com/v1"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">API Key *</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="sk-..."
            />
          </div>
        </div>

        {error && <p className="text-xs text-destructive mt-2">{error}</p>}

        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Title Settings Section ──

function TitleSettingsSection() {
  const { settings, updateSetting } = useSettingsStore()
  const providers = useConfigStore((s) => s.providers)
  const titleCfg = settings.title

  // Only show models from providers with an API key — title generation requires a working connection
  const allModelOptions = providers
    .filter((p) => p.apiKey)
    .flatMap((p) =>
    (p.models || []).map((m) => ({
      label: `${p.name} · ${m.id}`,
      value: `${p.id}:${m.id}`,
      providerId: p.id,
      modelId: m.id
    }))
  )

  const setTitle = (partial: Partial<TitleSettings>) => {
    updateSetting('title', { ...titleCfg, ...partial })
  }

  return (
    <div className="space-y-5 max-w-xl">
      <p className="text-sm text-muted-foreground">
        配置 AI 自动为对话生成标题。需要选择一个已配置 API Key 的轻量模型来执行标题生成。
      </p>

      <SettingRow label="标题模型" hint="用于生成标题的轻量模型（建议选择便宜快速的模型）">
        <select
          value={titleCfg.providerId ? `${titleCfg.providerId}:${titleCfg.modelId}` : ''}
          onChange={(e) => {
            const [pid, mid] = e.target.value.split(':')
            setTitle({ providerId: pid || '', modelId: mid || '' })
          }}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground"
        >
          <option value="">未配置（不生成标题）</option>
          {allModelOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </SettingRow>

      <SettingRow label="生成模式" hint="何时自动生成初始标题">
        <select
          value={titleCfg.autoMode}
          onChange={(e) => setTitle({ autoMode: e.target.value as TitleSettings['autoMode'] })}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground"
        >
          <option value="first_and_manual">首次回复后 + 手动</option>
          <option value="first_reply">仅首次回复后</option>
          <option value="first_message">首次消息后</option>
          <option value="manual_only">仅手动</option>
        </select>
      </SettingRow>

      <SettingRow label="实时更新" hint="对话进行中是否自动刷新标题">
        <select
          value={titleCfg.realtimeMode}
          onChange={(e) => setTitle({ realtimeMode: e.target.value as TitleSettings['realtimeMode'] })}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground"
        >
          <option value="off">关闭</option>
          <option value="every_reply">每次回复</option>
          <option value="every_n_rounds">每 N 轮</option>
        </select>
      </SettingRow>

      {titleCfg.realtimeMode === 'every_n_rounds' && (
        <SettingRow label="轮数间隔" hint="每 N 轮对话后更新标题">
          <input
            type="number"
            min={1}
            max={50}
            value={titleCfg.realtimeN}
            onChange={(e) => setTitle({ realtimeN: Math.max(1, Number(e.target.value) || 5) })}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </SettingRow>
      )}

      <SettingRow label="最大长度" hint="生成标题的最大字符数">
        <input
          type="number"
          min={10}
          max={100}
          value={titleCfg.maxLength}
          onChange={(e) => setTitle({ maxLength: Math.max(10, Math.min(100, Number(e.target.value) || 50)) })}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground"
        />
      </SettingRow>

      <SettingRow label="语言" hint="生成标题的语言偏好">
        <select
          value={titleCfg.language}
          onChange={(e) => setTitle({ language: e.target.value as TitleSettings['language'] })}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground"
        >
          <option value="auto">跟随对话</option>
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </SettingRow>
    </div>
  )
}

// ── Shared sub-components ──

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex-1 min-w-0">
        <label className="block text-sm font-medium text-foreground">{label}</label>
        {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
      </div>
      <div className="flex-shrink-0 w-48">{children}</div>
    </div>
  )
}

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors ${
        checked ? 'bg-primary' : 'bg-input'
      }`}
    >
      <span
        className={`pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm ring-0 transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

/** 星期选择（显示顺序周一到周日），value 遵循 JS getDay()：0=周日..6=周六 */
const WEEKDAY_LABELS: { label: string; value: number }[] = [
  { label: '一', value: 1 },
  { label: '二', value: 2 },
  { label: '三', value: 3 },
  { label: '四', value: 4 },
  { label: '五', value: 5 },
  { label: '六', value: 6 },
  { label: '日', value: 0 }
]
const ALL_DAYS = WEEKDAY_LABELS.map((d) => d.value)

/** 星期数组 → 可读文本：每天 / 工作日 / 周末 / 周一、周三 */
const daysLabel = (days?: number[]): string => {
  if (!days || days.length === 0) return '每天'
  const set = new Set(days)
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return '工作日'
  if (days.length === 2 && [0, 6].every((d) => set.has(d))) return '周末'
  return [...days]
    .sort((a, b) => {
      const ra = a === 0 ? 7 : a
      const rb = b === 0 ? 7 : b
      return ra - rb
    })
    .map((d) => WEEKDAY_LABELS.find((x) => x.value === d)?.label ?? '')
    .join('、')
}

function PricingRow({
  modelId,
  config,
  onChange,
  onRemove,
  unitLabel = '$/M',
  probedWindows,
  probedTimezone
}: {
  modelId: string
  config: PricingConfig
  onChange: (cfg: PricingConfig) => void
  onRemove: () => void
  unitLabel?: string
  /** 探查到的官方峰谷窗口（只读展示） */
  probedWindows?: PricingWindow[]
  probedTimezone?: string
}) {
  const [editingKey, setEditingKey] = useState(false)
  const [keyDraft, setKeyDraft] = useState(modelId)
  const [showWindows, setShowWindows] = useState(false)

  const windows = config.windows ?? []
  const timezone = config.timezone ?? probedTimezone ?? 'Asia/Shanghai'
  const hasManualWindows = windows.length > 0
  const hasProbedWindows = (probedWindows?.length ?? 0) > 0

  const updateWindow = (idx: number, patch: Partial<PricingWindow>) => {
    const next = windows.map((w, i) => (i === idx ? { ...w, ...patch } : w))
    onChange({ ...config, windows: next, timezone })
  }
  const removeWindow = (idx: number) => {
    const next = windows.filter((_, i) => i !== idx)
    onChange({ ...config, windows: next.length ? next : undefined, timezone })
  }
  const addWindow = () => {
    const next = [...windows, { start: '09:00', end: '23:00', input: 0, output: 0 }]
    onChange({ ...config, windows: next, timezone })
  }
  /** 切换某窗口适用星期；全选后归一为 undefined（= 每天） */
  const toggleWindowDay = (idx: number, day: number) => {
    const cur = windows[idx].days ?? ALL_DAYS
    const next = cur.includes(day) ? cur.filter((d) => d !== day) : [...cur, day]
    updateWindow(idx, { days: next.length === ALL_DAYS.length ? undefined : next })
  }

  const numInputCls =
    'min-w-0 flex-1 text-right rounded border border-input bg-background px-1.5 py-1 text-xs text-foreground placeholder:text-muted-foreground/60'

  return (
    <>
      <tr className="border-b border-border/50 group hover:bg-accent/20">
        <td className="py-1.5 px-2">
          {editingKey ? (
            <input
              autoFocus
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              onBlur={() => setEditingKey(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setEditingKey(false)
                if (e.key === 'Escape') { setKeyDraft(modelId); setEditingKey(false) }
              }}
              className="w-full rounded border border-input bg-background px-1.5 py-0.5 text-xs text-foreground"
            />
          ) : (
            <button
              onClick={() => setEditingKey(true)}
              className="block w-full truncate text-left text-xs font-mono text-foreground hover:text-primary"
              title="点击编辑模型 ID"
            >
              {modelId}
            </button>
          )}
        </td>
        <td className="py-1.5 px-1">
          <div className="flex items-center gap-1">
            <input
              type="number"
              step="0.001"
              min={0}
              value={config.input ?? ''}
              placeholder="未探到"
              onChange={(e) => onChange({ ...config, input: e.target.value === '' ? undefined : Number(e.target.value) })}
              className={numInputCls}
            />
            <span
              className="shrink-0 text-[10px] text-muted-foreground whitespace-nowrap"
              title={unitLabel}
            >
              {unitLabel}
            </span>
          </div>
        </td>
        <td className="py-1.5 px-1">
          <div className="flex items-center gap-1">
            <input
              type="number"
              step="0.001"
              min={0}
              value={config.output ?? ''}
              placeholder="未探到"
              onChange={(e) => onChange({ ...config, output: e.target.value === '' ? undefined : Number(e.target.value) })}
              className={numInputCls}
            />
            <span
              className="shrink-0 text-[10px] text-muted-foreground whitespace-nowrap"
              title={unitLabel}
            >
              {unitLabel}
            </span>
          </div>
        </td>
        <td className="py-1.5 px-1">
          <div className="flex items-center gap-1">
            <input
              type="number"
              step="0.001"
              min={0}
              value={config.cacheRead ?? ''}
              placeholder="未探到"
              onChange={(e) => onChange({ ...config, cacheRead: e.target.value === '' ? undefined : Number(e.target.value) })}
              className={numInputCls}
            />
            <span
              className="shrink-0 text-[10px] text-muted-foreground whitespace-nowrap"
              title={unitLabel}
            >
              {unitLabel}
            </span>
          </div>
        </td>
        <td className="py-1.5 px-1">
          <div className="flex items-center gap-1">
            <input
              type="number"
              step="0.001"
              min={0}
              value={config.cacheCreation ?? ''}
              placeholder="未探到"
              onChange={(e) => onChange({ ...config, cacheCreation: e.target.value === '' ? undefined : Number(e.target.value) })}
              className={numInputCls}
            />
            <span
              className="shrink-0 text-[10px] text-muted-foreground whitespace-nowrap"
              title={unitLabel}
            >
              {unitLabel}
            </span>
          </div>
        </td>
        <td className="py-1.5 px-1">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowWindows((v) => !v)}
              className="text-muted-foreground hover:text-primary"
              title="峰谷定价（多时段）"
            >
              <Mountain className={`w-3.5 h-3.5 ${showWindows ? 'text-primary' : ''}`} />
            </button>
            {(hasManualWindows || hasProbedWindows) && (
              <span
                className="text-[10px] text-muted-foreground whitespace-nowrap"
                title={`手动 ${windows.length} 段 / 探查 ${probedWindows?.length ?? 0} 段`}
              >
                {windows.length + (probedWindows?.length ?? 0)}
              </span>
            )}
            <button
              onClick={onRemove}
              className="text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity text-xs"
              title="删除此定价覆盖"
            >
              ✕
            </button>
          </div>
        </td>
      </tr>
      {showWindows && (
        <tr className="border-b border-border/50 bg-accent/10">
          <td colSpan={6} className="py-2 px-3">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-foreground">峰谷定价（多时段）</span>
                <button
                  onClick={addWindow}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
                  title="添加一个峰谷时段"
                >
                  <Plus className="w-3 h-3" /> 添加时段
                </button>
              </div>

              {/* 时区 */}
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">时区</span>
                <input
                  type="text"
                  value={timezone}
                  onChange={(e) => onChange({ ...config, timezone: e.target.value.trim() || undefined })}
                  placeholder="Asia/Shanghai"
                  className="w-44 rounded border border-input bg-background px-1.5 py-0.5 text-xs text-foreground placeholder:text-muted-foreground/60"
                />
                <span className="text-muted-foreground/70">命中窗口则用窗口价，否则用基础价</span>
              </div>

              {/* 手动峰谷窗口（多时段） */}
              {windows.length > 0 && (
                <div className="space-y-1">
                  {windows.map((w, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-1.5">
                      {/* 星期多选 + 快捷按钮 */}
                      <div className="flex items-center gap-0.5" title={`适用星期：${daysLabel(w.days)}`}>
                        {[
                          { label: '工作日', days: [1, 2, 3, 4, 5] },
                          { label: '周末', days: [0, 6] }
                        ].map((q) => {
                          const cur = w.days ?? ALL_DAYS
                          const active =
                            q.days.length === cur.length && q.days.every((d) => cur.includes(d))
                          return (
                            <button
                              key={q.label}
                              onClick={() => updateWindow(i, { days: q.days })}
                              className={`h-5 rounded px-1 text-[10px] leading-none flex items-center justify-center border transition-colors ${
                                active
                                  ? 'bg-primary text-primary-foreground border-primary'
                                  : 'border-input text-muted-foreground hover:bg-accent'
                              }`}
                              title={q.label}
                            >
                              {q.label}
                            </button>
                          )
                        })}
                        {WEEKDAY_LABELS.map((d) => {
                          const active = (w.days ?? ALL_DAYS).includes(d.value)
                          return (
                            <button
                              key={d.value}
                              onClick={() => toggleWindowDay(i, d.value)}
                              className={`h-5 min-w-5 rounded px-0.5 text-[10px] leading-none flex items-center justify-center border transition-colors ${
                                active
                                  ? 'bg-primary text-primary-foreground border-primary'
                                  : 'border-input text-muted-foreground hover:bg-accent'
                              }`}
                              title={d.label}
                            >
                              {d.label}
                            </button>
                          )
                        })}
                      </div>
                      <input
                        type="time"
                        value={w.start}
                        onChange={(e) => updateWindow(i, { start: e.target.value })}
                        className="rounded border border-input bg-background px-1 py-0.5 text-xs text-foreground"
                      />
                      <span className="text-[10px] text-muted-foreground">至</span>
                      <input
                        type="time"
                        value={w.end}
                        onChange={(e) => updateWindow(i, { end: e.target.value })}
                        className="rounded border border-input bg-background px-1 py-0.5 text-xs text-foreground"
                      />
                      <span className="ml-1 text-[10px] text-muted-foreground">输入</span>
                      <input
                        type="number"
                        step="0.001"
                        min={0}
                        value={w.input}
                        onChange={(e) => updateWindow(i, { input: Number(e.target.value) || 0 })}
                        className="w-20 rounded border border-input bg-background px-1.5 py-0.5 text-xs text-foreground"
                      />
                      <span className="text-[10px] text-muted-foreground">{unitLabel}</span>
                      <span className="ml-1 text-[10px] text-muted-foreground">输出</span>
                      <input
                        type="number"
                        step="0.001"
                        min={0}
                        value={w.output}
                        onChange={(e) => updateWindow(i, { output: Number(e.target.value) || 0 })}
                        className="w-20 rounded border border-input bg-background px-1.5 py-0.5 text-xs text-foreground"
                      />
                      <span className="text-[10px] text-muted-foreground">{unitLabel}</span>
                      <button
                        onClick={() => removeWindow(i)}
                        className="text-muted-foreground hover:text-destructive"
                        title="删除该时段"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* 探查到的官方峰谷（只读） */}
              {hasProbedWindows && (
                <div className="text-xs text-muted-foreground">
                  <div className="mb-0.5 font-medium text-foreground">探查到的官方峰谷（只读）</div>
                  {probedWindows!.map((w, i) => (
                    <div key={i} className="tabular-nums">
                      {daysLabel(w.days)}　{w.start}–{w.end}　输入 {w.input} / 输出 {w.output} {unitLabel}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ── Pricing Probe Section（官方定价探查）──

function ProbeSection() {
  const { settings, loadSettings, updateSetting } = useSettingsStore()
  const providers = useConfigStore((s) => s.providers)
  const probeCfg = settings.pricingProbe
  const sources = probeCfg?.sources ?? []
  const probed = Array.isArray(settings.probedPricing) ? settings.probedPricing : []
  // 探查运行状态放全局 store：切换页面组件卸载后仍能保留"探查中"状态
  const { busy, runningIds, messages, progress, setBusy, setRunningIds, setMessages, setProgress, collapsed, toggleCollapsed, sorts, setSort } =
    useProbeStore()

  // 订阅 main 进程实时推送的探查进度（抓取/解析阶段）
  useEffect(() => {
    const off = window.moaAPI.onProbeProgress((p) => setProgress(p))
    return off
  }, [setProgress])

  // 探查模型选项（仅列有 API Key 的 provider 的模型，探查需要真实调用）
  const modelOptions = providers
    .filter((p) => p.apiKey)
    .flatMap((p) =>
      (p.models || []).map((m) => ({
        label: `${p.name} · ${m.id}`,
        value: `${p.id}:${m.id}`
      }))
    )

  // 已配置 API Key 的厂商（可绑定为定价源）
  const keyedProviders = providers.filter((p) => p.apiKey)

  /** 解析源绑定的厂商：优先 providerId，旧数据回退按名称匹配 */
  const providerForSource = (source: PricingProbeSource): Provider | undefined => {
    if (source.providerId) return providers.find((p) => p.id === source.providerId)
    const n = source.name.trim().toLowerCase()
    if (!n) return undefined
    return keyedProviders.find((p) => {
      const pn = p.name.trim().toLowerCase()
      return pn === n || pn.includes(n) || n.includes(pn)
    })
  }

  // 已配置 key 的厂商自动派生为源（无需手动添加）；派生源不持久化
  const boundProviderIds = new Set<string>()
  for (const s of sources) {
    const pid = providerForSource(s)?.id
    if (pid) boundProviderIds.add(pid)
  }
  const autoSources: PricingProbeSource[] = keyedProviders
    .filter((p) => !boundProviderIds.has(p.id))
    .map((p) => ({
      id: `auto:${p.id}`,
      name: p.name,
      providerId: p.id,
      url: defaultPricingProbeUrlByName(p.name),
      enabled: true
    }))

  /** 展示的源 = 绑定已配置 key 厂商的手动源 ∪ 自动派生源；未配置 key 的来源不显示 */
  const visibleSources = [...sources.filter((s) => !!providerForSource(s)), ...autoSources]
  /** 自动源 = 未持久化的动态派生源（编辑后会物化进 sources 变为手动源） */
  const isAutoSource = (sourceId: string): boolean => !sources.some((s) => s.id === sourceId)

  const setSources = (next: PricingProbeSource[]) => {
    updateSetting('pricingProbe', { ...probeCfg, sources: next })
  }

  const updateSource = (id: string, patch: Partial<PricingProbeSource>) => {
    if (sources.some((s) => s.id === id)) {
      // 手动（已持久化）源：直接更新
      setSources(sources.map((s) => (s.id === id ? { ...s, ...patch } : s)))
      return
    }
    // 自动派生源（auto:*）：首次编辑时物化为持久源，再应用修改
    const auto = visibleSources.find((s) => s.id === id)
    if (auto) setSources([...sources, { ...auto, ...patch }])
  }

  const runProbe = async (ids: string[] | 'all') => {
    if (busy) return
    setBusy(true)
    setMessages({})
    setProgress(null)
    const targets =
      ids === 'all' ? visibleSources.filter((s) => s.enabled) : visibleSources.filter((s) => ids.includes(s.id))
    setRunningIds(new Set(targets.map((s) => s.id)))
    // 执行前预警：定价探查会调用大模型解析定价页，产生 Token 消耗
    const probeModelLabel = (() => {
      const pm = probeCfg?.probeModelId
      if (!pm) return undefined
      return modelOptions.find((o) => o.value === pm)?.label
    })()
    useNotificationStore.getState().push({
      type: 'warning',
      title: '定价探查将消耗 Token',
      message: probeModelLabel
        ? `将调用 ${probeModelLabel} 解析 ${targets.length} 个定价源，产生 Token 消耗`
        : `将对 ${targets.length} 个定价源调用大模型解析，产生 Token 消耗`
    })
    try {
      const res = await window.moaAPI.probePricing(targets)
      if (res.success && res.data) {
        const nextMsg: Record<string, string> = {}
        for (const r of res.data.results) {
          nextMsg[r.sourceId] = r.ok
            ? r.skipped
              ? `页面无变化（沿用 ${r.entryCount} 条）`
              : `已更新 ${r.entryCount} 条定价`
            : `失败：${r.error}`
        }
        setMessages(nextMsg)
      } else {
        setMessages({ __global: res.error || '探查失败' })
      }
      loadSettings()
    } catch (err) {
      setMessages({ __global: String(err) })
    } finally {
      setBusy(false)
      setRunningIds(new Set())
      setProgress(null)
    }
  }

  const sourceMeta = (sourceId: string): { entries: ProbedPricingEntry[]; lastFetchedAt: number } => {
    const entries = probed.filter((e) => e.sourceId === sourceId)
    const lastFetchedAt = entries.reduce((max, e) => Math.max(max, e.fetchedAt), 0)
    return { entries, lastFetchedAt }
  }

  // 添加源：选择一个已配置 key 的厂商绑定
  const [addingForProvider, setAddingForProvider] = useState<string | null>(null)
  const addSourceWithProvider = (providerId: string) => {
    const p = providers.find((x) => x.id === providerId)
    if (!p) return
    if (sources.some((s) => s.providerId === providerId)) {
      setAddingForProvider(null)
      return
    }
    setSources([
      ...sources,
      {
        id: `src-${Date.now()}`,
        name: p.name,
        providerId: p.id,
        url: defaultPricingProbeUrlByName(p.name),
        enabled: true
      }
    ])
    setAddingForProvider(null)
  }

  // ── 手动定价覆盖（每个源内）──
  /** 该源探查到的条目（前缀匹配模型 ID），用于默认填入与峰谷展示 */
  const probedEntryFor = (sourceId: string, modelId: string): ProbedPricingEntry | undefined =>
    probed.find(
      (e) => e.sourceId === sourceId && (e.pattern === modelId || modelId.startsWith(e.pattern))
    )

  /** 该源探查到的价格（前缀匹配模型 ID），用于定价框默认填入 */
  const probedPriceFor = (sourceId: string, modelId: string): PricingConfig | null => {
    const hit = probedEntryFor(sourceId, modelId)
    if (!hit) return null
    return {
      input: hit.input,
      output: hit.output,
      cacheRead: hit.cacheRead,
      cacheCreation: hit.cacheCreation
    }
  }

  /** 官方页计费单位 → 简短缩写（如 per 1M tokens → M；per 1K tokens → K；per request → req） */
  const unitAbbrev = (unit?: string): string => {
    if (!unit) return 'M'
    const u = unit.trim().toLowerCase()
    if (/1\s*m\s*tokens?|million/i.test(u)) return 'M'
    if (/1\s*k\s*tokens?/i.test(u)) return 'K'
    if (/request|call|query/i.test(u)) return 'req'
    if (/hour/i.test(u)) return 'h'
    if (/minute/i.test(u)) return 'min'
    if (/day/i.test(u)) return 'd'
    if (/image|photo|generation/i.test(u)) return 'img'
    if (/character|char/i.test(u)) return 'char'
    const m = u.match(/(\d+\s*[a-z]*)/i)
    return m ? m[1].trim().replace(/\s+/g, '') : 'M'
  }

  /** 每条价格按「币种/单位」显示（如 $/M、¥/K）；无探查信息则默认 $/M */
  const priceUnitLabel = (sourceId: string, modelId: string): string => {
    const hit = probed.find(
      (e) =>
        e.sourceId === sourceId &&
        (e.pattern === modelId || modelId.startsWith(e.pattern) || e.pattern.startsWith(modelId))
    )
    const sym = hit?.currency === 'CNY' ? '¥' : '$'
    return `${sym}/${unitAbbrev(hit?.unit)}`
  }

  /** 定价框默认显示：手动覆盖 > 官方探查价 > 全空（用户一编辑即转手动覆盖）。空=未探到；0=免费 */
  const manualPrice = (sourceId: string, modelId: string): PricingConfig =>
    settings.pricing[modelId] ??
    probedPriceFor(sourceId, modelId) ??
    { input: undefined, output: undefined, cacheRead: undefined, cacheCreation: undefined }

  const setManualPrice = (modelId: string, cfg: PricingConfig) => {
    updateSetting('pricing', { ...settings.pricing, [modelId]: cfg })
  }

  /** 该源展示的模型 = 自动探查结果 pattern ∪ 绑定厂商 /models 模型名（去重保序，探查结果优先） */
  const manualModelIds = (source: PricingProbeSource): string[] => {
    const prov = providerForSource(source)
    const provModels = (prov?.models ?? []).map((m) => m.id).filter(Boolean)
    const probedModels = probed
      .filter((e) => e.sourceId === source.id)
      .map((e) => e.pattern.trim())
      .filter(Boolean)
    const seen = new Set<string>()
    return [...probedModels, ...provModels].filter((m) => {
      if (seen.has(m)) return false
      seen.add(m)
      return true
    })
  }

  const removeManualModel = (modelId: string) => {
    const next = { ...settings.pricing }
    delete next[modelId]
    updateSetting('pricing', next)
  }

  // ── 表格排序（按模型 ID / 输入 / 输出 / 缓存读 / 缓存写）──
  /** 可排序列定义（表头点击切换；同列再次点击切换升降序） */
  const SORT_COLUMNS: { key: PricingSortKey; label: string }[] = [
    { key: 'modelId', label: '模型 ID' },
    { key: 'input', label: '输入' },
    { key: 'output', label: '输出' },
    { key: 'cacheRead', label: '缓存读' },
    { key: 'cacheCreation', label: '缓存写' }
  ]
  /** 按当前排序状态重排模型 ID 列表；未设置排序时保持原顺序。价格取展示值（手动覆盖 > 探查价），undefined（未探到）恒排最后 */
  const sortModelIds = (sourceId: string, ids: string[]): string[] => {
    const sort = sorts[sourceId]
    if (!sort) return ids
    const dir = sort.dir === 'asc' ? 1 : -1
    const originalIndex = new Map(ids.map((m, i) => [m, i]))
    if (sort.key === 'modelId') {
      return [...ids].sort((a, b) => {
        const diff = a.localeCompare(b)
        return diff !== 0 ? dir * diff : originalIndex.get(a)! - originalIndex.get(b)!
      })
    }
    const priceKey = sort.key as Exclude<PricingSortKey, 'modelId'>
    return [...ids].sort((a, b) => {
      const va = manualPrice(sourceId, a)[priceKey]
      const vb = manualPrice(sourceId, b)[priceKey]
      if (va === undefined && vb === undefined) return originalIndex.get(a)! - originalIndex.get(b)!
      if (va === undefined) return 1
      if (vb === undefined) return -1
      if (va === vb) return originalIndex.get(a)! - originalIndex.get(b)!
      return dir * (va - vb)
    })
  }
  /** 表头点击：切换该列排序（同列翻转方向） */
  const handleSortClick = (sourceId: string, key: PricingSortKey) => setSort(sourceId, key)
  const sortIndicator = (sourceId: string, key: PricingSortKey) => {
    const cur = sorts[sourceId]
    if (!cur || cur.key !== key) {
      return <ArrowUpDown className="w-3 h-3 opacity-40" />
    }
    return cur.dir === 'asc' ? <ArrowUp className="w-3 h-3 text-primary" /> : <ArrowDown className="w-3 h-3 text-primary" />
  }

  // 手动「更新模型」：重新调用该厂商 /models 拉取最新模型列表并刷新本地厂商数据
  const setProviders = useConfigStore((s) => s.setProviders)
  const [refreshingModels, setRefreshingModels] = useState<Set<string>>(new Set())
  const refreshModels = async (providerId: string) => {
    setRefreshingModels((prev) => new Set(prev).add(providerId))
    try {
      await window.moaAPI.getModels(providerId)
      const res = await window.moaAPI.getProviders()
      if (res.success) setProviders(res.data as Provider[])
    } catch {
      /* ignore */
    } finally {
      setRefreshingModels((prev) => {
        const next = new Set(prev)
        next.delete(providerId)
        return next
      })
    }
  }

  return (
    <div className="space-y-5 max-w-3xl">
      <p className="text-sm text-muted-foreground">
        抓取官方定价页并用大模型提取定价，写入独立「官方探查价」层（支持峰谷/错峰时段价）。
        费用优先级：手动覆盖 &gt; 官方探查 &gt; 内置默认。
      </p>

      <SettingRow label="探查模型" hint="用于解析定价页的大模型（建议选便宜快速的）。留空则回退聚合模型">
        <select
          value={probeCfg?.probeModelId ?? ''}
          onChange={(e) =>
            updateSetting('pricingProbe', { ...probeCfg, probeModelId: e.target.value || undefined })
          }
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground"
        >
          <option value="">回退聚合模型</option>
          {modelOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow label="自动刷新间隔" hint="时/分/秒全为 0 = 关闭。开启后按该间隔轮回探查，超期未更新的定价源自动重新探查">
        {(() => {
          const total = Math.max(0, Math.floor(probeCfg?.autoRefreshSeconds ?? 0))
          const parts = [
            { label: '时', value: Math.floor(total / 3600), factor: 3600 },
            { label: '分', value: Math.floor(total / 60) % 60, factor: 60 },
            { label: '秒', value: total % 60, factor: 1 }
          ]
          return (
            <div className="flex items-stretch gap-2 w-full">
              {parts.map(({ label, value, factor }) => (
                <div key={label} className="flex-1 min-w-0 flex flex-col gap-1">
                  <span className="text-center text-[10px] leading-none text-muted-foreground">{label}</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={value}
                    onChange={(e) =>
                      updateSetting('pricingProbe', {
                        ...probeCfg,
                        autoRefreshSeconds: Math.max(0, total + ((Number(e.target.value) || 0) - value) * factor)
                      })
                    }
                    className="w-full min-w-0 rounded-md border border-input bg-background px-1 py-1.5 text-center text-sm text-foreground"
                  />
                </div>
              ))}
            </div>
          )
        })()}
      </SettingRow>

      {messages.__global && <p className="text-sm text-destructive">{messages.__global}</p>}

      {/* 探查进度提示（多源"全部探查"时显示在顶部；单源探查显示在对应卡片内） */}
      {busy && progress && progress.total > 1 && (
        <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
          <RefreshCw className="w-3.5 h-3.5 shrink-0 animate-spin text-primary" />
          <span className="text-xs text-foreground whitespace-nowrap">
            {progress.done
              ? `${progress.sourceName} ${
                  progress.ok
                    ? progress.skipped
                      ? `页面无变化（沿用 ${progress.entryCount} 条）`
                      : `完成（${progress.entryCount} 条）`
                    : `失败：${progress.error}`
                }`
              : `正在探查 ${progress.sourceName}（${progress.index}/${progress.total}）… ${
                  progress.stage === 'fetching' ? '抓取页面' : '大模型解析'
                }`}
          </span>
          <div className="flex-1 h-1 min-w-[60px] bg-border rounded overflow-hidden">
            <div
              className="h-full bg-primary transition-all"
              style={{
                width: `${Math.min(100, Math.max(4, (progress.index / progress.total) * 100))}%`
              }}
            />
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">定价探查源</h3>
        <button
          onClick={() => runProbe('all')}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
          全部探查
        </button>
      </div>

      <div className="space-y-4">
        {visibleSources.map((s) => {
          const meta = sourceMeta(s.id)
          return (
            <div key={s.id} className="rounded-lg border border-border p-4 space-y-3">
              {/* 顶部：厂商名标题 + 结果提示 + 探查按钮 + 开关 + 删除 */}
              <div className="flex items-center gap-3">
                <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground" title={s.name}>
                  {s.name}
                </h3>
                {messages[s.id] && (
                  <span
                    className={`whitespace-nowrap text-xs ${
                      messages[s.id].startsWith('失败') ? 'text-destructive' : 'text-primary'
                    }`}
                  >
                    {messages[s.id]}
                  </span>
                )}
                <button
                  onClick={() => runProbe([s.id])}
                  disabled={busy || !s.url || !providerForSource(s)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-input px-3 py-1 text-sm text-foreground hover:bg-accent/50 disabled:opacity-50"
                >
                  <RefreshCw className={`w-4 h-4 ${runningIds.has(s.id) ? 'animate-spin' : ''}`} />
                  探查并更新
                </button>
                <ToggleSwitch checked={!!s.enabled} onChange={(v) => updateSource(s.id, { enabled: v })} />
                {!isAutoSource(s.id) && (
                  <button
                    onClick={() => setSources(sources.filter((x) => x.id !== s.id))}
                    className="text-muted-foreground hover:text-destructive"
                    title="删除源"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>

              {/* 单源探查进度（仅当只探查这一个源时显示在该卡片内） */}
              {busy && progress && progress.total === 1 && progress.sourceId === s.id && (
                <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5">
                  <RefreshCw className="w-3 h-3 shrink-0 animate-spin text-primary" />
                  <span className="text-xs text-foreground whitespace-nowrap">
                    {progress.done
                      ? `${progress.sourceName} ${
                          progress.ok
                            ? progress.skipped
                              ? `页面无变化（沿用 ${progress.entryCount} 条）`
                              : `完成（${progress.entryCount} 条）`
                            : `失败：${progress.error}`
                        }`
                      : `${progress.stage === 'fetching' ? '抓取页面' : '大模型解析'}…`}
                  </span>
                  <div className="flex-1 h-1 min-w-[40px] bg-border rounded overflow-hidden">
                    <div className="h-full bg-primary transition-all" style={{ width: '100%' }} />
                  </div>
                </div>
              )}

              {/* 定价相关区域：仅绑定了已配置 API Key 厂商的来源显示 */}
              {providerForSource(s) && (
                <>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>
                      上次探查：
                      {meta.lastFetchedAt ? new Date(meta.lastFetchedAt).toLocaleString() : '从未'}
                    </span>
                    <span>{meta.entries.length} 条定价</span>
                    {meta.entries[0]?.currency && (
                      <span className={meta.entries[0].currency === 'CNY' ? 'text-primary' : ''}>
                        官方页币种：{meta.entries[0].currency}
                        {meta.entries[0].currency === 'CNY' ? '（已折算 USD）' : ''}
                      </span>
                    )}
                  </div>

                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>探查前更新模型 ID</span>
                    <ToggleSwitch
                      checked={s.fetchModelsBeforeProbe !== false}
                      onChange={(v) => updateSource(s.id, { fetchModelsBeforeProbe: v })}
                    />
                    <span className="text-muted-foreground/70">
                      探查时先调用 /models 获取/更新该厂商的模型名作为提取关键词
                    </span>
                  </label>

                  <label className="block">
                    <span className="text-xs text-muted-foreground">官方定价页 URL</span>
                    <input
                      value={s.url}
                      onChange={(e) => updateSource(s.id, { url: e.target.value })}
                      className="mt-0.5 w-full rounded-md border border-input bg-background px-2 py-1 text-xs font-mono text-foreground"
                      placeholder="https://..."
                    />
                  </label>

                  {/* 定价：自动填入官方探查价，可直接编辑 */}
                  <div className="border-t border-border pt-3">
                    <div className="flex items-center justify-between mb-2">
                      <button
                        onClick={() => toggleCollapsed(s.id)}
                        className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
                        title={collapsed.has(s.id) ? '展开模型列表' : '收起模型列表'}
                      >
                        <ChevronDown
                          className={`w-3.5 h-3.5 transition-transform ${collapsed.has(s.id) ? '-rotate-90' : ''}`}
                        />
                        定价（自动填入官方探查价，可编辑）
                      </button>
                      <button
                        onClick={() => providerForSource(s) && refreshModels(providerForSource(s)!.id)}
                        disabled={!providerForSource(s) || refreshingModels.has(providerForSource(s)!.id)}
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                        title="重新调用该厂商 /models 获取最新模型列表"
                      >
                        <RefreshCw
                          className={`w-3 h-3 ${providerForSource(s) && refreshingModels.has(providerForSource(s)!.id) ? 'animate-spin' : ''}`}
                        />
                        更新模型
                      </button>
                    </div>

                    {!collapsed.has(s.id) && (
                      <table className="w-full text-sm table-fixed">
                      <thead>
                        <tr className="border-b border-border">
                          {SORT_COLUMNS.map((col) => {
                            const isNum = col.key !== 'modelId'
                            return (
                              <th
                                key={col.key}
                                className={`py-1 text-muted-foreground font-medium ${isNum ? 'text-right px-1 w-[96px]' : 'text-left px-2'}`}
                              >
                                <button
                                  onClick={() => handleSortClick(s.id, col.key)}
                                  className={`inline-flex items-center gap-0.5 hover:text-foreground transition-colors ${
                                    sorts[s.id]?.key === col.key ? 'text-primary' : ''
                                  }`}
                                  title={`按${col.label}排序`}
                                >
                                  {col.label}
                                  {sortIndicator(s.id, col.key)}
                                </button>
                              </th>
                            )
                          })}
                          <th className="py-1 px-1 w-6"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortModelIds(s.id, manualModelIds(s)).map((modelId) => (
                          <PricingRow
                            key={modelId}
                            modelId={modelId}
                            config={manualPrice(s.id, modelId)}
                            onChange={(cfg) => setManualPrice(modelId, cfg)}
                            onRemove={() => removeManualModel(modelId)}
                            unitLabel={priceUnitLabel(s.id, modelId)}
                            probedWindows={probedEntryFor(s.id, modelId)?.windows}
                            probedTimezone={probedEntryFor(s.id, modelId)?.timezone}
                          />
                        ))}
                        {manualModelIds(s).length === 0 && (
                          <tr>
                            <td colSpan={6} className="text-center py-3 text-muted-foreground text-xs">
                              暂无模型。点击「更新模型」从该厂商拉取模型列表后设置手动价格。
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                    )}
                  </div>
                </>
              )}
            </div>
          )
        })}

        {visibleSources.length === 0 && (
          <p className="text-xs text-muted-foreground">
            暂无已配置 API Key 的定价源。请先在「厂商」中为对应来源配置 API Key 后显示。
          </p>
        )}
      </div>

      {addingForProvider !== null ? (
        <div className="flex items-center gap-2">
          <select
            autoFocus
            value=""
            onChange={(e) => addSourceWithProvider(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs font-mono text-foreground"
          >
            <option value="">选择要绑定的厂商...</option>
            {keyedProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => setAddingForProvider(null)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            取消
          </button>
        </div>
      ) : (
        <button
          onClick={() => setAddingForProvider('')}
          disabled={keyedProviders.length === 0}
          className="text-sm text-primary hover:underline disabled:opacity-50"
        >
          + 添加源（绑定已配置 key 的厂商）
        </button>
      )}
    </div>
  )
}
