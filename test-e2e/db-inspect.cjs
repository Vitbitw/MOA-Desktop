// 只读诊断：本地累计是否仍在增长（按"采集批次"看每次采集新增了多少条）
const fs = require('fs')
const path = require('path')
const os = require('os')
const ROOT = path.resolve(__dirname, '..')
const initSqlJs = require(path.join(ROOT, 'node_modules/sql.js'))

// DB 路径：优先命令行参数 / MOA_DB 环境变量，其次 Electron userData 默认位置
function defaultDbPath() {
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'moa-desktop', 'moa-desktop.db')
  if (process.platform === 'darwin')
    return path.join(os.homedir(), 'Library/Application Support/moa-desktop/moa-desktop.db')
  return path.join(os.homedir(), '.config/moa-desktop/moa-desktop.db')
}
const dbPath = process.argv[2] || process.env.MOA_DB || defaultDbPath()
if (!fs.existsSync(dbPath)) {
  console.error('找不到数据库文件:', dbPath, '\n可用 MOA_DB=<path> 或命令行参数指定')
  process.exit(1)
}
const copy = path.join(process.env.TEMP || os.tmpdir(), 'moa-db-diag-' + Date.now() + '.db')
fs.copyFileSync(dbPath, copy)
console.log('DB 大小:', fs.statSync(dbPath).size, 'bytes · DB mtime:', fs.statSync(dbPath).mtime.toLocaleString('zh-CN'))

;(async () => {
  const SQL = await initSqlJs({ locateFile: (f) => path.join(ROOT, 'node_modules/sql.js/dist', f) })
  const db = new SQL.Database(fs.readFileSync(copy))
  const q = (sql) => {
    const st = db.prepare(sql)
    const rows = []
    while (st.step()) rows.push(st.getAsObject())
    st.free()
    return rows
  }
  const fmt = (ms) => (ms ? new Date(Number(ms)).toLocaleString('zh-CN') : '—')

  console.log('\n[总览]')
  const t = q(`SELECT COUNT(*) AS records, MIN(first_seen_at) AS firstSeen, MAX(first_seen_at) AS lastSeen,
                      MAX(created_at) AS newestRecord
                 FROM cc_usage_records WHERE source_id='commandcode'`)[0]
  console.log('  累计条数:', t.records, '· 首次采集:', fmt(t.firstSeen), '· 最近采集:', fmt(t.lastSeen))
  console.log('  最新记录时间(云端):', fmt(t.newestRecord))
  console.log('  现在:', new Date().toLocaleString('zh-CN'), '· 距最近采集:', t.lastSeen ? Math.round((Date.now() - Number(t.lastSeen)) / 60000) + ' 分钟' : '—')

  console.log('\n[采集批次]（按 first_seen_at 分组，秒级）')
  const batches = q(`SELECT CAST(first_seen_at/1000 AS INTEGER) AS sec, COUNT(*) AS n, MIN(created_at) AS minC, MAX(created_at) AS maxC
                       FROM cc_usage_records WHERE source_id='commandcode'
                      GROUP BY sec ORDER BY sec`)
  for (const b of batches) {
    console.log(`  ${fmt(b.sec * 1000)}  +${b.n} 条   记录时间 ${fmt(b.minC)} ~ ${fmt(b.maxC)}`)
  }

  console.log('\n[按模型]')
  for (const m of q(`SELECT model, COUNT(*) AS requests, SUM(cost) AS cost, SUM(tokens_total) AS tok
                       FROM cc_usage_records WHERE source_id='commandcode' GROUP BY model ORDER BY cost DESC`)) {
    console.log(`  ${m.model}: req=${m.requests} cost=$${Number(m.cost).toFixed(4)} tok=${m.tok}`)
  }

  console.log('\n[设置]')
  const cfg = q("SELECT value FROM moa_config WHERE key='app_settings'")[0]
  const s = cfg ? JSON.parse(cfg.value) : {}
  console.log('  monitoring:', JSON.stringify(s.monitoring ?? '(缺失)'))
  console.log('  network:', JSON.stringify(s.network ?? '(缺失)'))
  db.close()
})().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
