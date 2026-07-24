import React, { useState, useEffect } from 'react'
import { useConfigStore } from '../store/configStore'
import { Plus, Trash2, RefreshCw, Eye, EyeOff } from 'lucide-react'

export default function ProvidersPanel() {
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
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          厂商配置
        </h2>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1 text-xs text-primary hover:text-primary/80"
        >
          <Plus className="w-3 h-3" /> 添加
        </button>
      </div>

      {providers.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-4">暂无厂商</p>
      )}

      {providers.map((p) => (
        <div key={p.id} className="rounded-md border border-border p-2 text-xs space-y-1">
          <div className="flex items-center justify-between">
            <span className="font-medium text-foreground">{p.name}</span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => fetchModels(p.id)}
                disabled={loading === p.id || !p.apiKey}
                className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                title="获取模型列表"
              >
                <RefreshCw className={`w-3 h-3 ${loading === p.id ? 'animate-spin' : ''}`} />
              </button>
              <button
                onClick={() => handleDelete(p.id)}
                className="p-1 text-muted-foreground hover:text-destructive"
                title="删除厂商"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>
          <div className="text-muted-foreground truncate">{p.baseUrl}</div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1 text-muted-foreground">
              <span className={p.apiKey ? 'text-green-500' : 'text-red-400'}>
                {p.apiKey ? '●' : '○'}
              </span>
              <span className="truncate max-w-[100px]">
                {p.apiKey
                  ? showKey[p.id] ? p.apiKey : `${p.apiKey.slice(0, 4)}...${p.apiKey.slice(-4)}`
                  : '未配置 Key'}
              </span>
              {p.apiKey && (
                <button
                  onClick={() => setShowKey((s) => ({ ...s, [p.id]: !s[p.id] }))}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {showKey[p.id] ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                </button>
              )}
            </div>
            <span className="text-muted-foreground">{p.models?.length || 0} 模型</span>
          </div>
        </div>
      ))}

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

  const templates = [
    { name: 'OpenAI', url: 'https://api.openai.com/v1' },
    { name: 'DeepSeek', url: 'https://api.deepseek.com/v1' },
    { name: '硅基流动', url: 'https://api.siliconflow.cn/v1' },
    { name: 'Groq', url: 'https://api.groq.com/openai/v1' }
  ]

  const handleSave = async () => {
    if (!name.trim() || !apiKey.trim()) {
      setError('名称和API Key为必填')
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

        {/* Templates */}
        <div className="mb-3">
          <p className="text-xs text-muted-foreground mb-1.5">快速选择：</p>
          <div className="flex flex-wrap gap-1.5">
            {templates.map((t) => (
              <button
                key={t.name}
                onClick={() => { setName(t.name); setBaseUrl(t.url) }}
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
