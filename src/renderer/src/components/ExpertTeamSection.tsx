import React, { useMemo, useState } from 'react'
import { Sparkles, Loader2, ChevronDown } from 'lucide-react'
import { useConfigStore } from '../store/configStore'
import { buildImportPlan, initialDrafts, type ModelOption } from '../utils/expertTeam'
import type { SubModelConfig, ExpertTeamPlan } from '../../../shared/types'

interface ExpertTeamSectionProps {
  subModels: SubModelConfig[]
  setSubModels: React.Dispatch<React.SetStateAction<SubModelConfig[]>>
  notifySaveResult: (ok: boolean, detail?: string) => void
}

/** 席位名短显（结果行内联展示，过长截断） */
const shortLabel = (name: string): string => (name.length > 24 ? name.slice(0, 21) + '…' : name)

/** 席位名明细文案（前 3 个 + 等 N 个） */
const detailOf = (names: string[]): string =>
  names.slice(0, 3).map(shortLabel).join('、') + (names.length > 3 ? ` 等 ${names.length} 个` : '')

/**
 * 主席团模式「AI 生成专家团」折叠面板（生成即写入，无中间预览/确认步骤）：
 * 输入任务需求 → 主进程生成专家（推荐数量 + 角色名 + 提示词）
 * → 直接写入下方子模型卡片（角色名 / 提示词 / 席位自动扩充缩减）并落库；
 * 微调在下方卡片内进行（自定义角色 = 短名 + 完整介绍，介绍文本域直接可见可编辑）。
 * 席位调整算法见 utils/expertTeam.ts（纯函数，独立测试）。
 */
export default function ExpertTeamSection({ subModels, setSubModels, notifySaveResult }: ExpertTeamSectionProps) {
  const providers = useConfigStore((s) => s.providers)

  const [open, setOpen] = useState(false)
  const [requirement, setRequirement] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 生成成功后的结果行（专家数 / 席位变化 / 跳过明细；含「已写入本地未落库」提示）
  const [applied, setApplied] = useState<string | null>(null)
  // 是否已生成过（按钮文案：生成专家团 / 重新生成）
  const [generated, setGenerated] = useState(false)

  // 全量模型选项（与 MoASection 同构：不按 apiKey 过滤）
  const allModelOptions = useMemo<ModelOption[]>(
    () => providers.flatMap((p) => (p.models || []).map((m) => ({ label: `${p.name} · ${m.id}`, value: `${p.id}:${m.id}` }))),
    [providers]
  )

  const handleGenerate = async () => {
    const req = requirement.trim()
    if (!req || loading) return
    setLoading(true)
    setError(null)
    try {
      const res: any = await window.moaAPI.generateExperts({
        requirement: req,
        seats: subModels.map((s) => s.modelId)
      })
      if (res?.success === false) throw new Error(res?.error || '生成失败')
      const data = res?.data as ExpertTeamPlan | undefined
      if (!data || !Array.isArray(data.experts) || data.experts.length === 0) throw new Error('生成结果为空')

      // 直接应用：默认分配（前 min(M,N) 个映射现有席位，新增席位复用第一个子模型）→ 席位自动扩充/缩减
      const drafts = initialDrafts(data.experts, subModels, allModelOptions)
      const plan = buildImportPlan(subModels, allModelOptions, drafts)
      if (plan.subModels.length === 0) {
        throw new Error('没有可写入的专家：请先在「设置 → 厂商」配置可用模型')
      }

      // 本地 state 立即生效（落库失败也保留，用户可手动「保存配置」重试）
      setSubModels(plan.subModels)
      let saved = true
      try {
        const save: any = await window.moaAPI.setMoaConfig({ subModels: plan.subModels })
        if (save?.success === false) throw new Error(save?.error || '保存失败')
        notifySaveResult(true)
      } catch (err) {
        saved = false
        notifySaveResult(false, String(err))
      }

      const parts: string[] = [`已生成 ${plan.subModels.length} 个专家`]
      if (plan.changes.expanded.length > 0) {
        parts.push(`新增 ${plan.changes.expanded.length} 个席位（${detailOf(plan.changes.expanded.map((c) => c.name))}）`)
      }
      if (plan.changes.shrunk.length > 0) {
        parts.push(`移除 ${plan.changes.shrunk.length} 个席位（${detailOf(plan.changes.shrunk.map((c) => c.name))}）`)
      }
      if (plan.skipped > 0) {
        parts.push(`${plan.skipped} 个专家因无可用模型未写入`)
      }
      if (!saved) parts.push('已写入本地但保存失败，请点「保存配置」重试')
      setApplied(parts.join('；'))
      setGenerated(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
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

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={handleGenerate}
              disabled={!requirement.trim() || loading}
              className="inline-flex items-center gap-1.5 px-3 py-1 text-xs bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50 shrink-0"
            >
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
              {loading ? '生成中…' : generated ? '重新生成' : '生成专家团'}
            </button>
            <span className="text-xs text-muted-foreground/70">生成后直接写入下方专家席位（按推荐数量自动扩充/缩减）</span>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
          {applied && <p className="text-xs text-primary">{applied}</p>}
        </div>
      )}
    </div>
  )
}
