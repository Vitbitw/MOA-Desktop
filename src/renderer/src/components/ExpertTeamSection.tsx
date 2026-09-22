import React, { useMemo, useState } from 'react'
import { Sparkles, Loader2, ChevronDown } from 'lucide-react'
import { useConfigStore } from '../store/configStore'
import { buildImportPlan, initialDrafts, type ModelOption } from '../utils/expertTeam'
import type { SubModelConfig, ExpertScale, ClarifyTurn, ExpertGenResult } from '../../../shared/types'

interface ExpertTeamSectionProps {
  subModels: SubModelConfig[]
  setSubModels: React.Dispatch<React.SetStateAction<SubModelConfig[]>>
  notifySaveResult: (ok: boolean, detail?: string) => void
}

/** 细分程度三档元数据（label = 按钮文案；hint = 右侧灰字说明；tip = title tooltip） */
const SCALE_META: Record<ExpertScale, { label: string; hint: string; tip: string }> = {
  few: { label: '偏少', hint: '团队精干，少而全', tip: '专家少而全，每轮 MoA 调用数少、成本低' },
  normal: { label: '正常', hint: '均衡覆盖关键维度', tip: '均衡覆盖任务关键维度' },
  more: { label: '较多', hint: '细分方向，覆盖更全', tip: '按细分方向展开，覆盖更全；专家越多每轮模型调用数与 token 成本越高' }
}

/** 席位名短显（结果行内联展示，过长截断） */
const shortLabel = (name: string): string => (name.length > 24 ? name.slice(0, 21) + '…' : name)

/** 席位名明细文案（前 3 个 + 等 N 个） */
const detailOf = (names: string[]): string =>
  names.slice(0, 3).map(shortLabel).join('、') + (names.length > 3 ? ` 等 ${names.length} 个` : '')

