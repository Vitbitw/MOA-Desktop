// ─── 用量记录本地累计（Command Code / Xiaomi MiMo） ───
// 背景：服务端 /internal/usage 对部分套餐（实测 GOAT）恒定只返回最近 100 条且不给游标，
// 明细因此只是「最近约 20 分钟」的滚动窗口。这里把每次采集到的记录按 (source_id, record_id)
// 去重累积落库，让「本地累计」口径的数字只增不减。
// MiMo：服务端给「日期×模型」聚合行（/usage/detail/list），自然键 = `${date}|${model}`，
// 行值会随当日用量增长 → 冲突时 upsert 覆盖（数值变化才计入 affected，恒等不计）。
//
// 隔离口径：列名沿用 source_id，**实际存放 MonitorAccount.id**（默认账号 id = 源 id，历史行零迁移）。
// 同源 Plan 账号与按量账号各占自己的分区，读取 / 清空都不会串到另一个账号头上。
//
// 诚实边界：两次采集之间新增 >100 条时的突发会漏采（页面/后台采集未运行时的用量同样漏采），
// 因此 UI 必须标注「自 X 起」与累计条数，不能当作云端全量。

import { getDatabase } from '../db/database'
import type { CollectorRunState, CumulativeModelUsage } from '../../shared/types'

/** 待落库的记录（由 commandCode.ts / mimo.ts 归一化后传入，避免循环依赖） */
export interface AccumulatedRecordInput {
  id: string
  createdAtMs?: number
  model: string
  tokensIn: number
  tokensOut: number
  tokensTotal: number
  cost: number
  /** 该记录代表的请求次数（CC 逐条记录 = 1；MiMo 聚合行 = 行内 requestCount）。缺省 1 */
  requests?: number
}

/**
 * 累积写入（幂等）：同一 (accountId, recordId) 重复采集只算一次；
 * 已存在但数值变化（MiMo 聚合行当日增长）时覆盖并计入返回值。
 * 返回本次真正受影响的记录数（新增或数值变化；用于日志与"是否有新数据"判断）。
 */
export function persistUsageRecords(accountId: string, rows: AccumulatedRecordInput[]): number {
  if (!accountId || rows.length === 0) return 0
  const db = getDatabase()
  const now = Date.now()
  let affected = 0
  for (const r of rows) {
    try {
      const res = db.exec(
        `INSERT INTO cc_usage_records
           (source_id, record_id, created_at, model, tokens_in, tokens_out, tokens_total, cost, requests, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id, record_id) DO UPDATE SET
           created_at   = excluded.created_at,
           model        = excluded.model,
           tokens_in    = excluded.tokens_in,
           tokens_out   = excluded.tokens_out,
           tokens_total = excluded.tokens_total,
           cost         = excluded.cost,
           requests     = excluded.requests
         WHERE cc_usage_records.created_at   != excluded.created_at
            OR cc_usage_records.model        != excluded.model
            OR cc_usage_records.tokens_in    != excluded.tokens_in
            OR cc_usage_records.tokens_out   != excluded.tokens_out
            OR cc_usage_records.tokens_total != excluded.tokens_total
            OR cc_usage_records.cost         != excluded.cost
            OR cc_usage_records.requests     != excluded.requests`,
        [
          accountId,
          r.id,
          r.createdAtMs ?? now,
          r.model,
          r.tokensIn,
          r.tokensOut,
          r.tokensTotal,
          r.cost,
          r.requests ?? 1,
          now
        ]
      )
      if (res.changes > 0) affected += 1
    } catch (err) {
      // 单条失败不影响其余记录（表结构异常时整体会抛在这里，由调用方兜底）
      console.warn('[Monitor] 累计写入失败:', err)
    }
  }
  if (affected > 0 && process.env.MOA_MONITOR_DEBUG === '1') {
    console.log(`[Monitor] 累计新增/更新 ${affected} 条（共传入 ${rows.length} 条）`)
  }
  return affected
}

