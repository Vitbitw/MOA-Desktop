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
      fs.writeFileSync(this.dbPath, Buffer.from(data))
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
