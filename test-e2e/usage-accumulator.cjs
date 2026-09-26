// 纯 Node 测试：src/main/monitoring/usageAccumulator.ts（用量本地累计，CC 逐条 / MiMo 聚合行双口径）
// 用真实 sql.js + SCHEMA 建库，重点验证 ON CONFLICT upsert 语义：
//   ① CC 逐条记录：首次插入计入 / 重复采集不计入（等价旧 INSERT OR IGNORE）
//   ② MiMo 聚合行（日期×模型自然键）：数值变化覆盖并计入 / 恒等不计
//   ③ requests 列：CC 缺省 1、MiMo 行内 requestCount；SUM(requests) 聚合口径
//   ④ clearCumulativeUsage 清除记录 + 采集状态；source_id 隔离
// 用法：node test-e2e/usage-accumulator.cjs
// 加载方式：esbuild transform usageAccumulator.ts → CJS，new Function 注入 stub require（替换 ../db/database）
// 返回码：全部通过 0，有失败 1
const fs = require('fs')
const path = require('path')

let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + label)
  } else {
    fail++
    console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''))
  }
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, { actual, expected })
}

// ── 真实 sql.js 库（语义与 Database 类 exec/query/queryOne 一致） ──
async function makeRealDb() {
  const initSqlJs = require('sql.js')
  // sql.js 主入口在 dist/ 下（package.json exports 不允许直接 resolve package.json）
  const distDir = path.dirname(require.resolve('sql.js'))
  const SQL = await initSqlJs({ locateFile: (f) => path.join(distDir, f) })
  const raw = new SQL.Database()
  // SCHEMA 从源码提取（与生产同一份建表语句，含 requests 列）
  const schemaSrc = fs.readFileSync(path.resolve(__dirname, '../src/main/db/schema.ts'), 'utf8')
  const m = /export const SCHEMA = `([\s\S]*)`\s*$/.exec(schemaSrc)
  if (!m) throw new Error('无法从 schema.ts 提取 SCHEMA')
  raw.exec(m[1])
  return {
    exec(sql, params) {
      if (params) raw.run(sql, params)
      else raw.exec(sql)
      return { changes: raw.getRowsModified() }
    },
    query(sql, params) {
      const stmt = raw.prepare(sql)
      if (params) stmt.bind(params)
      const rows = []
      while (stmt.step()) rows.push(stmt.getAsObject())
      stmt.free()
      return rows
    },
    queryOne(sql, params) {
      const rows = this.query(sql, params)
      return rows.length > 0 ? rows[0] : null
    }
  }
}

// ── 模块加载（stub 掉 ../db/database） ──
function loadAccumulator(db) {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/main/monitoring/usageAccumulator.ts'), 'utf8')
  const esbuild = require('esbuild')
  const js = esbuild.transformSync(src, { loader: 'ts', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  const fakeRequire = (id) => {
    if (String(id).includes('db/database')) return { getDatabase: () => db }
    return require(id)
  }
  new Function('exports', 'module', 'require', js)(mod.exports, mod, fakeRequire)
  return mod.exports
}

async function main() {
  const db = await makeRealDb()
  const { persistUsageRecords, getCumulativeUsage, recordCollectorRun, clearCumulativeUsage } = loadAccumulator(db)

  console.log('[1] CC 逐条记录：首插计入 / 重复采集幂等')
  const ccRows = [
    { id: 'r1', createdAtMs: 1000, model: 'm-a', tokensIn: 10, tokensOut: 20, tokensTotal: 30, cost: 0.5 },
    { id: 'r2', createdAtMs: 2000, model: 'm-b', tokensIn: 1, tokensOut: 2, tokensTotal: 3, cost: 0.1 }
  ]
  eq(persistUsageRecords('cc-1', ccRows), 2, '首插 2 条 → affected=2')
  eq(persistUsageRecords('cc-1', ccRows), 0, '重复采集同值 → affected=0（幂等）')
  let cum = getCumulativeUsage('cc-1')
  eq(cum.records, 2, '累计记录数=2')
  eq(
    cum.models.map((m) => [m.model, m.requests]),
    [
      ['m-a', 1],
      ['m-b', 1]
    ],
    'CC 行 requests 缺省 1：每条记录按 1 次请求计'
  )

  console.log('[2] MiMo 聚合行（日期×模型）：数值变化覆盖并计入')
  const mimoRow = {
    id: '2026-09-27|mimo-v2.6-pro',
    createdAtMs: 1790505600000,
    model: 'mimo-v2.6-pro',
    tokensIn: 1000,
    tokensOut: 2000,
    tokensTotal: 3000,
    cost: 1.5,
    requests: 50
  }
  eq(persistUsageRecords('mimo-1', [mimoRow]), 1, '首插聚合行 → affected=1')
  eq(persistUsageRecords('mimo-1', [mimoRow]), 0, '同值重采 → affected=0')
  eq(persistUsageRecords('mimo-1', [{ ...mimoRow, requests: 60, tokensTotal: 3600, cost: 1.8 }]), 1, '行内用量增长 → affected=1（覆盖）')
  cum = getCumulativeUsage('mimo-1')
  eq(cum.records, 1, '同自然键只保留一行')
  eq(cum.models[0].requests, 60, 'requests 取最新行值')
  eq(cum.models[0].tokensTotal, 3600, 'tokensTotal 取最新行值')
  eq(cum.models[0].cost, 1.8, 'cost 取最新行值')

  console.log('[3] 隔离与采集状态')
  eq(getCumulativeUsage('mimo-1').records, 1, 'mimo-1 不受 cc-1 影响')
  recordCollectorRun('mimo-1', { ok: true, inserted: 1 })
  const st = getCumulativeUsage('mimo-1').collectorState
  ok(st && st.runs === 1 && st.okRuns === 1 && st.totalInserted === 1, '采集状态记录', st)

  console.log('[4] clearCumulativeUsage')
  clearCumulativeUsage('mimo-1')
  cum = getCumulativeUsage('mimo-1')
  eq(cum.records, 0, '记录清空')
  eq(cum.collectorState.runs, 0, '采集状态清空')
  eq(getCumulativeUsage('cc-1').records, 2, '不影响其他源')

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('测试执行异常:', err)
  process.exit(1)
})