/** 读取某账号的本地累计按模型用量（按成本降序；无数据时 models 为空数组） */
export function getCumulativeUsage(accountId: string): CumulativeModelUsage {
  const db = getDatabase()
  const models = db.query<{
    model: string
    requests: number
    cost: number
    tokensIn: number
    tokensOut: number
    tokensTotal: number
  }>(
    `SELECT model,
            SUM(requests) AS requests,
            SUM(cost)     AS cost,
            SUM(tokens_in) AS tokensIn,
            SUM(tokens_out) AS tokensOut,
            SUM(tokens_total) AS tokensTotal
       FROM cc_usage_records
      WHERE source_id = ?
      GROUP BY model
      ORDER BY cost DESC, tokensTotal DESC`,
    [accountId]
  )

  const meta = db.queryOne<{ cnt: number; minTs: number | null; maxTs: number | null; minSeen: number | null; maxSeen: number | null }>(
    `SELECT COUNT(*) AS cnt,
            MIN(created_at) AS minTs,
            MAX(created_at) AS maxTs,
            MIN(first_seen_at) AS minSeen,
            MAX(first_seen_at) AS maxSeen
       FROM cc_usage_records
      WHERE source_id = ?`,
    [accountId]
  )

  const num = (v: number | null | undefined): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  return {
    models: models.map((m) => ({
      model: String(m.model),
      requests: Number(m.requests) || 0,
      cost: Number(m.cost) || 0,
      tokensIn: Number(m.tokensIn) || 0,
      tokensOut: Number(m.tokensOut) || 0,
      tokensTotal: Number(m.tokensTotal) || 0
    })),
    records: num(meta?.cnt) ?? 0,
    ...(num(meta?.minTs) !== undefined ? { fromTs: num(meta?.minTs) } : {}),
    ...(num(meta?.maxTs) !== undefined ? { toTs: num(meta?.maxTs) } : {}),
    ...(num(meta?.minSeen) !== undefined ? { sinceTs: num(meta?.minSeen) } : {}),
    ...(num(meta?.maxSeen) !== undefined ? { lastCollectedAt: num(meta?.maxSeen) } : {}),
    collectorState: getCollectorState(accountId)
  }
}

/** 记录一轮采集结果（UPSERT：累计轮数 / 成功数 / 新增条数；失败时记错误码） */
export function recordCollectorRun(accountId: string, run: { ok: boolean; inserted: number; error?: string }): void {
  if (!accountId) return
  const db = getDatabase()
  const now = Date.now()
  try {
    db.exec(
      `INSERT INTO cc_collector_state (source_id, last_run_at, last_ok_at, last_error, runs, ok_runs, total_inserted)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET
         last_run_at = excluded.last_run_at,
         last_ok_at = COALESCE(excluded.last_ok_at, cc_collector_state.last_ok_at),
         last_error = excluded.last_error,
         runs = cc_collector_state.runs + 1,
         ok_runs = cc_collector_state.ok_runs + excluded.ok_runs,
         total_inserted = cc_collector_state.total_inserted + excluded.total_inserted`,
      [accountId, now, run.ok ? now : null, run.ok ? null : (run.error ?? 'unknown'), run.ok ? 1 : 0, run.inserted]
    )
  } catch (err) {
    console.warn('[Monitor] 采集状态写入失败:', err)
  }
}

/** 读取采集器运行状态（无记录时返回零值） */
export function getCollectorState(accountId: string): CollectorRunState {
  const db = getDatabase()
  const row = db.queryOne<{
    last_run_at: number | null
    last_ok_at: number | null
    last_error: string | null
    runs: number
    ok_runs: number
    total_inserted: number
  }>(
    `SELECT last_run_at, last_ok_at, last_error, runs, ok_runs, total_inserted
       FROM cc_collector_state WHERE source_id = ?`,
    [accountId]
  )
  if (!row) return { runs: 0, okRuns: 0, totalInserted: 0 }
  return {
    ...(typeof row.last_run_at === 'number' ? { lastRunAt: row.last_run_at } : {}),
    ...(typeof row.last_ok_at === 'number' ? { lastOkAt: row.last_ok_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    runs: Number(row.runs) || 0,
    okRuns: Number(row.ok_runs) || 0,
    totalInserted: Number(row.total_inserted) || 0
  }
}

/**
 * 清空某账号的本地累计（退出登录 / 删除账号时调用）：用量记录 + 采集运行状态一并清除。
 * 只清 cc_usage_records 不够——换账号后 cc_collector_state 里旧账号的轮次/插入数仍会被 UI 展示，
 * 且同一账号槽位的累计数字会与旧账号串号。
 * **只清本账号**：同源其它账号的累计与采集状态原样保留。
 */
export function clearCumulativeUsage(accountId: string): void {
  const db = getDatabase()
  db.exec('DELETE FROM cc_usage_records WHERE source_id = ?', [accountId])
  db.exec('DELETE FROM cc_collector_state WHERE source_id = ?', [accountId])
}
