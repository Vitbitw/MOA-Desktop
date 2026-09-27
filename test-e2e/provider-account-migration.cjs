// 纯 Node 测试：v5「来源 + 账号」数据库迁移（src/main/db/database.ts + providerManager 读链）
// 覆盖：
//   ① 老库（providers 带 billing/plan_* 列、无 provider_accounts）→ 迁移把通道/订阅费搬进
//      **默认账号（id = providers.id）**，再 DROP 来源级列（零丢失）
//   ② 迁移幂等：重复打开不产生重复账号、列不再回补
//   ③ 已有账号行时跳过拷贝（NOT EXISTS），不覆盖用户后加的账号
//   ④ 不变量兜底：某来源无 active 账号 → 自动把最早账号置为 active；多个 active → 收敛为一个
//   ⑤ 全新库：providers 无 billing/plan 列（单一事实来源在账号表）
//   ⑥ 读链回归：迁移后 providerManager.getAllProviders() 的 billing / plan / activeAccountId 原样可用
// 用法：node test-e2e/provider-account-migration.cjs
// 加载方式：esbuild transform database.ts / providerManager.ts → CJS，stub require（electron / sql.js /
//           db/database / config/appSettings / store/key-store / fetchProxy / uiBridge）
const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

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

const DB_FILE = 'moa-desktop.db'
/** 老版 providers 表（v5 之前：通道 / 订阅费挂在来源上） */
const OLD_PROVIDERS_SQL = `
CREATE TABLE providers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  model_list  TEXT NOT NULL DEFAULT '[]',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  billing        TEXT NOT NULL DEFAULT 'usage',
  plan_amount    REAL,
  plan_currency  TEXT NOT NULL DEFAULT 'CNY',
  plan_anchor_ts INTEGER
);`

function distDir() {
  return path.dirname(require.resolve('sql.js'))
}

async function openRaw(buffer) {
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs({ locateFile: (f) => path.join(distDir(), f) })
  return new SQL.Database(buffer)
}

/** 写一个「老版本」库文件：providers 带通道/订阅费列，不含 provider_accounts */
async function writeOldDb(file, providers) {
  const d = await openRaw()
  d.exec(OLD_PROVIDERS_SQL)
  for (const p of providers) {
    d.run(
      'INSERT INTO providers (id, name, base_url, model_list, enabled, created_at, billing, plan_amount, plan_currency, plan_anchor_ts) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)',
      [p.id, p.name, p.baseUrl || 'https://x.example/v1', '[]', Date.now(), p.billing || 'usage',
       p.plan_amount ?? null, p.plan_currency || 'CNY', p.plan_anchor_ts ?? null]
    )
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.from(d.export()))
  d.close()
}

/**
 * 模块加载器：esbuild transform TS → CJS，new Function 注入 stub require。
 * extraStubs：{ [require 子串]: module }，在相对路径解析之前命中（如 providerManager 依赖的 db/database）
 */
