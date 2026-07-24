import React, { useState, useEffect } from 'react'
import { useConfigStore } from '../store/configStore'
import { useConversationStore } from '../store/conversationStore'
import { Save } from 'lucide-react'
import type { SubModelConfig, AggregatorConfig } from '../../../shared/types'

export default function MoAConfigPanel() {
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

  // Reload when providers change (refresh models list)
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

  if (!loaded) return <div className="text-xs text-muted-foreground p-4">加载配置中...</div>

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <h2 className="text-sm font-semibold text-foreground">MoA 配置</h2>

      {/* Sub-model selection */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-medium text-foreground">子模型</label>
          <span className="text-xs text-muted-foreground">已选 {subModels.length} 个</span>
        </div>

        {subModels.map((sm, i) => {
          const p = providers.find((pr) => pr.id === sm.providerId)
          return (
            <div key={i} className="flex items-center justify-between p-2 mb-1 rounded-md bg-muted/50 border border-border text-xs">
              <span className="text-foreground">{p?.name || sm.providerId} · {sm.modelId}</span>
              <button onClick={() => removeSubModel(i)} className="text-muted-foreground hover:text-destructive">✕</button>
            </div>
          )
        })}

        {allModelOptions.length > 0 && (
          <select
            value=""
            onChange={(e) => { if (e.target.value) { addSubModel(e.target.value); e.target.value = '' } }}
            className="w-full mt-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">+ 添加子模型...</option>
            {allModelOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        )}

        {allModelOptions.length === 0 && (
          <p className="text-xs text-muted-foreground mt-1">
            请先在「厂商」页面配置厂商并获取模型列表
          </p>
        )}
      </div>

      {/* Aggregator model */}
      <div>
        <label className="text-xs font-medium text-foreground block mb-2">聚合模型（可选）</label>
        <select
          value={aggProviderId ? `${aggProviderId}:${aggModelId}` : ''}
          onChange={(e) => {
            const [pid, mid] = e.target.value.split(':')
            setAggProviderId(pid || '')
            setAggModelId(mid || '')
          }}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">不使用聚合（D模式直接对比）</option>
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
        className="flex items-center gap-1.5 px-4 py-2 bg-primary text-primary-foreground rounded-md text-xs font-medium hover:opacity-90 disabled:opacity-50"
      >
        <Save className="w-3.5 h-3.5" />
        {saving ? '保存中...' : '保存配置'}
      </button>
    </div>
  )
}
