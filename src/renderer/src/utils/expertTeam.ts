import type { SubModelConfig, GeneratedExpert, SubModelRole } from '../../../shared/types'
import { splitModelKey } from '../../../shared/modelKey'

/** 模型下拉选项（与 MoASection 的 allModelOptions 同形） */
export interface ModelOption {
  /** 'providerId:modelId' */
  value: string
  label: string
}

/** 专家团预览草案（可编辑） */
export interface ExpertDraft {
  name: string
  prompt: string
  /** 分配模型 'providerId:modelId'；'' = 无可用模型（该项不导入） */
  modelKey: string
}

export interface ImportPlan {
  /** 最终 subModels（已按 order 重排、赋新 id、role 清空） */
  subModels: SubModelConfig[]
  /** 未能导入的草案数（modelKey 为空或不在池中） */
  skipped: number
  /** 席位变化摘要（UI 展示用；name = 席位展示名，见 seatDisplayName） */
  changes: {
    /** 自动新增的席位（按席位计数，模型可重复） */
    expanded: Array<{ name: string }>
    /** 被移除的席位（其原有角色/提示词将一并移除） */
    shrunk: Array<{ name: string }>
  }
}

/** 现有席位 → 'providerId:modelId' key */
const seatKey = (sm: SubModelConfig): string => `${sm.providerId}:${sm.modelId}`

/**
 * 席位展示名（结果行「新增/移除 N 个席位（…）」括号内文案）：
 * 席位名（新增=草案专家名 / 移除=原 expertName）trim 后为空 → 回退模型名，保证括号内不出现空项。
 */
const seatDisplayName = (expertName: string | undefined, modelId: string): string => expertName?.trim() || modelId

/**
 * 切换席位所用模型（设置面板席位下拉）：
 * - 只替换 providerId/modelId，其余字段（id/order/role/systemPrompt/expertName）原样保留
 *   （替代「删除再添加」——后者会丢角色/提示词/专家名）；
 * - modelKey 含冒号 modelId 无损（splitModelKey 按首个冒号切分）；
 * - providerId 或 modelId 为空串的非法 key → 返回 null，调用方跳过（不写入畸形模型）。
 */
export function switchSeatModel(seat: SubModelConfig, modelKey: string): SubModelConfig | null {
  const { providerId, modelId } = splitModelKey(modelKey)
  if (!providerId || !modelId) return null
  return { ...seat, providerId, modelId }
}

/**
 * 生成完成后初始化预览草案（设计文档 §5.5）：
 * - 前 min(M, N) 个专家依次映射现有席位模型（N = existing.length）；
 * - 其余专家（新增席位）默认复用第一个子专家的模型（生成时点快照，后续不联动）；
 * - 无现有席位时回退模型池首个模型（池空则 ''，预览中标灰、导入时跳过）。
 */
export function initialDrafts(experts: GeneratedExpert[], existing: SubModelConfig[], pool: ModelOption[]): ExpertDraft[] {
  const newSeatKey = existing[0] ? seatKey(existing[0]) : pool[0]?.value ?? ''
  return experts.map((e, i) => ({
    name: e.name,
    prompt: e.prompt,
    modelKey: existing[i] ? seatKey(existing[i]) : newSeatKey
  }))
}

/**
 * 生成导入计划（设计文档 §5.5）：
 * - 校验：modelKey 为空或不在模型池中 → 计入 skipped，不导入；其余按序保留；
 * - 写入：每项新 uuid / order 按序 0..k-1 / role 清空 / systemPrompt=prompt / expertName=name；
 * - 允许同一模型重复占席（不做去重）；
 * - changes 按席位位置计数：expanded = valid 超出现有的尾段，shrunk = existing 被移除的尾段；
 *   展示名取席位名（新增=草案 name / 移除=原 expertName），空名回退模型名（UI 结果行括号内不显示模型名）。
 */
export function buildImportPlan(existing: SubModelConfig[], pool: ModelOption[], drafts: ExpertDraft[]): ImportPlan {
  const poolValues = new Set(pool.map((o) => o.value))
  const valid = drafts.filter((d) => d.modelKey !== '' && poolValues.has(d.modelKey))

  const subModels: SubModelConfig[] = valid.map((d, i) => {
    const { providerId, modelId } = splitModelKey(d.modelKey)
    // 专家名写入前 trim（用户手编可能带首尾空白；显示层以 trim 后判定/展示，避免三处口径不一）
    // trim 后为空 → undefined（JSON 序列化省略键，等价于「无专家名」）
    const expertName = d.name.trim()
    return {
      id: crypto.randomUUID(),
      providerId,
      modelId,
      order: i,
      role: '' as SubModelRole,
      systemPrompt: d.prompt,
      expertName: expertName || undefined
    }
  })

  return {
    subModels,
    skipped: drafts.length - valid.length,
    changes: {
      expanded:
        valid.length > existing.length
          ? valid.slice(existing.length).map((d) => ({ name: seatDisplayName(d.name, splitModelKey(d.modelKey).modelId) }))
          : [],
      shrunk:
        existing.length > valid.length
          ? existing.slice(valid.length).map((s) => ({ name: seatDisplayName(s.expertName, s.modelId) }))
          : []
    }
  }
}
