import { getDatabase } from '../db/database'
import type { AppSettings } from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/defaults'

/**
 * app_settings 唯一读写入口（防御边界规范 R1）。
 *
 * 全库其他地方一律通过本模块读写配置，不再自行 SELECT / JSON.parse / 校验：
 * - 读取侧的防御收敛在 readRaw + mergeSettings（各做一次）；
 * - 读路径含一次性迁移（旧 collectIntervalMinutes 并入统一自动刷新间隔，迁移结果落库）；
 * - 消费方拿到的 readAppSettings() 已做默认值合并与字段类型规范化，直接使用。
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

/** 非对象值（null / 数组 / 标量）视为未配置 */
function asObject(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}

/** 旧版「后台采集间隔」的默认值（迁移判断用：不等于它 → 视为用户显式调过） */
const LEGACY_COLLECT_INTERVAL_DEFAULT_MINUTES = 15

/**
 * 一次性迁移：旧版有两个独立间隔（页面刷新 autoRefreshMinutes / 后台采集 collectIntervalMinutes），
 * 现已合并为统一的 autoRefreshMinutes。返回迁移后的 raw（无旧字段返回 null）：
 * - 旧字段存在且非旧默认值 → 用户显式调过的采集间隔，以它为准（避免静默放慢明细采集）；
 * - 否则仅删除旧字段，沿用 autoRefreshMinutes（默认 10）。
 * 迁移结果必须落库（见 readAppSettings）：否则旧值会在每次读取时重新覆盖用户新设的值。
 */
function migrateUnifiedAutoRefresh(raw: Record<string, unknown>): Record<string, unknown> | null {
  const monitoring = asObject(raw.monitoring)
  if (!('collectIntervalMinutes' in monitoring)) return null
  const legacy = monitoring.collectIntervalMinutes
  const next: Record<string, unknown> = { ...monitoring }
  delete next.collectIntervalMinutes
  if (
    typeof legacy === 'number' &&
    Number.isFinite(legacy) &&
    legacy !== LEGACY_COLLECT_INTERVAL_DEFAULT_MINUTES
  ) {
    next.autoRefreshMinutes = Math.max(0, Math.floor(legacy))
  }
  return { ...raw, monitoring: next }
}

/**
 * 合并默认值 + 字段类型规范化（本模块唯一的"读后防御"，消费方一律免检）：
 * - 已知嵌套对象逐字段合并默认值（防旧版本只写部分字段产生"缺字段对象"）；
 * - 数组 / 对象字段遇历史垃圾值统一回退默认。
 */
function mergeSettings(raw: Record<string, unknown>): AppSettings {
  const merged = { ...DEFAULT_SETTINGS, ...raw } as AppSettings
  merged.title = { ...DEFAULT_SETTINGS.title, ...asObject(raw.title) }
  merged.proxy = { ...DEFAULT_SETTINGS.proxy, ...asObject(raw.proxy) }
  merged.network = { ...DEFAULT_SETTINGS.network, ...asObject(raw.network) }
  merged.display = { ...DEFAULT_SETTINGS.display, ...asObject(raw.display) }
  merged.monitoring = { ...DEFAULT_SETTINGS.monitoring, ...asObject(raw.monitoring) }
  merged.pricingProbe = { ...DEFAULT_SETTINGS.pricingProbe, ...asObject(raw.pricingProbe) }
  if (!Array.isArray(merged.monitoring.sources)) {
    merged.monitoring.sources = DEFAULT_SETTINGS.monitoring.sources
  }
  if (!Array.isArray(merged.pricingProbe.sources)) {
    merged.pricingProbe.sources = DEFAULT_SETTINGS.pricingProbe.sources
  }
  if (!Array.isArray(merged.probedPricing)) {
    merged.probedPricing = DEFAULT_SETTINGS.probedPricing
  }
  if (merged.pricingProbeCache !== undefined && typeof merged.pricingProbeCache !== 'object') {
    merged.pricingProbeCache = undefined
  }
  return merged
}

/**
 * 读 raw + 一次性迁移（有迁移则落库），返回迁移后的 raw。
 * 落库是必要条件：旧值若只做读时覆盖，会在后续每次读取时重新盖掉用户新设的间隔。
 */
function readMigratedRaw(): Record<string, unknown> {
  const raw = readRaw()
  const migrated = migrateUnifiedAutoRefresh(raw)
  if (!migrated) return raw
  try {
    writeRaw(migrated)
  } catch (err) {
    console.warn('[Settings] 自动刷新间隔迁移落库失败（下次读取会重试）:', err)
  }
  return migrated
}

/** 读完整应用设置（合并默认值 + 类型规范化，与 SETTINGS_GET_ALL 返回形态一致）。 */
export function readAppSettings(): AppSettings {
  return mergeSettings(readMigratedRaw())
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
  const raw = readMigratedRaw()
  mutate(raw)
  writeRaw(raw)
  return mergeSettings(raw)
}
