import React, { useEffect, useState } from 'react'
import { useSettingsStore } from '../store/settingsStore'
import { useConfigStore } from '../store/configStore'
import { useConversationStore } from '../store/conversationStore'
import { Plus, Trash2, RefreshCw, Eye, EyeOff, Save, Sparkles, X } from 'lucide-react'
import type { PricingConfig, SubModelConfig, AggregatorConfig, TitleSettings } from '../../../shared/types'
import { BUILT_IN_PROVIDER_TEMPLATES } from '../../../shared/defaults'

type SettingsSection = 'moa' | 'providers' | 'proxy' | 'display' | 'pricing' | 'currency' | 'title'

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
    { key: 'title', label: '对话标题' },
    { key: 'display', label: '显示设置' },
    { key: 'pricing', label: '定价覆盖' },
    { key: 'currency', label: '货币单位' }
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
        </div>
      )}

      {/* Pricing Section */}
      {activeSection === 'pricing' && (
        <div className="max-w-xl">
          <p className="text-sm text-muted-foreground mb-4">
            按模型 ID 设置价格覆盖（USD / 1K tokens）。留空则使用厂商默认价格。
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 px-2 text-muted-foreground font-medium">模型 ID</th>
                <th className="text-right py-2 px-2 text-muted-foreground font-medium">输入</th>
                <th className="text-right py-2 px-2 text-muted-foreground font-medium">输出</th>
                <th className="text-right py-2 px-2 text-muted-foreground font-medium">缓存读</th>
                <th className="text-right py-2 px-2 text-muted-foreground font-medium">缓存写</th>
                <th className="py-2 px-2 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(settings.pricing).map(([modelId, cfg]) => (
                <PricingRow
                  key={modelId}
                  modelId={modelId}
                  config={cfg}
                  onChange={(newCfg) => {
                    const next = { ...settings.pricing }
                    next[modelId] = newCfg
                    updateSetting('pricing', next)
                  }}
                  onRemove={() => {
                    const next = { ...settings.pricing }
                    delete next[modelId]
                    updateSetting('pricing', next)
                  }}
                />
              ))}
              {Object.keys(settings.pricing).length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center py-6 text-muted-foreground">
                    暂无定价覆盖。添加模型以覆盖默认价格。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <button
            onClick={() => {
              const next = { ...settings.pricing }
              const key = `model-${Date.now()}`
              next[key] = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
              updateSetting('pricing', next)
            }}
            className="mt-3 text-sm text-primary hover:underline"
          >
            + 添加模型
          </button>
        </div>
      )}

      {/* Currency Section */}
      {activeSection === 'currency' && (
        <div className="space-y-5 max-w-xl">
          <SettingRow label="货币单位" hint="费用统计和显示使用的货币">
            <div className="flex gap-2">
              <button
                onClick={() => updateSetting('currency', 'USD')}
                className={`px-4 py-2 rounded-md text-sm border transition-colors ${
                  settings.currency === 'USD'
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-input text-foreground hover:bg-accent/50'
                }`}
              >
                USD ($)
              </button>
              <button
                onClick={() => updateSetting('currency', 'CNY')}
                className={`px-4 py-2 rounded-md text-sm border transition-colors ${
                  settings.currency === 'CNY'
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-input text-foreground hover:bg-accent/50'
                }`}
              >
                CNY (¥)
              </button>
            </div>
          </SettingRow>
        </div>
      )}

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
    } catch (err) {
      console.error('Failed to save MoA config:', err)
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

      {providers.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8 border border-dashed border-border rounded-md">
          暂无厂商配置，点击上方按钮添加
        </p>
      )}

      <div className="space-y-2">
        {providers.map((p) => (
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
      const res = await window.moaAPI.addProvider({
        name: name.trim(),
        baseUrl: baseUrl.trim() || name.trim(),
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

function PricingRow({
  modelId,
  config,
  onChange,
  onRemove
}: {
  modelId: string
  config: PricingConfig
  onChange: (cfg: PricingConfig) => void
  onRemove: () => void
}) {
  const [editingKey, setEditingKey] = useState(false)
  const [keyDraft, setKeyDraft] = useState(modelId)

  return (
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
            className="text-xs text-foreground hover:text-primary font-mono truncate max-w-[140px] block"
            title="点击编辑模型 ID"
          >
            {modelId}
          </button>
        )}
      </td>
      <td className="py-1.5 px-2">
        <input
          type="number"
          step="0.001"
          min={0}
          value={config.input || ''}
          onChange={(e) => onChange({ ...config, input: Number(e.target.value) || 0 })}
          className="w-full text-right rounded border border-input bg-background px-2 py-1 text-xs text-foreground"
        />
      </td>
      <td className="py-1.5 px-2">
        <input
          type="number"
          step="0.001"
          min={0}
          value={config.output || ''}
          onChange={(e) => onChange({ ...config, output: Number(e.target.value) || 0 })}
          className="w-full text-right rounded border border-input bg-background px-2 py-1 text-xs text-foreground"
        />
      </td>
      <td className="py-1.5 px-2">
        <input
          type="number"
          step="0.001"
          min={0}
          value={config.cacheRead || ''}
          onChange={(e) => onChange({ ...config, cacheRead: Number(e.target.value) || 0 })}
          className="w-full text-right rounded border border-input bg-background px-2 py-1 text-xs text-foreground"
        />
      </td>
      <td className="py-1.5 px-2">
        <input
          type="number"
          step="0.001"
          min={0}
          value={config.cacheCreation || ''}
          onChange={(e) => onChange({ ...config, cacheCreation: Number(e.target.value) || 0 })}
          className="w-full text-right rounded border border-input bg-background px-2 py-1 text-xs text-foreground"
        />
      </td>
      <td className="py-1.5 px-2">
        <button
          onClick={onRemove}
          className="text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity text-xs"
          title="删除此定价覆盖"
        >
          ✕
        </button>
      </td>
    </tr>
  )
}
