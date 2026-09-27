// ─── OpenCode Go 云端用量监控客户端 ───
// 职责：
//   1. 用量拉取：GET /zen/go/v1/usage（Authorization: Bearer <Provider API Key>）
//      → 归一化为 OpenCodeUsage.windows（5 小时滚动 / 周 / 月 三个用量窗口）
//   2. 模型明细：GET /console/api/v2/usage/export?scope=organization&range=30d（Accept: text/csv）
//      → 最近 30 个 UTC 日「天 × 模型」行 → 聚合为按模型汇总（OpenCodeUsage.models）+ 落库本地累计
//   3. 无登录窗：OpenCode Go 无 cookie 通道，凭据唯一路径 = 面板粘贴 API Key
//      （opencode.ai/auth 控制台创建，对应 MONITOR_SET_API_KEY IPC）
// 网络请求统一走 fetchProxy（尊重用户的网络代理设置）。
// 区块级降级：windows 失败 → 整体失败（错误码照旧）；detail 失败（401/403 / 非 200 / CSV 不识别）
//   → sourcesAvailable.detail = false，三卡照常展示；明细成功时落库本地累计（usageAccumulator）。
// —— 回归测试（test-e2e/opencode-request.cjs）stub fetchProxy + keyStore + usageAccumulator 三个模块。

import { fetchProxy } from '../local/fetchProxy'
import { getUsageCredential, removeUsageCredential } from '../store/key-store'
import { persistUsageRecords, type AccumulatedRecordInput } from './usageAccumulator'
import type { MonitorStatus, OpenCodeUsage, OpenCodeWindowInfo } from '../../shared/types'

const API_BASE = 'https://opencode.ai'
/** 用量端点（实测 2026-09-27：GET 200；HEAD 恒 401 → 必须 GET） */
const USAGE_PATH = '/zen/go/v1/usage'
/** 明细导出端点（实测 2026-09-27：v2 可用；v1 对 Go key 恒 403，已废弃） */
const EXPORT_PATH = '/console/api/v2/usage/export'
/** 明细 range（v2 只支持 7d / 30d，24h → 400）：固定 30d 覆盖最长 */
const EXPORT_RANGE = '30d'
/** 明细 range 对应天数（口径标注用） */
const EXPORT_RANGE_DAYS = 30
/** usage export CSV 表头（14 列逐字校验；服务端改形态 → 表头不符 → null → 区块级降级，不猜） */
const EXPORT_HEADER = [
  'day', 'user_type', 'user_id', 'user_name', 'provider', 'model', 'requests',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_5m_tokens',
  'cache_write_1h_tokens', 'cost_micro_cents', 'last_active_at'
] as const

// ─── 凭证 key 约定（与 commandCode 一致；按**账号**键控，默认账号 id = 源 id）───

export function usageApiKeyKey(accountId: string): string {
  return `${accountId}.apiKey`
}

/** 查询某账号的认证状态：无 cookie 概念，两字段同值（UI 只看 hasApiKey） */
export function getOpenCodeStatus(accountId: string): MonitorStatus {
  const hasApiKey = !!getUsageCredential(usageApiKeyKey(accountId))
  return { loggedIn: hasApiKey, hasApiKey }
}

/** 清除某账号的 API Key（只动本账号；同源其它账号不受影响） */
export function logoutOpenCode(accountId: string): void {
  removeUsageCredential(usageApiKeyKey(accountId))
}

// ─── 防御性解析（本文件自带一份，不依赖 commandCode 导出）───

function toNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object'
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

/** 时间字段归一化为 epoch 秒：兼容 ISO 字符串 / epoch 秒 / epoch 毫秒（与 UsageWindowInfo.resetAt 同口径） */
function toEpochSec(v: unknown): number | undefined {
  let n: number | undefined
  if (typeof v === 'number' && Number.isFinite(v)) {
    n = v
  } else if (typeof v === 'string' && v.trim() !== '') {
    const num = Number(v)
    n = Number.isFinite(num) && num > 1e6 ? num : Date.parse(v)
  }
  if (n === undefined || !Number.isFinite(n)) return undefined
  return n > 1e12 ? Math.round(n / 1000) : Math.round(n)
}

/** 解析单个用量窗口（一层结构校验）：status 原样；percent 数值夹取 [0,100]；resetsAt 归一为 epoch 秒 */
function parseWindow(w: unknown): OpenCodeWindowInfo | undefined {
  if (!isObj(w)) return undefined
  const info: OpenCodeWindowInfo = {}
  const status = str(w.status)
  if (status) info.status = status
  const percent = toNum(w.percent)
  if (percent !== undefined) info.usedPercent = Math.min(100, Math.max(0, percent))
  const resetAt = toEpochSec(w.resetsAt)
  if (resetAt !== undefined) info.resetAt = resetAt
  return Object.keys(info).length > 0 ? info : undefined
}

