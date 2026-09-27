// ─── 云监控来源折叠状态（渲染层 UI 偏好） ───
// 折叠状态按**源 id** 键控：CloudMonitorView 随视图切换整体卸载（App.tsx 条件渲染），
// 组件 state 会丢；UI 偏好也不该进 settings 配置结构 —— 存 localStorage
// （先例：侧栏主题 moa-theme）。
// 存储形态：JSON 数组，仅列出**已折叠**的源 id；列表外的源一律视为展开
// （新增源 / 新增账号天然默认展开，无迁移成本）。
// 模块级 Map 作会话内真相源：localStorage 不可用或写入失败（隐私模式 / 配额）时，
// 折叠交互本次会话内仍然有效，只是不跨重启保持。

const STORAGE_KEY = 'moa-cloud-collapsed-sources'

/** 会话内真相源（首次访问时从 localStorage 载入一次） */
const cache = new Map<string, boolean>()
let loaded = false

/** localStorage 是外部持久化边界：不可用（非浏览器环境 / 被禁）时按无存储处理 */
function storage(): Storage | null {
  try {
    const g = globalThis as { localStorage?: Storage }
    return g.localStorage ?? null
  } catch {
    return null
  }
}

function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  const store = storage()
  if (!store) return
  try {
    const raw = store.getItem(STORAGE_KEY)
    if (!raw) return
    const ids: unknown = JSON.parse(raw)
    if (!Array.isArray(ids)) return
    for (const id of ids) {
      if (typeof id === 'string' && id) cache.set(id, true)
    }
  } catch {
    // 损坏 JSON：按「无折叠记录」处理，不中断页面
  }
}

/** 该源当前是否折叠（未记录 = 展开） */
export function isSourceCollapsed(sourceId: string): boolean {
  ensureLoaded()
  return cache.get(sourceId) ?? false
}

/** 记录折叠状态（localStorage 写入失败只影响跨重启保持，不阻断交互） */
export function setSourceCollapsed(sourceId: string, collapsed: boolean): void {
  ensureLoaded()
  cache.set(sourceId, collapsed)
  const store = storage()
  if (!store) return
  try {
    const ids = [...cache.entries()].filter(([, v]) => v).map(([k]) => k)
    store.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // 配额 / 隐私模式：忽略
  }
}
