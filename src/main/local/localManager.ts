import crypto from 'node:crypto'
import { getDatabase } from '../db/database'
import type { DetectedEngine, LocalEngine, LocalEngineStatus, LocalEngineType } from '../../shared/types'

interface EngineRow {
  id: string; name: string; engine_type: string; base_url: string; binary_path: string | null
  port: number | null; status: string; version: string | null; created_at: number
}

function rowToEngine(row: EngineRow): LocalEngine {
  return {
    id: row.id,
    name: row.name,
    engineType: row.engine_type as LocalEngineType,
    baseUrl: row.base_url,
    binaryPath: row.binary_path || undefined,
    port: row.port ?? undefined,
    status: (row.status || 'stopped') as LocalEngineStatus,
    version: row.version || undefined,
    createdAt: row.created_at
  }
}

export function listLocalEngines(): LocalEngine[] {
  return getDatabase().query<EngineRow>('SELECT * FROM local_engines ORDER BY created_at')
    .map(rowToEngine)
}

export function getLocalEngine(id: string): LocalEngine | null {
  const row = getDatabase().queryOne<EngineRow>('SELECT * FROM local_engines WHERE id = ?', [id])
  return row ? rowToEngine(row) : null
}

export function upsertDetectedEngine(detected: DetectedEngine): { id: string; created: boolean } {
  const db = getDatabase()
  // R8：manual 按地址唯一，其余按类型唯一
  const matchSql = detected.engineType === 'manual'
    ? 'SELECT * FROM local_engines WHERE engine_type = ? AND base_url = ?'
    : 'SELECT * FROM local_engines WHERE engine_type = ?'
  const matchParams = detected.engineType === 'manual'
    ? [detected.engineType, detected.baseUrl]
    : [detected.engineType]
  const existing = db.queryOne<EngineRow>(matchSql, matchParams)
  if (existing) {
    db.exec(
      'UPDATE local_engines SET name = ?, base_url = ?, port = ?, version = ?, status = ? WHERE id = ?',
      [detected.name, detected.baseUrl, detected.port, detected.version || null,
       detected.reachable ? 'running' : 'stopped', existing.id]
    )
    syncEngineProvider(existing.id, detected)
    return { id: existing.id, created: false }
  }
  const id = crypto.randomUUID()
  db.exec(
    `INSERT INTO local_engines (id, name, engine_type, base_url, port, status, version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, detected.name, detected.engineType, detected.baseUrl, detected.port || null,
     detected.reachable ? 'running' : 'stopped', detected.version || null, Date.now()]
  )
  syncEngineProvider(id, detected)
  return { id, created: true }
}

/**
 * 为引擎创建/更新对应的本地 provider 行。
 * R12：离线引擎只禁用已有 provider（或不动），绝不新建可用 provider。
 * R13：恢复在线时按 engine_id 复用旧 provider 行并 enabled=1，避免重复插入。
 * 注意：detected.models 的 providerId 是空串，必须映射为实际 provider 行 id，否则 MoA 选择器依赖 model.providerId 会断。
 */
function syncEngineProvider(engineId: string, detected: DetectedEngine): void {
  const db = getDatabase()
  const providerName = `本地 · ${detected.name}`
  const row = db.queryOne<{ id: string }>('SELECT id FROM providers WHERE engine_id = ?', [engineId])
  if (!detected.reachable) {
    // R12：离线——若已存在 provider 行则禁用，不新建
    if (row) {
      db.exec('UPDATE providers SET enabled = 0 WHERE id = ?', [row.id])
    }
    return
  }
  if (row) {
    // R13：引擎恢复在线——更新并重新启用，models 映射为 row.id
    db.exec(
      'UPDATE providers SET name = ?, base_url = ?, model_list = ?, kind = \'local\', enabled = 1 WHERE id = ?',
      [providerName, detected.baseUrl,
       JSON.stringify(detected.models.map((m) => ({ ...m, providerId: row.id }))), row.id]
    )
  } else {
    // 首次在线——INSERT，model_list 一次写对（带 providerId）
    const providerId = crypto.randomUUID()
    db.exec(
      `INSERT INTO providers (id, name, base_url, model_list, enabled, created_at, kind, engine_id)
       VALUES (?, ?, ?, ?, 1, ?, 'local', ?)`,
      [providerId, providerName, detected.baseUrl,
       JSON.stringify(detected.models.map((m) => ({ ...m, providerId }))), Date.now(), engineId]
    )
  }
}

export function setEngineStatus(id: string, status: LocalEngineStatus): void {
  getDatabase().exec('UPDATE local_engines SET status = ? WHERE id = ?', [status, id])
}

export function removeEngine(id: string): void {
  getDatabase().exec('DELETE FROM local_engines WHERE id = ?', [id])
  getDatabase().exec('DELETE FROM providers WHERE engine_id = ?', [id])
}