/**
 * 解析用量响应（实测形态 2026-09-27）：
 *   { usage: { rolling: { status, percent, resetsAt }, weekly: {...}, monthly: {...} } }
 * 只做一层结构校验（服务端契约已实测，不做多余嵌套容错）：body.usage 是对象 →
 * 各窗口过 parseWindow；一个窗口都解析不出 → null（调用方按「结构不识别」处理）。
 */
export function parseOpenCodeUsage(body: unknown): OpenCodeUsage['windows'] | null {
  if (!isObj(body)) return null
  const usage = isObj(body.usage) ? body.usage : null
  if (!usage) return null
  const windows: OpenCodeUsage['windows'] = {}
  const rolling = parseWindow(usage.rolling)
  const weekly = parseWindow(usage.weekly)
  const monthly = parseWindow(usage.monthly)
  if (rolling) windows.rolling = rolling
  if (weekly) windows.weekly = weekly
  if (monthly) windows.monthly = monthly
  return Object.keys(windows).length > 0 ? windows : null
}

// ─── 明细导出 CSV（v2 usage export：按「天 × 模型」聚合行）───

/** 明细导出单行（已归一：数值缺省 0、成本折算 USD、tokensTotal 五字段之和） */
export interface ExportRow {
  /** 日期键 'YYYY-MM-DD'（本地累计自然键 = `${day}|${model}`） */
  day: string
  /** 日期 epoch 毫秒（UTC 零点；无法解析时省略） */
  dayTs?: number
  model: string
  requests: number
  tokensIn: number
  tokensOut: number
  cacheReadTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
  /** 总 Tokens 口径 = 输入 + 输出 + 缓存读取 + 缓存写入（5 分钟 + 1 小时） */
  tokensTotal: number
  /** 等价成本（USD；cost_micro_cents / 1e8） */
  cost: number
}

/**
 * 解析 usage export CSV（实测 2026-09-27：14 列、CRLF、无引号包裹、无逗号内嵌）。
 * 表头 14 列逐字校验（兼容 BOM 前缀），不符 → null（结构不识别 → 明细区块降级，不猜形态）；
 * 行按换行拆（兼容 \r\n 与 \n）；列数与表头不一致（不足 = 截断；多余 = 字段内嵌逗号，错位后是脏数据）的行跳过并计数；数值 toNum 缺省 0；day → UTC 零点。
 * 不做完整 CSV 引号解析：实测无引号，服务端若改形态 → 表头/列数校验兜底降级。
 */
export function parseUsageExportCsv(text: string): ExportRow[] | null {
  const lines = text.split('\n')
  const headerCols = (lines[0] ?? '').replace(/^\uFEFF/, '').replace(/\r$/, '').split(',')
  if (headerCols.length !== EXPORT_HEADER.length || !headerCols.every((c, i) => c === EXPORT_HEADER[i])) {
    return null
  }
  const rows: ExportRow[] = []
  let skipped = 0
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '')
    if (line.trim() === '') continue
    const f = line.split(',')
    // 列数与表头不一致的行跳过（结构漂移的局部兜底）；表头已逐字校验，不猜测补位
    if (f.length !== EXPORT_HEADER.length) {
      skipped += 1
      continue
    }
    const day = f[0].trim()
    const model = f[5].trim()
    if (!day || !model) {
      skipped += 1
      continue
    }
    const tokensIn = toNum(f[7]) ?? 0
    const tokensOut = toNum(f[8]) ?? 0
    const cacheReadTokens = toNum(f[9]) ?? 0
    const cacheWrite5mTokens = toNum(f[10]) ?? 0
    const cacheWrite1hTokens = toNum(f[11]) ?? 0
    const dayTs = Date.parse(`${day}T00:00:00Z`)
    rows.push({
      day,
      ...(Number.isFinite(dayTs) ? { dayTs } : {}),
      model,
      requests: toNum(f[6]) ?? 0,
      tokensIn,
      tokensOut,
      cacheReadTokens,
      cacheWrite5mTokens,
      cacheWrite1hTokens,
      tokensTotal: tokensIn + tokensOut + cacheReadTokens + cacheWrite5mTokens + cacheWrite1hTokens,
      cost: (toNum(f[12]) ?? 0) / 1e8
    })
  }
  if (skipped > 0) {
    console.warn(`[Monitor] OpenCode export CSV 跳过 ${skipped} 行列数不一致/缺关键字段`)
  }
  return rows
}

/** 把「天 × 模型」行按模型 SUM（requests / tokens / cost），成本降序（tokensTotal 次之） */
export function aggregateExportRows(rows: ExportRow[]): NonNullable<OpenCodeUsage['models']> {
  const map = new Map<
    string,
    { model: string; requests: number; cost: number; tokensIn: number; tokensOut: number; cacheReadTokens: number; tokensTotal: number }
  >()
  for (const r of rows) {
    const agg =
      map.get(r.model) ?? { model: r.model, requests: 0, cost: 0, tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, tokensTotal: 0 }
    agg.requests += r.requests
    agg.cost += r.cost
    agg.tokensIn += r.tokensIn
    agg.tokensOut += r.tokensOut
    agg.cacheReadTokens += r.cacheReadTokens
    agg.tokensTotal += r.tokensTotal
    map.set(r.model, agg)
  }
  return Array.from(map.values()).sort((a, b) => b.cost - a.cost || b.tokensTotal - a.tokensTotal)
}

