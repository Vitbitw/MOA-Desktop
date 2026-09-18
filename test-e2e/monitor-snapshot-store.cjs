// 纯 Node 测试：src/main/monitoring/snapshotStore.ts（云监控页面用量快照持久化）
// 覆盖：① save→get 往返（JSON 保真）/ 同源覆盖 / 源间隔离 / 无记录 → null
//      ② clear：清除目标源、不影响他源、清不存在的源不抛
//      ③ 损坏 JSON → 读取返回 null（降级）
//      ④ DB 抛错 → save/clear 不向外抛、get 返回 null（边界降级，不影响刷新本身）
// 用法：node test-e2e/monitor-snapshot-store.cjs
// 加载方式：esbuild transform snapshotStore.ts → CJS，new Function 注入 stub require（替换 ../db/database）
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

// ── stub DB：内存 Map 模拟 monitor_snapshots 的 INSERT OR REPLACE / DELETE / SELECT ──
function makeFakeDb() {
  const rows = new Map()
  return {
    rows,
    exec(sql, params) {
      const s = sql.trim()
      if (/^INSERT OR REPLACE INTO monitor_snapshots/i.test(s)) rows.set(params[0], params[1])
      else if (/^DELETE FROM monitor_snapshots/i.test(s)) rows.delete(params[0])
      else throw new Error('unexpected sql: ' + s)
      return { changes: 1 }
    },
    queryOne(sql, params) {
      const json = rows.get(params[0])
      return json === undefined ? null : { usage_json: json }
    }
  }
}

// ── 模块加载（stub 掉 ../db/database） ──
function loadStore(db) {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/main/monitoring/snapshotStore.ts'), 'utf8')
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

const usage = (ts) => ({ fetchedAt: ts, sourcesAvailable: { summary: true } })

function main() {
  console.log('[1] save/get 往返与隔离')
  const db = makeFakeDb()
  const { saveUsageSnapshot, getUsageSnapshot, clearUsageSnapshot } = loadStore(db)

  eq(getUsageSnapshot('cc-1'), null, '无记录 → null')
  const u1 = usage(111)
  saveUsageSnapshot('cc-1', u1)
  eq(getUsageSnapshot('cc-1'), u1, 'save → get 往返（JSON 保真）')
  saveUsageSnapshot('cc-1', usage(222))
  eq(getUsageSnapshot('cc-1').fetchedAt, 222, '同源再 save 覆盖为最新')
  saveUsageSnapshot('mimo-1', usage(333))
  eq(getUsageSnapshot('cc-1').fetchedAt, 222, '不同源互不影响（cc-1）')
  eq(getUsageSnapshot('mimo-1').fetchedAt, 333, '不同源互不影响（mimo-1）')
  eq([...db.rows.keys()].sort(), ['cc-1', 'mimo-1'], '两源各一行')

  console.log('[2] clear')
  clearUsageSnapshot('cc-1')
  eq(getUsageSnapshot('cc-1'), null, 'clear 后 → null')
  eq(getUsageSnapshot('mimo-1').fetchedAt, 333, 'clear 只清目标源')
  let threw = false
  try {
    clearUsageSnapshot('not-exist')
  } catch {
    threw = true
  }
  ok(!threw, 'clear 不存在的源不抛错')

  // 以下降级用例会触发 store 内部的 console.warn，静音以保持输出干净
  const origWarn = console.warn
  console.warn = () => {}

  console.log('[3] 损坏 JSON → 读取降级')
  db.rows.set('bad', '{not json')
  eq(getUsageSnapshot('bad'), null, '损坏 JSON → null（不抛）')

  console.log('[4] DB 异常 → 边界降级')
  const broken = {
    exec() {
      throw new Error('db broken')
    },
    queryOne() {
      throw new Error('db broken')
    }
  }
  const store2 = loadStore(broken)
  threw = false
  try {
    store2.saveUsageSnapshot('x', usage(1))
  } catch {
    threw = true
  }
  ok(!threw, 'save：DB 抛错不向外抛')
  eq(store2.getUsageSnapshot('x'), null, 'get：DB 抛错 → null')
  threw = false
  try {
    store2.clearUsageSnapshot('x')
  } catch {
    threw = true
  }
  ok(!threw, 'clear：DB 抛错不向外抛')

  console.warn = origWarn

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}

main()