/**
 * 主席团模式「AI 生成专家团」折叠面板（生成即写入，无中间预览/确认步骤）：
 * 输入任务需求 → 选细分程度（偏少 / 正常 / 较多）→ 主进程生成专家（推荐数量 + 角色名 + 提示词），
 * 需求不足以确定专家构成时 AI 先追问（多轮，无开关自动判断）：已答轮次只读展示 + 每问一个输入框，
 * 「继续生成」提交本轮回答、「直接生成」跳过追问直出；
 * 生成完成后直接写入下方子模型卡片（角色名 / 提示词 / 席位自动扩充缩减）并落库；
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
  // 细分程度（仅作用于本次生成，不持久化）
  const [scale, setScale] = useState<ExpertScale>('normal')
  // 已提交的问答轮
  const [turns, setTurns] = useState<ClarifyTurn[]>([])
  // 追问卡片（AI 待确认的问题；null = 无追问）
  const [pending, setPending] = useState<{ questions: string[]; reason?: string } | null>(null)
  // pending 作答草稿（与 pending.questions 等长；项可为空串）
  const [answers, setAnswers] = useState<string[]>([])

  // 全量模型选项（与 MoASection 同构：不按 apiKey 过滤；label 带计费通道徽标）
  const allModelOptions = useMemo<ModelOption[]>(
    () => providers.flatMap((p) => (p.models || []).map((m) => ({ label: `${p.name} · ${m.id}（${p.billing === 'plan' ? 'Plan' : '按量'}）`, value: `${p.id}:${m.id}` }))),
    [providers]
  )

  /** force: 直接生成（跳过追问）；reset: 先清空追问历史再重新开始（主按钮用） */
  const submit = async (opts: { force: boolean; reset?: boolean }) => {
    const req = requirement.trim()
    if (!req || loading) return
    setLoading(true)
    setError(null)
    const baseTurns = opts.reset ? [] : turns
    const history: ClarifyTurn[] = pending
      ? [...baseTurns, { questions: pending.questions, answers: pending.questions.map((_, i) => (answers[i] ?? '').trim()) }]
      : baseTurns
    try {
      const res: any = await window.moaAPI.generateExperts({
        requirement: req,
        seats: subModels.map((s) => s.modelId),
        scale,
        ...(history.length > 0 ? { history } : {}),
        ...(opts.force ? { forceGenerate: true } : {})
      })
      if (res?.success === false) throw new Error(res?.error || '生成失败')
      const data = res?.data as ExpertGenResult | undefined
      if (!data || typeof data !== 'object') throw new Error('生成结果为空')

      // ① 追问分支：更新 turns/pending/answers，不写入席位
      if (data.kind === 'clarify') {
        const qs = Array.isArray(data.questions) ? data.questions.filter((q) => typeof q === 'string' && q.trim()) : []
        if (qs.length === 0) throw new Error('生成结果为空')
        setTurns(history)
        setPending({ questions: qs, ...(typeof data.reason === 'string' && data.reason.trim() ? { reason: data.reason.trim() } : {}) })
        setAnswers(qs.map(() => ''))
        return
      }

      // ② 生成分支：完全沿用现有写入链路（initialDrafts → buildImportPlan → setSubModels → 落库 → 结果行）
      if (data.kind !== 'plan' || !Array.isArray(data.experts) || data.experts.length === 0) throw new Error('生成结果为空')
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
      // 追问历史与卡片一并消失，仅留结果行
      setTurns([])
      setPending(null)
      setAnswers([])
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

          {/* 细分程度档位（分段控件；追问进行中禁用，档位只作用于本次生成） */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground shrink-0">细分程度</span>
            <div className="flex rounded-md border border-border overflow-hidden">
              {(['few', 'normal', 'more'] as ExpertScale[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setScale(s)}
                  disabled={loading || pending !== null}
                  title={SCALE_META[s].tip}
                  className={`px-2.5 py-1 text-xs transition-colors ${scale === s ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:text-foreground'}`}
                >
                  {SCALE_META[s].label}
                </button>
              ))}
            </div>
            <span className="text-xs text-muted-foreground/70">{SCALE_META[scale].hint}</span>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => submit({ force: false, reset: true })}
              disabled={!requirement.trim() || loading || pending !== null}
              className="inline-flex items-center gap-1.5 px-3 py-1 text-xs bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50 shrink-0"
            >
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
              {loading ? '生成中…' : generated ? '重新生成' : '生成专家团'}
            </button>
            <span className="text-xs text-muted-foreground/70">生成后直接写入下方专家席位（按推荐数量自动扩充/缩减）</span>
          </div>

          {/* 追问卡片（pending 非 null 时显示；追问进行中由本卡片承接流程） */}
          {pending !== null && (
            <div className="rounded-md border border-border bg-background p-2 space-y-2">
              {/* 已答轮次（只读） */}
              {turns.length > 0 && (
                <div className="space-y-1.5">
                  {turns.map((t, ti) => (
                    <div key={ti} className="text-xs space-y-0.5">
                      <p className="text-muted-foreground">第 {ti + 1} 轮</p>
                      {t.questions.map((q, qi) => (
                        <div key={qi}>
                          <p className="text-foreground">Q：{q}</p>
                          <p className="text-muted-foreground">A：{t.answers[qi] ? t.answers[qi] : '（未补充）'}</p>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              {/* 本轮问题 + 输入（每问一个 textarea，可留空） */}
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">AI 想先确认几个问题{pending.reason ? `：${pending.reason}` : ''}</p>
                {pending.questions.map((q, i) => (
                  <div key={i} className="space-y-1">
                    <p className="text-xs text-foreground">{q}</p>
                    <textarea
                      value={answers[i] ?? ''}
                      onChange={(e) => setAnswers((prev) => { const next = [...prev]; next[i] = e.target.value; return next })}
                      rows={2}
                      placeholder="回答（可留空）"
                      disabled={loading}
                      className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                    />
                  </div>
                ))}
              </div>
              {/* 提交 / 跳过 */}
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => submit({ force: false })}
                  disabled={loading}
                  className="inline-flex items-center gap-1.5 px-3 py-1 text-xs bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50"
                >
                  {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                  {loading ? '生成中…' : '继续生成'}
                </button>
                <button
                  onClick={() => submit({ force: true })}
                  disabled={loading}
                  className="inline-flex items-center gap-1.5 px-3 py-1 text-xs border border-border rounded-md text-foreground hover:bg-muted disabled:opacity-50"
                >
                  直接生成
                </button>
              </div>
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
          {applied && <p className="text-xs text-primary">{applied}</p>}
        </div>
      )}
    </div>
  )
}