// ─── 主入口：拉取并归一化 ───

export type OpenCodeRefreshResult =
  | { ok: true; data: OpenCodeUsage; /** 本次明细落库影响的累计行数（新增或数值变化；供采集器统计） */ persisted: number }
  | { ok: false; code: 'not_authenticated' | 'session_expired' | 'network' | 'unknown'; error?: string }

/**
 * 拉取某**账号**的 OpenCode Go 用量（凭据 / 明细落库 / 日志一律按 accountId）。
 * 双端点：
 *   ① windows（/zen/go/v1/usage）——失败 → 整体失败：无 key → not_authenticated；fetch 抛错 → network；
 *      401/403 → session_expired（API Key 失效）；非 200 → unknown(HTTP n)；结构不识别 → unknown。
 *   ② detail（/console/api/v2/usage/export，Accept: text/csv）——失败 → 区块级降级（detail=false），整体仍 ok；
 *      成功 → 聚合为 models + 落库本地累计（persistUsageRecords，id = `${day}|${model}`）。
 * 不写快照（快照由 index.ts 的 MONITOR_REFRESH 统一 saveUsageSnapshot）。
 */
export async function refreshOpenCodeUsage(accountId: string): Promise<OpenCodeRefreshResult> {
  const apiKey = getUsageCredential(usageApiKeyKey(accountId))
  if (!apiKey) return { ok: false, code: 'not_authenticated' }

  let status: number
  let body: unknown
  try {
    const resp = await fetchProxy(`${API_BASE}${USAGE_PATH}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'User-Agent': 'moa-desktop'
      }
    })
    status = resp.status
    body = await resp.json().catch(() => null)
  } catch (err) {
    // 超时与重试统一由 fetchProxy 处理（配置见「云端用量监控」页的 API 请求设置）
    return { ok: false, code: 'network', error: err instanceof Error ? err.message : String(err) }
  }

  if (status === 401 || status === 403) return { ok: false, code: 'session_expired' }
  if (status !== 200) return { ok: false, code: 'unknown', error: `HTTP ${status}` }

  const windows = parseOpenCodeUsage(body)
  if (!windows) {
    console.warn(`[Monitor] refresh(${accountId}) OpenCode 响应结构无法识别`)
    return { ok: false, code: 'unknown', error: '响应结构无法识别' }
  }

  // ② 明细（区块级降级：401/403 / 非 200 / 网络失败 / CSV 不识别 → detail=false，三卡照常）
  let detail = false
  let models: OpenCodeUsage['models']
  let modelsCoverage: OpenCodeUsage['modelsCoverage']
  let persisted = 0
  try {
    const resp = await fetchProxy(`${API_BASE}${EXPORT_PATH}?scope=organization&range=${EXPORT_RANGE}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'text/csv',
        'User-Agent': 'moa-desktop'
      }
    })
    if (resp.status === 200) {
      const rows = parseUsageExportCsv(await resp.text())
      if (rows) {
        detail = true
        if (rows.length > 0) {
          models = aggregateExportRows(rows)
          const dayTsList = rows.map((r) => r.dayTs).filter((t): t is number => t !== undefined)
          modelsCoverage = {
            rangeDays: EXPORT_RANGE_DAYS,
            days: new Set(rows.map((r) => r.day)).size,
            rows: rows.length,
            ...(dayTsList.length > 0 ? { fromTs: Math.min(...dayTsList), toTs: Math.max(...dayTsList) } : {})
          }
          // 累积落库（本地累计口径）：自然键 = `${day}|${model}`，行值随当日用量增长 → upsert 覆盖；失败不影响本次展示
          try {
            const records: AccumulatedRecordInput[] = rows.map((r) => ({
              id: `${r.day}|${r.model}`,
              ...(r.dayTs !== undefined ? { createdAtMs: r.dayTs } : {}),
              model: r.model,
              tokensIn: r.tokensIn,
              tokensOut: r.tokensOut,
              tokensTotal: r.tokensTotal,
              cost: r.cost,
              requests: r.requests
            }))
            persisted = persistUsageRecords(accountId, records)
          } catch (err) {
            console.warn('[Monitor] OpenCode 用量记录落库失败:', err)
          }
        }
      } else {
        console.warn(`[Monitor] refresh(${accountId}) OpenCode export CSV 结构不识别 → 明细区块降级`)
      }
    } else {
      console.warn(`[Monitor] refresh(${accountId}) OpenCode export HTTP ${resp.status} → 明细区块降级`)
    }
  } catch (err) {
    console.warn(
      `[Monitor] refresh(${accountId}) OpenCode export 请求失败: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  return {
    ok: true,
    data: {
      fetchedAt: Date.now(),
      sourcesAvailable: { windows: true, detail },
      windows,
      ...(models ? { models } : {}),
      ...(modelsCoverage ? { modelsCoverage } : {})
    },
    persisted
  }
}
