import { getDatabase } from '../db/database'
import type { AppSettings } from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/defaults'

/**
 * app_settings 唯一读写入口（防御边界规范 R1）。
 *
 * 全库其他地方一律通过本模块读写配置，不再自行 SELECT / JSON.parse / 校验：
 * - 读取侧的唯一防御收敛在 readRaw（DB 未初始化 / 记录缺失 / JSON 损坏 → 空对象）；
 * - 消费方拿到的 readAppSettings() 已浅合并默认值，字段齐全，直接使用。
 */

/** 读原始 JSON（不合并默认值）。仅本模块内部与读-改-写流程使用。 */
function readRaw(): Record<string, unknown> {
  const db = getDatabase()
  if (!db.isInitialized) return {}
  const row = db.queryOne<{ value: string }>(
    "SELECT value FROM moa_config WHERE key = 'app_settings'"
  )
  if (!row?.value) return {}
  try {
    return JSON.parse(row.value) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** 读完整应用设置（浅合并默认值，与 SETTINGS_GET_ALL 返回形态一致）。 */
export function readAppSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, ...readRaw() } as AppSettings
}

/** 整体写回原始对象（保持"仅存用户改过的字段"语义）。 */
function writeRaw(raw: Record<string, unknown>): void {
  getDatabase().exec(
    "INSERT OR REPLACE INTO moa_config (key, value, updated_at) VALUES ('app_settings', ?, ?)",
    [JSON.stringify(raw), Date.now()]
  )
}

/**
 * 读-改-写：在最新原始对象上执行 mutate 后整体写回。
 * 返回写回后的合并视图（免去调用方再读一次）。
 */
export function updateRawAppSettings(mutate: (raw: Record<string, unknown>) => void): AppSettings {
  const raw = readRaw()
  mutate(raw)
  writeRaw(raw)
  return { ...DEFAULT_SETTINGS, ...raw } as AppSettings
}
