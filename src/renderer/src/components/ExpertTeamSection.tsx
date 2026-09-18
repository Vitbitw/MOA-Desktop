import React, { useMemo, useState } from 'react'
import { Sparkles, Loader2, ChevronDown, Check, RefreshCw } from 'lucide-react'
import { useConfigStore } from '../store/configStore'
import { buildImportPlan, initialDrafts, type ExpertDraft, type ModelOption } from '../utils/expertTeam'
import type { SubModelConfig, ExpertTeamPlan } from '../../../shared/types'

interface ExpertTeamSectionProps {
  subModels: SubModelConfig[]
  setSubModels: React.Dispatch<React.SetStateAction<SubModelConfig[]>>
  notifySaveResult: (ok: boolean, detail?: string) => void
}

/** 「无可用模型」下拉占位文案（该项导入时跳过） */
const NO_MODEL_HINT = '无可用模型（请先配置厂商/模型）'

/**
 * 主席团模式「AI 生成专家团」折叠面板（设计文档 §5.6）：
 * 输入任务需求 → 主进程生成专家草案（专家名/提示词/模型分配均可编辑）
 * → 一键导入（席位自动扩充/缩减，本地 state + moa:setConfig 落库）。
 * 数据由 props 注入（不直接读 moa:getConfig）；席位调整算法在 utils/expertTeam.ts。
 */
