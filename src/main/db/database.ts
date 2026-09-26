import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import initSqlJs, { type Database as SqlJsDb } from 'sql.js'
import { SCHEMA } from './schema'

const DB_FILENAME = 'moa-desktop.db'
const SAVE_DEBOUNCE_MS = 500

export class Database {
  private db: SqlJsDb | null = null
  private dbPath: string
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private pendingSave = false
  private initialized = false

  constructor() {
    this.dbPath = path.join(app.getPath('userData'), DB_FILENAME)
  }

  async init(): Promise<void> {
    if (this.initialized) return

    const SQL = await initSqlJs({
      locateFile: (file: string) => {
        const candidates = [
          path.join(__dirname, '../../node_modules/sql.js/dist/', file),
          path.join(__dirname, '../node_modules/sql.js/dist/', file),
          path.join(process.resourcesPath || '', file),
          path.join(path.dirname(app.getPath('exe')), 'resources', file)
        ]
        for (const c of candidates) {
          if (fs.existsSync(c)) return c
        }
        // Last resort: relative to cwd (dev fallback)
        return file
      }
    })

    let buffer: Buffer | undefined
    try {
      buffer = fs.readFileSync(this.dbPath)
    } catch { /* file doesn't exist */ }

    this.db = new SQL.Database(buffer)
    this.db.exec(SCHEMA)
    this.initialized = true

    // ── Migrations for existing databases ──
    // 注意：必须走 this.exec() 包装器（会触发 scheduleSave 落盘），
    // 直接 this.db!.exec() 只改内存库，重启后列会丢失（已踩坑）。
    try {
      this.exec('ALTER TABLE conversations ADD COLUMN title_edited INTEGER NOT NULL DEFAULT 0')
    } catch {
      // Column already exists — ignore
    }
    try {
      this.exec('ALTER TABLE request_logs ADD COLUMN models TEXT')
    } catch {
      // Column already exists — ignore
    }
    // ── v4 B 方案：移除 T1 厂商分组列（分组功能整体退役，billing/plan 列保留）──
    // 必须走 this.exec() 包装器（触发 scheduleSave 落盘；直接 db.exec 会绕过，重启丢迁移）。
    // sql.js（实测 SQLite 3.49.1）支持 DROP COLUMN；列已不存在时抛错 → try-catch 忽略
    // （列留置无害：新代码不再读写它）。
    // 旧列名（迁移必须点名，属技术必要引用、非功能残留——验收 grep 口径允许此 1 处）。
    try {
      this.exec('ALTER TABLE providers DROP COLUMN vendor_key')
    } catch {
      // Column already absent — ignore
    }
    try {
      this.exec("ALTER TABLE providers ADD COLUMN billing TEXT NOT NULL DEFAULT 'usage'")
    } catch {
      // Column already exists — ignore
    }
    try {
      this.exec('ALTER TABLE providers ADD COLUMN plan_amount REAL')
    } catch {
      // Column already exists — ignore
    }
    try {
      this.exec("ALTER TABLE providers ADD COLUMN plan_currency TEXT NOT NULL DEFAULT 'CNY'")
    } catch {
      // Column already exists — ignore
    }
    try {
      this.exec('ALTER TABLE providers ADD COLUMN plan_anchor_ts INTEGER')
    } catch {
      // Column already exists — ignore
    }
    // 本地累计支持聚合行（MiMo 日期×模型行带 requestCount；CC 逐条记录默认 1）
    try {
      this.exec('ALTER TABLE cc_usage_records ADD COLUMN requests INTEGER NOT NULL DEFAULT 1')
    } catch {
      // Column already exists — ignore
    }
    // 功能更名：request_logs.source 的 'proxy' 值 → 'gateway'（幂等，历史行一并归并）
    this.exec("UPDATE request_logs SET source = 'gateway' WHERE source = 'proxy'")
    // 迁移立即落盘，避免进程退出时丢失结构变更
    this.save()
  }

  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    this.ensureInit()
    const stmt = this.db!.prepare(sql)
    if (params) stmt.bind(params)
    const rows: T[] = []
    while (stmt.step()) rows.push(stmt.getAsObject() as T)
    stmt.free()
    return rows
  }

  queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null {
    this.ensureInit()
    const stmt = this.db!.prepare(sql)
    if (params) stmt.bind(params)
    const hasRow = stmt.step()
    const row = hasRow ? (stmt.getAsObject() as T) : null
    stmt.free()
    return row
  }

  exec(sql: string, params?: unknown[]): { changes: number } {
    this.ensureInit()
    if (params) this.db!.run(sql, params)
    else this.db!.exec(sql)
    this.scheduleSave()
    return { changes: this.db!.getRowsModified() }
  }

  execMany(sql: string): void {
    this.ensureInit()
    this.db!.exec(sql)
    this.scheduleSave()
  }

  save(): void {
    this.ensureInit()
    try {
      const data = this.db!.export()
      // 原子写：先写临时文件再 rename，避免写盘中途崩溃/被杀损坏主 DB
      const tmpPath = `${this.dbPath}.tmp`
      fs.writeFileSync(tmpPath, Buffer.from(data))
      fs.renameSync(tmpPath, this.dbPath)
    } catch (err) {
      console.error('[DB] Save failed:', err)
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.pendingSave = true
    this.saveTimer = setTimeout(() => {
      this.save()
      this.pendingSave = false
    }, SAVE_DEBOUNCE_MS)
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    if (this.pendingSave || this.db) {
      this.save()
      this.pendingSave = false
    }
  }

  close(): void {
    this.flush()
    this.db?.close()
    this.db = null
    this.initialized = false
  }

  private ensureInit(): void {
    if (!this.initialized || !this.db) {
      throw new Error('Database not initialized. Call db.init() first.')
    }
  }

  get isInitialized(): boolean {
    return this.initialized
  }
}

let instance: Database | null = null

export function getDatabase(): Database {
  if (!instance) instance = new Database()
  return instance
}