function makeLoader(extraStubs = {}) {
  const cache = new Map()
  function loadTs(abs) {
    if (cache.has(abs)) return cache.get(abs)
    const js = esbuild.transformSync(fs.readFileSync(abs, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node18' }).code
    const mod = { exports: {} }
    cache.set(abs, mod.exports)
    const fakeRequire = (id) => {
      const s = String(id)
      if (s === 'node:crypto' || s === 'crypto') return require('crypto')
      if (s === 'fs' || s === 'node:fs') return fs
      if (s === 'path' || s === 'node:path') return path
      if (s === 'os' || s === 'node:os') return os
      if (s === 'electron') return extraStubs.electron
      if (s === 'sql.js') return () => require('sql.js')({ locateFile: (f) => path.join(distDir(), f) })
      for (const needle of Object.keys(extraStubs)) {
        if (needle === 'electron' || needle === 'sql.js') continue
        if (s.includes(needle)) return extraStubs[needle]
      }
      if (s.startsWith('.') || s.includes('shared')) {
        let p = path.resolve(path.dirname(abs), s)
        if (!fs.existsSync(p) && fs.existsSync(p + '.ts')) p += '.ts'
        return loadTs(p)
      }
      return require(s)
    }
    new Function('exports', 'module', 'require', '__dirname', js)(mod.exports, mod, fakeRequire, path.dirname(abs))
    cache.set(abs, mod.exports)
    return mod.exports
  }
  return loadTs
}

/** 加载真实 Database 类（stub electron 的 userData 路径） */
function loadDatabaseClass(tmpDir) {
  const mod = makeLoader({ electron: { app: { getPath: () => tmpDir } } })(
    path.resolve(__dirname, '../src/main/db/database.ts')
  )
  return mod.Database
}

/** 加载真实 providerManager（注入本次的 Database 实例 + 内存 key-store / 设置） */
function loadProviderManager(db, keyStore, settingsState) {
  const load = makeLoader({
    'db/database': { getDatabase: () => db },
    'config/appSettings': {
      readAppSettings: () => ({ ...settingsState }),
      updateRawAppSettings: (mut) => { mut(settingsState); return { ...settingsState } }
    },
    'store/key-store': keyStore,
    'local/fetchProxy': { fetchProxy: async () => { throw new Error('not expected') } },
    uiBridge: { broadcastToUi: () => {} }
  })
  return load(path.resolve(__dirname, '../src/main/providers/providerManager.ts'))
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moa-mig-'))
  const dbPath = path.join(tmpDir, DB_FILE)
  const providerKeys = {}
  const keyStore = {
    getProviderKey: (id) => providerKeys[id],
    saveProviderKey: (id, k) => { providerKeys[id] = k },
    removeProviderKey: (id) => { delete providerKeys[id] }
  }
  const settingsState = { billingBackfillDone: true }
  const Database = loadDatabaseClass(tmpDir)

  // ── ① 老库迁移：通道 / 订阅费搬进默认账号，来源级列删除 ──
  console.log('[1] 老库迁移（billing/plan 下沉到默认账号）')
  await writeOldDb(dbPath, [
    { id: 'p-plan', name: '阿里云 Token Plan', billing: 'plan', plan_amount: 68, plan_currency: 'USD', plan_anchor_ts: 1757000000000 },
    { id: 'p-payg', name: 'OpenAI', billing: 'usage' }
  ])
  const db1 = new Database()
  await db1.init()

  const accPlan = db1.queryOne('SELECT * FROM provider_accounts WHERE id = ?', ['p-plan'])
  eq(accPlan && accPlan.provider_id, 'p-plan', '默认账号 id = providers.id（历史键零迁移）')
  eq(accPlan && accPlan.billing, 'plan', 'billing 原样搬入账号')
  eq(accPlan && accPlan.plan_amount, 68, 'plan_amount 原样搬入')
  eq(accPlan && accPlan.plan_currency, 'USD', 'plan_currency 原样搬入')
  eq(accPlan && accPlan.plan_anchor_ts, 1757000000000, 'plan_anchor_ts 原样搬入')
  eq(accPlan && accPlan.active, 1, '默认账号为当前账号')
  eq(accPlan && accPlan.label, '', '默认账号无备注名')

  const cols = db1.query('PRAGMA table_info(providers)').map((r) => r.name)
  ok(!cols.includes('billing'), 'providers.billing 列已删除（单一事实来源在账号表）', cols)
  ok(!cols.includes('plan_amount'), 'providers.plan_amount 列已删除', cols)
  ok(!cols.includes('plan_anchor_ts'), 'providers.plan_anchor_ts 列已删除', cols)
  ok(cols.includes('name') && cols.includes('base_url'), '来源级字段保留', cols)
  eq(db1.queryOne('SELECT name FROM providers WHERE id = ?', ['p-plan']).name, '阿里云 Token Plan', '来源行本身未受损')
  eq(db1.query('SELECT id FROM provider_accounts').length, 2, '两个来源各一个账号')

  // ── ② 幂等：重复打开不重复建账号、列不回补 ──
  console.log('[2] 迁移幂等（重复打开）')
  db1.close()
  const db2 = new Database()
  await db2.init()
  eq(db2.query('SELECT id FROM provider_accounts').length, 2, '账号数不变（无重复插入）')
  eq(db2.query('PRAGMA table_info(providers)').map((r) => r.name).includes('billing'), false, '列未回补')
  db2.close()

  // ── ③ 部分迁移态：来源已有账号行 → NOT EXISTS 跳过拷贝，不覆盖用户已有账号 ──
  console.log('[3] 已有账号时不覆盖')
  const partDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moa-part-'))
  const partDbPath = path.join(partDir, DB_FILE)
  await writeOldDb(partDbPath, [
    { id: 'p-has', name: '已有账号来源', billing: 'plan', plan_amount: 99, plan_currency: 'CNY' },
    { id: 'p-none', name: '缺账号来源', billing: 'plan', plan_amount: 11, plan_currency: 'CNY' }
  ])
  const pre = await openRaw(fs.readFileSync(partDbPath))
  pre.exec(`CREATE TABLE provider_accounts (
    id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
    billing TEXT NOT NULL DEFAULT 'usage', plan_amount REAL, plan_currency TEXT NOT NULL DEFAULT 'CNY',
    plan_anchor_ts INTEGER, active INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);`)
  pre.run('INSERT INTO provider_accounts (id, provider_id, label, billing, plan_amount, plan_currency, plan_anchor_ts, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['custom-acc', 'p-has', '自定义账号', 'usage', null, 'CNY', null, 1, Date.now()])
  fs.writeFileSync(partDbPath, Buffer.from(pre.export()))
  pre.close()

  const db3 = new (loadDatabaseClass(partDir))()
  await db3.init()
  const kept = db3.queryOne('SELECT * FROM provider_accounts WHERE provider_id = ?', ['p-has'])
  eq(kept && kept.id, 'custom-acc', '已有账号的来源不再补默认账号')
  eq(kept && kept.label, '自定义账号', '已有账号数据未被迁移覆盖')
  eq(kept && kept.billing, 'usage', '已有账号通道未被迁移覆盖')
  const filled = db3.query('SELECT id FROM provider_accounts WHERE provider_id = ?', ['p-none'])
  eq(filled.length, 1, '无账号的来源仍会补建默认账号')
  eq(filled[0] && filled[0].id, 'p-none', '补的默认账号 id = providers.id')
  db3.close()
  fs.rmSync(partDir, { recursive: true, force: true })

  // ── ④ 不变量兜底：0 个 active → 补最早账号；2 个 active → 收敛为 1 ──
  console.log('[4] 每来源有且仅有一个 active 账号（数据异常兜底）')
  const raw2 = await openRaw(fs.readFileSync(dbPath))
  // 把 p-payg 的 active 清零（模拟半迁移/损坏）
  raw2.run('UPDATE provider_accounts SET active = 0 WHERE provider_id = ?', ['p-payg'])
  // 给 p-plan 造第二个 active
  raw2.run('INSERT INTO provider_accounts (id, provider_id, label, billing, plan_amount, plan_currency, plan_anchor_ts, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['p-plan-3rd', 'p-plan', '', 'usage', null, 'CNY', null, 1, Date.now() + 100])
  fs.writeFileSync(dbPath, Buffer.from(raw2.export()))
  raw2.close()

  const db4 = new Database()
  await db4.init()
  const paygActives = db4.query('SELECT id FROM provider_accounts WHERE provider_id = ? AND active = 1', ['p-payg'])
  eq(paygActives.length, 1, '无 active → 自动补一个')
  eq(paygActives[0] && paygActives[0].id, 'p-payg', '补的是创建最早的账号')
  const planActives = db4.query('SELECT id FROM provider_accounts WHERE provider_id = ? AND active = 1', ['p-plan'])
  eq(planActives.length, 1, '多个 active → 收敛为一个')
  db4.close()

  // ── ⑤ 全新库：无 billing/plan 列 ──
  console.log('[5] 全新库（无历史数据）')
  const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moa-fresh-'))
  const FreshDatabase = loadDatabaseClass(freshDir)
  const db5 = new FreshDatabase()
  await db5.init()
  const freshCols = db5.query('PRAGMA table_info(providers)').map((r) => r.name)
  ok(!freshCols.includes('billing'), '新库 providers 无 billing 列', freshCols)
  ok(freshCols.includes('created_at'), '来源级字段齐全', freshCols)
  eq(db5.query('SELECT id FROM provider_accounts').length, 0, '无来源 → 无账号')
  db5.close()

  // ── ⑥ 读链回归：迁移后的库被 providerManager 正确读出 ──
  console.log('[6] 读链回归（providerManager 读迁移后的账号）')
  const db6 = new Database()
  await db6.init()
  const pm = loadProviderManager(db6, keyStore, settingsState)
  const all = pm.getAllProviders()
  const plan = all.find((p) => p.id === 'p-plan')
  eq(plan.billing, 'plan', 'billing 投影 = 迁移来的通道')
  eq(plan.plan, { amount: 68, currency: 'USD', anchorTs: 1757000000000 }, 'plan 三件套投影原样')
  eq(plan.activeAccountId, 'p-plan', 'activeAccountId = 默认账号')
  eq(plan.accounts.length, 2, '含迁移账号 + 后加的二号账号')
  eq(plan.apiKey, '', '无 key-store 记录 → 空串（与旧行为一致）')
  const payg = all.find((p) => p.id === 'p-payg')
  eq(payg.billing, 'usage', 'usage 来源投影正确')
  eq(payg.plan, undefined, '未配订阅费 → plan 省略')
  db6.close()

  // ── ⑦ 更老的库：providers 尚无 billing/plan 列（那时还没有计费通道概念）──
  //    必须补默认账号，且默认账号 id = providers.id，否则历史 API Key 会「升级即掉」
  console.log('[7] 无 billing/plan 列的老库（补默认账号，不掉 Key）')
  const ancientDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moa-anc-'))
  const ancientPath = path.join(ancientDir, DB_FILE)
  const aRaw = await openRaw()
  aRaw.exec(`CREATE TABLE providers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
    model_list TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);`)
  aRaw.run(
    'INSERT INTO providers (id, name, base_url, model_list, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    ['p-anc', '古老厂商', 'https://a.example/v1', '[]', Date.now()]
  )
  fs.writeFileSync(ancientPath, Buffer.from(aRaw.export()))
  aRaw.close()

  const db7 = new (loadDatabaseClass(ancientDir))()
  await db7.init()
  const ancAcc = db7.queryOne('SELECT * FROM provider_accounts WHERE provider_id = ?', ['p-anc'])
  eq(ancAcc && ancAcc.id, 'p-anc', '默认账号 id = providers.id（历史 Key 键位不变）')
  eq(ancAcc && ancAcc.billing, 'usage', '无通道概念的老库 → 默认按量')
  eq(ancAcc && ancAcc.active, 1, '默认账号为当前账号')
  providerKeys['p-anc'] = 'LEGACY-KEY'
  const ancProvider = loadProviderManager(db7, keyStore, settingsState)
    .getAllProviders()
    .find((p) => p.id === 'p-anc')
  eq(ancProvider && ancProvider.apiKey, 'LEGACY-KEY', '历史 API Key 经默认账号原样读出（升级不掉 Key）')
  eq(ancProvider && ancProvider.accounts.length, 1, '恰好补一个账号')
  db7.close()
  fs.rmSync(ancientDir, { recursive: true, force: true })

  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(freshDir, { recursive: true, force: true })

  console.log('')
  console.log(`${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