export default function ExpertTeamSection({ subModels, setSubModels, notifySaveResult }: ExpertTeamSectionProps) {
  const providers = useConfigStore((s) => s.providers)

  const [open, setOpen] = useState(false)
  const [requirement, setRequirement] = useState('')
  // 生成阶段：loading（进行中）/ error（错误行；失败保留需求输入与上次结果）
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 预览态：plan（AI 生成结果）+ drafts（可编辑草案）
  const [plan, setPlan] = useState<ExpertTeamPlan | null>(null)
  const [drafts, setDrafts] = useState<ExpertDraft[]>([])
  const [importing, setImporting] = useState(false)
  const [imported, setImported] = useState(false)

  // 全量模型选项（与 MoASection 同构：不按 apiKey 过滤）
  const allModelOptions = useMemo<ModelOption[]>(
    () => providers.flatMap((p) => (p.models || []).map((m) => ({ label: `${p.name} · ${m.id}`, value: `${p.id}:${m.id}` }))),
    [providers]
  )
  const poolValues = useMemo(() => new Set(allModelOptions.map((o) => o.value)), [allModelOptions])

  // 可导入草案数（modelKey 合法）；席位摘要与 skipped 提示均以此为准（与 buildImportPlan 同口径）
  const validCount = useMemo(
    () => drafts.filter((d) => d.modelKey !== '' && poolValues.has(d.modelKey)).length,
    [drafts, poolValues]
  )
  const skippedCount = drafts.length - validCount

  // 席位变化摘要（导入后将发生的席位增减）
  const seatSummary = useMemo(() => {
    const existingCount = subModels.length
    const finalCount = validCount
    if (finalCount === existingCount) return `席位保持 ${existingCount} 个`
    if (finalCount > existingCount) return `席位 ${existingCount} → ${finalCount}：自动新增 ${finalCount - existingCount} 个席位`
    return `席位 ${existingCount} → ${finalCount}：移除 ${existingCount - finalCount} 个席位（其原有角色/提示词将一并移除）`
  }, [validCount, subModels.length])

  /** 编辑任一草案（专家名/提示词/模型）→ 清除「已导入」标记 */
  const updateDraft = (idx: number, patch: Partial<ExpertDraft>) => {
    setDrafts((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)))
    setImported(false)
  }

  const handleGenerate = async () => {
    const req = requirement.trim()
    if (!req || loading) return
    setLoading(true)
    setError(null)
    try {
      const res = await window.moaAPI.generateExperts({
        requirement: req,
        seats: subModels.map((s) => s.modelId)
      })
      if (res?.success === false) {
        setError(res.error || '生成失败')
      } else if (res?.data) {
        setPlan(res.data)
        setDrafts(initialDrafts(res.data.experts, subModels, allModelOptions))
        setImported(false)
      } else {
        setError('生成失败：主进程未返回数据')
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }

  const handleImport = async () => {
    if (importing) return
    const importPlan = buildImportPlan(subModels, allModelOptions, drafts)
    // ① 本地 state 立即生效（② 落库失败也保留，用户可手动「保存配置」重试）
    setSubModels(importPlan.subModels)
    setImporting(true)
    try {
      const res: any = await window.moaAPI.setMoaConfig({ subModels: importPlan.subModels })
      if (res?.success === false) throw new Error(res?.error || '保存失败')
      notifySaveResult(true)
      setImported(true)
    } catch (err) {
      notifySaveResult(false, String(err))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="rounded-md border border-border bg-muted/30 p-2 mb-1 text-sm">
      {/* 折叠标题行（默认收起） */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-sm font-medium text-foreground hover:text-primary transition-colors"
      >
        <Sparkles className="w-3.5 h-3.5 text-primary" />
        AI 生成专家团
        <ChevronDown className={`w-3.5 h-3.5 ml-auto text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          <textarea
            value={requirement}
            onChange={(e) => setRequirement(e.target.value)}
            rows={3}
            placeholder="描述任务需求，如：帮我制定一份代码安全审计方案，覆盖 OWASP Top 10 与依赖供应链风险"
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />

          <div className="flex items-center gap-2">
            <button
              onClick={handleGenerate}
              disabled={!requirement.trim() || loading}
              className="inline-flex items-center gap-1.5 px-3 py-1 text-xs bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50 shrink-0"
            >
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
              {loading ? '生成中…' : '生成专家团'}
            </button>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}

          {/* 预览态：推荐理由 + 席位变化摘要 + 可编辑专家卡片 + 一键导入 */}
          {plan && drafts.length > 0 && (
            <div className="space-y-2 border-t border-border pt-2">
              {plan.reason?.trim() && <p className="text-xs text-muted-foreground">推荐理由：{plan.reason}</p>}
              <p className="text-xs text-primary">{seatSummary}</p>
              <p className="text-xs text-muted-foreground/70">由 {plan.providerId} · {plan.modelId} 生成</p>

              {drafts.map((d, i) => {
                const keyValid = d.modelKey !== '' && poolValues.has(d.modelKey)
                return (
                  <div key={i} className="rounded-md border border-border bg-background p-2 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground shrink-0">专家 {i + 1}</span>
                      <input
                        value={d.name}
                        onChange={(e) => updateDraft(i, { name: e.target.value })}
                        placeholder="专家名"
                        className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                      <select
                        value={d.modelKey}
                        onChange={(e) => updateDraft(i, { modelKey: e.target.value })}
                        title={keyValid ? undefined : NO_MODEL_HINT}
                        className={`w-40 shrink-0 rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-ring ${
                          keyValid ? 'text-foreground' : 'text-muted-foreground'
                        }`}
                      >
                        {!keyValid && (
                          <option value={d.modelKey} disabled>{NO_MODEL_HINT}</option>
                        )}
                        {allModelOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </div>
                    <textarea
                      value={d.prompt}
                      onChange={(e) => updateDraft(i, { prompt: e.target.value })}
                      rows={4}
                      placeholder="该专家的 system prompt"
                      className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                )
              })}

              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={handleImport}
                  disabled={importing || validCount === 0}
                  className="inline-flex items-center gap-1.5 px-3 py-1 text-xs bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50 shrink-0"
                >
                  {importing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                  {importing ? '导入中…' : '一键导入'}
                </button>
                <button
                  onClick={handleGenerate}
                  disabled={loading || !requirement.trim()}
                  className="inline-flex items-center gap-1.5 px-3 py-1 text-xs border border-input text-foreground rounded-md hover:bg-accent/50 disabled:opacity-50 shrink-0"
                >
                  <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
                  重新生成
                </button>
                {imported && <span className="text-xs text-primary">已导入</span>}
                {skippedCount > 0 && (
                  <span className="text-xs text-muted-foreground">{skippedCount} 个专家因无可用模型未导入</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
