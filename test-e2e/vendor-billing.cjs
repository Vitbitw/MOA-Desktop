// 纯 Node 测试：src/main/providers/providerManager.ts（v5「来源 + 账号」：通道/订阅费/Key 挂账号）
// 覆盖：① addProvider 三件套 = 默认账号（id = provider id）+ getAllProviders 投影
//      ② updateProvider 来源级 / updateProviderAccount 账号级 + plan:null 清空
//      ③ updateProviderKey：只写本账号 / 不存在 id 抛错
//      ④ **MF-1 回归**：key 写入失败 → 异常上抛且本账号回滚（无新旧混存）
//      ⑤ backfill（v4.1 一次性）：清单命中补 plan / 非清单名不动 / 一次性标记置位 / 手动改回不被覆盖
//      ⑥ seed 预设：清单命中 → plan（写在默认账号）
//      ⑦ Plan 比值摊销（T2）：跨 anchor 分桶 / 桶内 Σ=消费 / 未配订阅费单价链回退 / manual 优先 / CNY 折算 / 零 token 不除零
//      ⑧ 探查条目按通道过滤（T2 §5）：绑定条目仅同厂商命中、无标记条目全通道命中
//      ⑨ 查询范围汇聚重算（T2.1 评审 MF-1）：多行同桶 Σ=amountUSD（非行数×amountUSD）/ 跨 provider 独立桶 / 无 plan 行 null
//      ⑩ 挂接结构断言（T2.1）：SUMMARY/TODAY 必须调 computeRangePlanCosts（禁用挂接即红，封堵评审变异⑥零覆盖）
//      ⑮ v5 多账号：通道 / Key / 订阅费 / 摊销按账号隔离，切当前账号不串历史行
// 用法：node test-e2e/vendor-billing.cjs
// 加载方式：esbuild transform 各 TS 模块 → CJS，new Function 注入 stub require（db / key-store / fetchProxy / uiBridge / appSettings）
// 返回码：全部通过 0，有失败 1
const fs = require('fs')
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
function throws(fn, includes, label) {
  try {
    fn()
    ok(false, label, { error: 'did not throw' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ok(includes === undefined || msg.includes(includes), label, { msg })
  }
}
/** 浮点等值断言（默认容差 1e-6）：摊销金额按 6 位小数舍入，需带容差比较 */
function near(actual, expected, label, tol = 1e-6) {
  ok(typeof actual === 'number' && Math.abs(actual - expected) <= tol, label, { actual, expected, tol })
}

// ── stub DB：内存 providers / provider_accounts 行数组，按 SQL 文本分发 ──
// v5「来源 + 账号」：billing / plan_* 只存在 provider_accounts（providers 表已无这些列）
function makeFakeDb() {
  const rows = []
  const accounts = []
  const def = (o) => ({
    model_list: '[]', enabled: 1, created_at: Date.now(),
    ...o
  })
  const accDef = (o) => ({
    label: '', billing: 'usage', plan_amount: null, plan_currency: 'CNY',
    plan_anchor_ts: null, active: 0, created_at: Date.now(),
    ...o
  })
  const applySet = (row, setClause, params) => {
    // SET 项逐位解析："col = ?" 消费 param，字面量（'plan' / 1）直接取值
    const items = setClause.split(',').map((s) => s.trim())
    let pi = 0
    for (const it of items) {
      const eqIdx = it.indexOf('=')
      const col = it.slice(0, eqIdx).trim()
      const val = it.slice(eqIdx + 1).trim()
      if (val === '?') row[col] = params[pi++]
      else if (/^-?\d+(\.\d+)?$/.test(val)) row[col] = Number(val)
      else row[col] = val.replace(/^'|'$/g, '')
    }
    return params.slice(pi)
  }
  const parseInsert = (m, params) => {
    // 列名与 VALUES 逐位对齐：'?' 消费 params，字面量（如 active 的 1）直接取值
    const cols = m[1].split(',').map((c) => c.trim())
    const vals = m[2].split(',').map((v) => v.trim())
    const obj = {}
    let pi = 0
    cols.forEach((c, i) => {
      if (vals[i] === '?') obj[c] = params[pi++]
      else obj[c] = /^-?\d+(\.\d+)?$/.test(vals[i]) ? Number(vals[i]) : vals[i]
    })
    return obj
  }
  return {
    rows,
    accounts,
    /** 便捷断言：某来源的账号行 */
    accOf(id) { return accounts.find((a) => a.id === id) },
    /** 便捷断言：某来源的全部账号 */
    accsOf(providerId) { return accounts.filter((a) => a.provider_id === providerId) },
    exec(sql, params = []) {
      const s = sql.trim().replace(/\s+/g, ' ')
      let m
      if ((m = s.match(/^INSERT INTO providers \(([^)]+)\) VALUES\s*\(([^)]+)\)$/i))) {
        rows.push(def(parseInsert(m, params)))
      } else if ((m = s.match(/^INSERT INTO provider_accounts \(([^)]+)\) VALUES\s*\(([^)]+)\)$/i))) {
        accounts.push(accDef(parseInsert(m, params)))
      } else if ((m = s.match(/^UPDATE providers SET (.+?) WHERE id = \?$/i))) {
        const id = params[params.length - 1]
        const row = rows.find((r) => r.id === id)
        if (row) applySet(row, m[1], params.slice(0, params.length - 1))
      } else if ((m = s.match(/^UPDATE provider_accounts SET (.+?) WHERE (id|provider_id) = \?$/i))) {
        const col = m[2]
        const val = params[params.length - 1]
        const payload = params.slice(0, params.length - 1)
        for (const row of accounts.filter((r) => r[col] === val)) applySet(row, m[1], payload)
      } else if (/^DELETE FROM provider_accounts WHERE provider_id = \?$/i.test(s)) {
        for (let i = accounts.length - 1; i >= 0; i--) {
          if (accounts[i].provider_id === params[0]) accounts.splice(i, 1)
        }
      } else if (/^DELETE FROM provider_accounts WHERE id = \?$/i.test(s)) {
        const i = accounts.findIndex((a) => a.id === params[0])
        if (i >= 0) accounts.splice(i, 1)
      } else if (/^DELETE FROM providers WHERE id = \?$/i.test(s)) {
        const i = rows.findIndex((r) => r.id === params[0])
        if (i >= 0) rows.splice(i, 1)
      } else {
        throw new Error('unexpected exec sql: ' + s)
      }
      return { changes: 1 }
    },
    query(sql) {
      const s = sql.trim().replace(/\s+/g, ' ')
      if (/^SELECT id, name, base_url, model_list, enabled FROM providers ORDER BY name$/i.test(s)) {
        return rows.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))
      }
      if (/^SELECT id, provider_id, label, billing, plan_amount, plan_currency, plan_anchor_ts, active, created_at FROM provider_accounts ORDER BY created_at, id$/i.test(s)) {
        return accounts.slice().sort((a, b) => a.created_at - b.created_at || String(a.id).localeCompare(String(b.id)))
      }
      if (/^SELECT a\.id, p\.name FROM provider_accounts a JOIN providers p ON p\.id = a\.provider_id WHERE a\.billing = 'usage' AND a\.id = a\.provider_id$/i.test(s)) {
        return accounts
          .filter((a) => a.billing === 'usage' && a.id === a.provider_id)
          .map((a) => ({ id: a.id, name: (rows.find((r) => r.id === a.provider_id) || {}).name }))
      }
      if (/^SELECT name FROM providers$/i.test(s)) {
        return rows.map((r) => ({ name: r.name }))
      }
      throw new Error('unexpected query sql: ' + s)
    },
    queryOne(sql, params = []) {
      const s = sql.trim().replace(/\s+/g, ' ')
      if (/^SELECT id FROM providers WHERE id = \?$/i.test(s)) {
        const r = rows.find((x) => x.id === params[0])
        return r ? { id: r.id } : null
      }
      if (/^SELECT [\w*, ]+ FROM provider_accounts WHERE id = \?$/i.test(s)) {
        const r = accounts.find((x) => x.id === params[0])
        return r ? { ...r } : null
      }
      throw new Error('unexpected queryOne sql: ' + s)
    }
  }
}

// v4：带参过滤查询已随分组移除——query 单参即可，此处保留空包装兼容既有调用点
function patchQueryParams(db) {}

// ── stub key-store：内存明文 map + 可注入「第 N 次 save 失败」 ──
function makeFakeKeyStore() {
  const state = { map: {}, saveCalls: 0, failAt: 0 }
  return {
    state,
    module: {
      getProviderKey: (id) => state.map[id],
      saveProviderKey: (id, key) => {
        state.saveCalls++
        if (state.failAt && state.saveCalls === state.failAt) throw new Error('injected key-store failure #' + state.failAt)
        state.map[id] = key
      },
      removeProviderKey: (id) => { delete state.map[id] }
    }
  }
}

// ── 模块加载（stub db / key-store / fetchProxy / uiBridge / extraStubs；defaults / ipc-channels 真实 transform） ──
// extraStubs：{ [require 子串]: module }，在相对路径解析之前命中（如 usage.ts 依赖的 config/appSettings）
function makeLoader(dbModule, keyStoreModule, extraStubs = {}) {
  const cache = new Map()
  function loadTs(abs) {
    if (cache.has(abs)) return cache.get(abs)
    const src = fs.readFileSync(abs, 'utf8')
    const js = esbuild.transformSync(src, { loader: 'ts', format: 'cjs', target: 'node18' }).code
    const mod = { exports: {} }
    cache.set(abs, mod.exports)
    const fakeRequire = (id) => {
      const s = String(id)
      if (s === 'node:crypto' || s === 'crypto') return require('crypto')
      if (s.includes('db/database')) return dbModule
      if (s.includes('store/key-store')) return keyStoreModule
      if (s.includes('local/fetchProxy')) return { fetchProxy: async () => { throw new Error('fetchProxy not expected in this test') } }
      if (s.includes('uiBridge')) return { broadcastToUi: () => {} }
      for (const needle of Object.keys(extraStubs)) {
        if (s.includes(needle)) return extraStubs[needle]
      }
      if (s.startsWith('.') || s.includes('shared')) {
        let p = path.resolve(path.dirname(abs), s)
        if (!fs.existsSync(p) && fs.existsSync(p + '.ts')) p += '.ts'
        return loadTs(p)
      }
      return require(s)
    }
    new Function('exports', 'module', 'require', js)(mod.exports, mod, fakeRequire)
    cache.set(abs, mod.exports)
    return mod.exports
  }
  return loadTs
}

function main() {
  const pmPath = path.resolve(__dirname, '../src/main/providers/providerManager.ts')
  const defaultsPath = path.resolve(__dirname, '../src/shared/defaults.ts')

  console.log('[1] addProvider 三件套 + getAllProviders 映射')
  {
    const db = makeFakeDb(); patchQueryParams(db)
    const ks = makeFakeKeyStore()
    const settingsState = { billingBackfillDone: undefined } // stub appSettings（backfill 一次性标记）
    const load = makeLoader({ getDatabase: () => db }, ks.module, {
      'config/appSettings': {
        readAppSettings: () => ({ ...settingsState }),
        updateRawAppSettings: (mut) => { mut(settingsState); return { ...settingsState } }
      }
    })
    const pm = load(pmPath)
    const defaults = load(defaultsPath)

    const a = pm.addProvider('阿里云百炼 (Qwen)', 'https://dashscope.aliyuncs.com/v1', '***', {
      billing: 'usage'
    })
    const b = pm.addProvider('阿里云 Token Plan', 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', '***', {
      billing: 'plan',
      plan: { amount: 68, currency: 'CNY', anchorTs: 1757000000000 }
    })
    const c = pm.addProvider('OpenAI', '', '***') // 无 opts → 默认态
    eq(db.accOf(c.id).billing, 'usage', '缺省 billing = usage（写在默认账号上）')
    eq(db.accOf(c.id).active, 1, '默认账号即当前账号')
    eq(db.accsOf(c.id).length, 1, '新建来源恰好一个账号')
    // 零迁移契约：默认账号 id = providers.id（历史 key-store 键 / request_logs.providerId 原样成立）
    eq(db.accOf(c.id).id, c.id, '默认账号 id 沿用 provider id')

    const all = pm.getAllProviders()
    eq(all.find((p) => p.id === b.id).billing, 'plan', 'billing 投影 = 当前账号通道')
    eq(all.find((p) => p.id === b.id).plan, { amount: 68, currency: 'CNY', anchorTs: 1757000000000 }, 'plan 三件套映射')
    eq(all.find((p) => p.id === a.id).plan, undefined, 'plan_amount NULL → plan 省略（未配置订阅费）')
    eq(all.find((p) => p.id === c.id).plan, undefined, '独立记录 plan 省略')
    eq(all.find((p) => p.id === b.id).activeAccountId, b.id, 'activeAccountId = 默认账号')
    eq(all.find((p) => p.id === b.id).accounts.length, 1, 'accounts 携带账号清单')

    console.log('[2] updateProvider 来源级 + updateProviderAccount 账号级')
    pm.updateProviderAccount(b.id, { billing: 'usage' })
    eq(pm.getAllProviders().find((p) => p.id === b.id).billing, 'usage', '账号通道更新 → 投影同步')
    eq(pm.getAllProviders().find((p) => p.id === b.id).name, '阿里云 Token Plan', '未传字段保持原值')
    pm.updateProviderAccount(b.id, { plan: null })
    eq(pm.getAllProviders().find((p) => p.id === b.id).plan, undefined, 'plan:null 清空订阅费')
    throws(() => pm.updateProviderAccount(b.id, { billing: 'annual' }), '计费通道无效', '非法 billing 抛错')
    throws(() => pm.updateProviderAccount('no-such-account', { label: 'x' }), 'not found', '不存在的账号抛错')
    throws(() => pm.updateProvider(b.id, { baseUrl: 'ftp://x' }), 'API 地址无效', '非法 baseUrl 抛错')

    console.log('[3] updateProviderKey（v4 单条语义）：只写本条 / 不存在 id')
    pm.updateProviderKey(a.id, 'NEW-KEY')
    eq(ks.state.map[a.id], 'NEW-KEY', '写入本条生效')
    ok(ks.state.map[b.id] !== 'NEW-KEY', '同名厂商另一条不被同步（组同步已移除）', ks.state.map[b.id])
    pm.updateProviderKey(c.id, 'OPENAI-KEY')
    eq(ks.state.map[c.id], 'OPENAI-KEY', '另一条只写自身')
    eq(ks.state.map[a.id], 'NEW-KEY', '写他条不影响已写条')
    throws(() => pm.updateProviderKey('no-such-id', 'X'), 'not found', '不存在 id 抛错')

    console.log('[4] MF-1 回归（v4 单条）：key 写入失败 → 上抛且本条无新旧混存')
    // 此刻 a.key = NEW-KEY；注入第 1 次 saveProviderKey 失败
    ks.state.saveCalls = 0
    ks.state.failAt = 1
    throws(() => pm.updateProviderKey(a.id, 'MIXED-NEW'), 'injected key-store failure', '写入失败向上抛出')
    ks.state.failAt = 0
    eq(ks.state.map[a.id], 'NEW-KEY', '失败后本条仍为旧值（不部分写）')

    console.log('[5] backfill：清单命中补 plan / 非清单名不动 / 幂等')
    // 造两类记录：清单命中（StepFun → plan）/ 非清单名（保持 usage）
    const d = pm.addProvider('StepFun', 'https://api.stepfun.com/step_plan/v1', '')       // 命中 PLAN_BILLING_NAMES
    const e = pm.addProvider('MiniMax (中国)', 'https://api.minimaxi.com/v1', '')         // 非清单名
    pm.backfillProviderBilling()
    const g = (id) => pm.getAllProviders().find((p) => p.id === id)
    eq(g(d.id).billing, 'plan', 'backfill：清单命中 → plan')
    eq(g(e.id).billing, 'usage', 'backfill：非清单名 → billing 不动')
    pm.backfillProviderBilling()
    eq(g(d.id).billing, 'plan', '二次运行幂等（billing 不变）')
    eq(settingsState.billingBackfillDone, true, 'backfill 执行后置一次性标记')
    // v4.1 防覆盖：用户手动把清单厂商改回 usage → 再次调用不得静默覆盖
    pm.updateProviderAccount(d.id, { billing: 'usage' })
    pm.backfillProviderBilling()
    eq(g(d.id).billing, 'usage', '置位后手动改回 usage 不被 backfill 覆盖')
    eq(g(e.id).billing, 'usage', '二次运行幂等（非清单名仍不动）')

    console.log('[6] seed 预设：清单命中 → plan')
    const emptyDb = makeFakeDb(); patchQueryParams(emptyDb)
    const seedPm = makeLoader({ getDatabase: () => emptyDb }, makeFakeKeyStore().module, {
      'config/appSettings': { readAppSettings: () => ({}), updateRawAppSettings: () => ({}) }
    })
    seedPm(pmPath).seedBuiltInProviders()
    const names = emptyDb.rows.map((r) => r.name)
    const pa = seedPm(path.resolve(__dirname, '../src/shared/providerAccess.ts'))
    const nonLocal = defaults.BUILT_IN_PROVIDER_TEMPLATES.filter((t) => !pa.isLocalBaseUrl(t.baseUrl))
    ok(names.length === nonLocal.length, 'seed 条数 = 非本地模板数（本地回环模板不预置）', { got: names.length, want: nonLocal.length })
    const cc = emptyDb.rows.find((r) => r.name === 'Command Code')
    eq(cc && emptyDb.accOf(cc.id).billing, 'plan', 'Command Code → plan')
    const ali = emptyDb.rows.find((r) => r.name === '阿里云 Token Plan')
    eq(ali && emptyDb.accOf(ali.id).billing, 'plan', '阿里云 Token Plan → plan')
    const qwen = emptyDb.rows.find((r) => r.name === '阿里云百炼 (Qwen)')
    eq(qwen && emptyDb.accOf(qwen.id).billing, 'usage', '阿里云百炼 → usage')
    const oai = emptyDb.rows.find((r) => r.name === 'OpenAI')
    eq(oai && emptyDb.accOf(oai.id).billing, 'usage', 'OpenAI → 默认 usage')
    const planCount = emptyDb.accounts.filter((a) => a.billing === 'plan').length
    eq(planCount, defaults.PLAN_BILLING_NAMES.length, 'seed 后 plan 账号数 = 清单数')
    eq(emptyDb.accounts.length, emptyDb.rows.length, '每个 seed 来源恰好一个账号')
  }

  // ══ T2：Plan 比值摊销 + 通道单价分支 + 探查条目按通道过滤（usage.ts） ══
  const DAY = 86400000
  const ANCHOR = Date.UTC(2026, 0, 1) // anchorTs：2026-01-01T00:00:00Z
  const T0 = Date.UTC(2026, 5, 15) // 2026-06-15：自然月分桶用例
  const settings = { pricing: {}, probedPricing: [] } // stub appSettings（usage.ts 只读 pricing / probedPricing）
  const udb = makeFakeDb()
  patchQueryParams(udb)
  const uload = makeLoader({ getDatabase: () => udb }, makeFakeKeyStore().module, {
    'config/appSettings': { readAppSettings: () => settings }
  })
  const upm = uload(pmPath)
  const usage = uload(path.resolve(__dirname, '../src/main/moa/usage.ts'))
  const planId = upm.addProvider('阿里云 Token Plan', 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', '***', {
    billing: 'plan', plan: { amount: 10, currency: 'USD', anchorTs: ANCHOR }
  }).id
  const paygoId = upm.addProvider('阿里云百炼 (Qwen)', 'https://dashscope.aliyuncs.com/v1', '***', {
    billing: 'usage'
  }).id
  const noAmtId = upm.addProvider('未配订阅费 Plan', 'https://plan.example.com/v1', '***', { billing: 'plan' }).id
  const cnyId = upm.addProvider('CNY 摊销 Plan', 'https://cny.example.com/v1', '***', {
    billing: 'plan', plan: { amount: 72, currency: 'CNY' } // 无 anchorTs → 当月 1 号分桶
  }).id
  const provs = upm.getAllProviders()

  console.log('[7] Plan 摊销分桶：跨 anchor 两桶独立 + 桶内 Σ = amountUSD')
  {
    const rows = [
      { modelId: 'qwen-turbo', providerId: planId, prompt: 100, completion: 0, timestamp: ANCHOR + DAY, cost: 0 },
      { modelId: 'qwen-turbo', providerId: planId, prompt: 300, completion: 0, timestamp: ANCHOR + 2 * DAY, cost: 0 },
      { modelId: 'qwen-turbo', providerId: planId, prompt: 50, completion: 50, timestamp: ANCHOR + 31 * DAY, cost: 0 },
      { modelId: 'qwen-turbo', providerId: paygoId, prompt: 1000, completion: 0, timestamp: ANCHOR + DAY, cost: 0.42 }
    ]
    const costs = usage.computePlanAllocatedCosts(rows, provs)
    eq(costs.length, 4, '摊销返回与输入等长数组')
    near(costs[0], 2.5, '桶0：amountUSD × 100/400 = 2.5')
    near(costs[1], 7.5, '桶0：amountUSD × 300/400 = 7.5')
    near(costs[0] + costs[1], 10, '桶0 Σcost = amountUSD（10 USD）')
    near(costs[2], 10, '跨 anchor 31 天 → 独立成桶，桶1 Σ = amountUSD（不受桶0 影响）')
    eq(costs[3], 0.42, 'usage 通道行 cost 原样保留（不参与摊销）')
  }

  console.log('[8] plan_amount 缺失 → 单价链回退（写入端 cost 非 0 占位）')
  {
    const unitRows = [{ modelId: 'gpt-4o-mini', providerId: noAmtId, prompt: 1_000_000, completion: 0, timestamp: T0, cost: 0 }]
    near(usage.computePlanAllocatedCosts(unitRows, provs, 'read')[0], 0.15, '读时未配订阅费 → 单价链（gpt-4o-mini 0.15 USD/1M）')
    near(usage.computePlanAllocatedCosts(unitRows, provs, 'write')[0], 0.15, '写入端（gateway 后处理）→ 单价链回退，cost ≠ 0 占位')

    const noAmtEntries = usage.buildUsageEntries(
      [{ modelId: 'gpt-4o-mini', providerId: noAmtId, role: 'sub', prompt: 1_000_000, completion: 0 }],
      T0
    )
    eq(noAmtEntries[0].cost, 0, 'buildUsageEntries：plan 无 manual → cost=0 占位（写入不定值）')
    near(usage.applyPlanWritePricing(noAmtEntries, undefined, T0)[0].cost, 0.15, 'applyPlanWritePricing 把占位补成单价链估算')

    const withAmtEntries = usage.buildUsageEntries(
      [{ modelId: 'qwen-turbo', providerId: planId, role: 'sub', prompt: 100, completion: 0 }],
      T0
    )
    eq(withAmtEntries[0].cost, 0, 'plan 已配订阅费 → 写入 0 占位（读时摊销重算）')
    near(usage.applyPlanWritePricing(withAmtEntries, undefined, T0)[0].cost, 0, '写入端保持占位：单请求作用域不做摊销')
  }

  console.log('[9] manual 定价优先于占位 / 摊销')
  {
    settings.pricing['gpt-4o-mini'] = { input: 3, output: 6 }
    const manualEntries = usage.buildUsageEntries(
      [{ modelId: 'gpt-4o-mini', providerId: planId, role: 'sub', prompt: 1_000_000, completion: 0 }],
      T0
    )
    near(manualEntries[0].cost, 3, 'plan + manual 命中 → manual 价（最高优先级）')
    const manualRows = [{ modelId: 'gpt-4o-mini', providerId: planId, prompt: 1_000_000, completion: 0, timestamp: T0, cost: 3 }]
    near(usage.computePlanAllocatedCosts(manualRows, provs, 'read')[0], 3, '读时 manual 行保留 manual 值（不被摊销覆盖为 10）')
    delete settings.pricing['gpt-4o-mini']
    eq(settings.pricing['gpt-4o-mini'], undefined, 'manual 配置清理后回退摊销链')
  }

  console.log('[10] CNY → USD 7.2 折算 + anchorTs 缺省按自然月分桶')
  {
    const cnyRows = [
      { modelId: 'm', providerId: cnyId, prompt: 700, completion: 0, timestamp: T0, cost: 0 }, // 2026-06
      { modelId: 'm', providerId: cnyId, prompt: 300, completion: 0, timestamp: T0 + DAY, cost: 0 }, // 2026-06
      { modelId: 'm', providerId: cnyId, prompt: 100, completion: 0, timestamp: T0 + 20 * DAY, cost: 0 } // 2026-07
    ]
    const cnyCosts = usage.computePlanAllocatedCosts(cnyRows, provs)
    near(usage.CNY_TO_USD_RATE, 7.2, '折算率 = 7.2（与 probe.ts 的 CNY_TO_USD_RATE 同值）')
    near(cnyCosts[0], 7, '72 CNY ÷ 7.2 = 10 USD × 700/1000 = 7')
    near(cnyCosts[0] + cnyCosts[1], 10, '6 月桶 Σcost = 10 USD（CNY 折算后）')
    near(cnyCosts[2], 10, 'anchorTs 缺省 → 当月 1 号分桶：7 月独立成桶')
  }

  console.log('[11] Σtokens = 0 → cost=0，不除零不抛错')
  {
    let zeroCosts = null
    let zeroThrew = false
    try {
      zeroCosts = usage.computePlanAllocatedCosts(
        [
          { modelId: 'm', providerId: planId, prompt: 0, completion: 0, timestamp: ANCHOR + DAY, cost: 0 },
          { modelId: 'm', providerId: planId, prompt: 0, completion: 0, timestamp: ANCHOR + 2 * DAY, cost: 0 }
        ],
        provs
      )
    } catch (err) {
      zeroThrew = true
      console.log('    unexpectedly threw: ' + err)
    }
    ok(!zeroThrew, '零 token 桶不抛错')
    eq(zeroCosts, [0, 0], 'Σtokens=0 → 桶内全 0')
  }

  console.log('[12] 探查条目按通道过滤（设计 §5）')
  {
    settings.probedPricing = [
      { pattern: 'zzz-probe', input: 1, output: 1, providerId: planId, sourceId: 's1', sourceUrl: 'https://a.example.com', fetchedAt: 1 },
      { pattern: 'zzz-probe', input: 2, output: 2, providerId: paygoId, sourceId: 's2', sourceUrl: 'https://b.example.com', fetchedAt: 2 },
      { pattern: 'zzz-legacy', input: 3, output: 3, sourceId: 's3', sourceUrl: 'https://c.example.com', fetchedAt: 1 }
    ]
    near(usage.computeCost('zzz-probe-x', 1_000_000, 0, T0, planId), 1, '绑定 plan 记录的条目仅对该厂商命中')
    near(usage.computeCost('zzz-probe-x', 1_000_000, 0, T0, paygoId), 2, '绑定 usage 记录的条目仅对该厂商命中')
    eq(usage.computeCost('zzz-probe-x', 1_000_000, 0, T0, 'other-provider'), 0, '无匹配通道 → 探查价不命中（回退内置价无此前缀 = 0）')
    near(usage.computeCost('zzz-legacy-x', 1_000_000, 0, T0, planId), 3, '无标记条目（源未绑 provider）对所有通道命中')
    const viaBuild = usage.buildUsageEntries(
      [{ modelId: 'zzz-probe-x', providerId: paygoId, role: 'sub', prompt: 1_000_000, completion: 0 }],
      T0
    )
    near(viaBuild[0].cost, 2, 'buildUsageEntries 透传 providerId → usage 通道命中对应探查价')
    settings.probedPricing = []
  }

  console.log('[13] 查询范围汇聚重算 + 按行回填（T2.1 评审 MF-1：分母 = 查询范围，非单条行内）')
  {
    const rangeRows = [
      // planId（10 USD，anchor 分桶）3 行同桶：100/200/700 tokens → 期望 1/2/7，Σ=10（而非行数×10=30）
      { timestamp: ANCHOR + DAY, models: [{ modelId: 'qwen-turbo', providerId: planId, prompt: 100, completion: 0, cost: 0 }] },
      { timestamp: ANCHOR + 2 * DAY, models: [{ modelId: 'qwen-turbo', providerId: planId, prompt: 200, completion: 0, cost: 0 }] },
      { timestamp: ANCHOR + 3 * DAY, models: [{ modelId: 'qwen-turbo', providerId: planId, prompt: 700, completion: 0, cost: 0 }] },
      // cnyId（72 CNY → 10 USD，自然月桶）2 行：400/600 tokens → 期望 4/6（独立桶，跨 provider 不互串）
      { timestamp: T0, models: [{ modelId: 'm', providerId: cnyId, prompt: 400, completion: 0, cost: 0 }] },
      { timestamp: T0 + DAY, models: [{ modelId: 'm', providerId: cnyId, prompt: 600, completion: 0, cost: 0 }] },
      // usage 通道行：无 plan 明细 → null（调用方沿用行级写入值）
      { timestamp: ANCHOR + DAY, models: [{ modelId: 'qwen-turbo', providerId: paygoId, prompt: 1000, completion: 0, cost: 0.42 }] },
      // 无明细行（stats 模式 / 损坏）→ null
      { timestamp: ANCHOR + DAY, models: null }
    ]
    const rc = usage.computeRangePlanCosts(rangeRows, provs)
    eq(rc.length, 7, '范围汇聚重算返回与输入等长')
    const planSigma = rc[0][0] + rc[1][0] + rc[2][0]
    near(planSigma, 10, '多行同桶 Σcost = amountUSD（10 USD），而非行数 × amountUSD')
    ok(Math.abs(planSigma - 30) > 1, '膨胀反例：Σ ≠ 30（旧单行作用域 = 3 行各吃 10 → 30）', { planSigma })
    near(rc[0][0], 1, '行0 = 10 × 100/1000 = 1（分母是范围内同桶合计 1000，非本行 100）')
    near(rc[1][0], 2, '行1 = 10 × 200/1000 = 2')
    near(rc[2][0], 7, '行2 = 10 × 700/1000 = 7')
    const cnySigma = rc[3][0] + rc[4][0]
    near(cnySigma, 10, '跨 provider 互不污染：cnyId 桶 Σcost = 10 USD（独立桶，未与 planId 混算）')
    near(rc[3][0], 4, 'cnyId 行0 = 10 × 400/1000 = 4')
    eq(rc[5], null, 'usage 通道行 → null（调用方沿用行级写入值，不被摊销污染）')
    eq(rc[6], null, '无明细行 → null（调用方沿用 row.cost）')
    eq(usage.computeRangePlanCosts([], provs), [], '空范围 → 空数组（不抛错）')
  }

  console.log('[14] 挂接自证：USAGE_GET_SUMMARY / TODAY 必须走范围汇聚重算（封堵变异⑥「禁用挂接仍绿」零覆盖）')
  {
    // handler 体无法脱离 electron 加载，故对 index.ts 挂接点做结构断言：
    // [13] 已证明函数口径正确，本段证明两个 handler 真的调用它——禁用任一挂接即红。
    const idxSrc = fs.readFileSync(path.resolve(__dirname, '../src/main/index.ts'), 'utf8').split('\r').join('')
    ok(/import \{[^}]*computeRangePlanCosts[^}]*\} from '\.\/moa\/usage'/.test(idxSrc), 'index.ts 导入 computeRangePlanCosts')
    const summarySeg = idxSrc.slice(idxSrc.indexOf('IPC.USAGE_GET_SUMMARY'), idxSrc.indexOf('IPC.USAGE_GET_TODAY'))
    const todaySeg = idxSrc.slice(idxSrc.indexOf('IPC.USAGE_GET_TODAY'), idxSrc.indexOf('IPC.MONITOR_GET_STATUS'))
    ok(summarySeg.includes('computeRangePlanCosts('), 'USAGE_GET_SUMMARY 挂接范围汇聚重算（禁用该挂接 → 本断言红）')
    ok(todaySeg.includes('computeRangePlanCosts('), 'USAGE_GET_TODAY 挂接范围汇聚重算（禁用该挂接 → 本断言红）')
    ok(!summarySeg.includes('computePlanEntryCosts(') && !todaySeg.includes('computePlanEntryCosts('), '两 handler 未回退单行入口 computePlanEntryCosts（防分母作用域回归）')
    // v5：groupBy=provider 拆行 key = 「来源名[·账号备注]·通道」恒带后缀
    ok(summarySeg.includes("info.name}·${label}${info.billing === 'plan' ? 'Plan' : '按量'}"), 'SUMMARY 拆行 key = 来源名·[账号名·]通道（恒带后缀）')
    // 账号隔离：分组必须按明细快照的 accountId 取，而不是来源当前账号
    ok(summarySeg.includes('accountNameMap.get(m.accountId)'), 'SUMMARY 分组按明细 accountId 取账号（切账号不串历史行）')
    // 已删账号：只查该账号、查不到就回退模型名，**不得**回落到同源默认账号（否则 A 账号历史并进 B 账号行）
    ok(
      /m\.accountId\s*\?\s*accountNameMap\.get\(m\.accountId\)\s*:/.test(summarySeg),
      '带 accountId 的明细只认该账号（账号已删 → 回退模型名，不并入同源其它账号）'
    )
    const legacyGroupField = ['vendor', 'Key'].join('')
    const legacyGroupCol = ['vendor', 'key'].join('_')
    ok(!idxSrc.includes(legacyGroupField) && !idxSrc.includes(legacyGroupCol), 'index.ts 无分组字段残留（v4 移除）')
  }

  console.log('[15] v5 多账号：通道 / Key / 订阅费 / 摊销全部按账号隔离（防串号）')
  {
    const db2 = makeFakeDb()
    const ks2 = makeFakeKeyStore()
    const settings2 = { pricing: {}, probedPricing: [] }
    const load2 = makeLoader({ getDatabase: () => db2 }, ks2.module, {
      'config/appSettings': { readAppSettings: () => settings2, updateRawAppSettings: () => ({ ...settings2 }) }
    })
    const pm2 = load2(pmPath)
    const usage2 = load2(path.resolve(__dirname, '../src/main/moa/usage.ts'))

    const src = pm2.addProvider('多账号厂商', 'https://x.example.com/v1', 'PLAN-KEY', {
      billing: 'plan', plan: { amount: 10, currency: 'USD', anchorTs: ANCHOR }
    }).id
    const planAcc = src // 默认账号 id = provider id
    const usageAcc = pm2.addProviderAccount(src, { label: '按量号', billing: 'usage', apiKey: 'USAGE-KEY' }).id

    let p = pm2.getAllProviders().find((x) => x.id === src)
    eq(p.accounts.length, 2, '同来源可挂多个账号')
    eq(p.activeAccountId, planAcc, '新增账号不抢占当前账号')
    eq(p.billing, 'plan', '投影通道仍是当前（Plan）账号')
    eq(p.apiKey, 'PLAN-KEY', '投影 Key 仍是当前账号的')
    eq(p.accounts.find((a) => a.id === usageAcc).apiKey, 'USAGE-KEY', '每账号各存各的 Key')
    ok(ks2.state.map[planAcc] !== ks2.state.map[usageAcc], '两账号 Key 在 key-store 互不覆盖')

    // 切当前账号：投影跟着走，另一个账号的数据分文不动
    pm2.setActiveProviderAccount(src, usageAcc)
    p = pm2.getAllProviders().find((x) => x.id === src)
    eq(p.activeAccountId, usageAcc, '切换当前账号')
    eq(p.billing, 'usage', '投影通道 = 按量账号')
    eq(p.apiKey, 'USAGE-KEY', '投影 Key = 按量账号')
    eq(p.plan, undefined, '投影订阅费 = 按量账号（未配置 → 省略）')
    pm2.setActiveProviderAccount(src, planAcc)

    // 写入端快照 accountId
    const provs2 = pm2.getAllProviders()
    const snap = usage2.buildUsageEntries(
      [{ modelId: 'm', providerId: src, role: 'sub', prompt: 100, completion: 0 }],
      ANCHOR + DAY
    )
    eq(snap[0].accountId, planAcc, '写入时把当前账号 id 快照进明细')

    // 摊销分桶按账号：Plan 账号的订阅费不被按量账号行稀释
    const rows2 = [
      { modelId: 'm', providerId: src, accountId: planAcc, prompt: 100, completion: 0, timestamp: ANCHOR + DAY, cost: 0 },
      { modelId: 'm', providerId: src, accountId: planAcc, prompt: 300, completion: 0, timestamp: ANCHOR + DAY, cost: 0 },
      { modelId: 'm', providerId: src, accountId: usageAcc, prompt: 5000, completion: 0, timestamp: ANCHOR + DAY, cost: 0.77 }
    ]
    const c2 = usage2.computePlanAllocatedCosts(rows2, provs2)
    near(c2[0], 2.5, 'Plan 账号桶：10 USD × 100/400 = 2.5')
    near(c2[1], 7.5, 'Plan 账号桶 Σ = 10 USD（未被按量行拉大分母）')
    eq(c2[2], 0.77, '按量账号行原样保留')

    // 切当前账号后，历史行仍按其快照账号解析
    pm2.setActiveProviderAccount(src, usageAcc)
    const c3 = usage2.computePlanAllocatedCosts(rows2, pm2.getAllProviders())
    near(c3[0], 2.5, '当前账号已切走，历史 Plan 行仍按快照账号摊销（不串号）')
    pm2.setActiveProviderAccount(src, planAcc)

    // 同来源两个 Plan 账号各有各的订阅费 → 独立分桶
    const src2 = pm2.addProvider('双 Plan 厂商', 'https://y.example.com/v1', '', {
      billing: 'plan', plan: { amount: 100, currency: 'USD', anchorTs: ANCHOR }
    }).id
    const plan2 = pm2.addProviderAccount(src2, {
      label: '二号', billing: 'plan', apiKey: 'K2', plan: { amount: 20, currency: 'USD', anchorTs: ANCHOR }
    }).id
    const rows4 = [
      { modelId: 'm', providerId: src2, accountId: src2, prompt: 100, completion: 0, timestamp: ANCHOR + DAY, cost: 0 },
      { modelId: 'm', providerId: src2, accountId: src2, prompt: 300, completion: 0, timestamp: ANCHOR + DAY, cost: 0 },
      { modelId: 'm', providerId: src2, accountId: plan2, prompt: 400, completion: 0, timestamp: ANCHOR + DAY, cost: 0 }
    ]
    const c4 = usage2.computePlanAllocatedCosts(rows4, pm2.getAllProviders())
    near(c4[0], 25, '账号1 独立桶：100 USD × 100/400 = 25')
    near(c4[1], 75, '账号1 桶 Σ = 100 USD')
    near(c4[2], 20, '账号2 独立桶独享自己的 20 USD（不与账号1稀释）')

    // 删除守卫：最后一个账号不可删；删当前账号自动接任
    const solo = pm2.addProvider('独账号厂商', 'https://z.example.com/v1', 'K1').id
    throws(() => pm2.removeProviderAccount(solo), '至少保留一个账号', '来源至少保留一个账号')
    const second = pm2.addProviderAccount(solo, { label: '副号', billing: 'usage', apiKey: 'K2' }).id
    pm2.removeProviderAccount(solo) // 删的正是当前账号
    const p3 = pm2.getAllProviders().find((x) => x.id === solo)
    eq(p3.accounts.length, 1, '删除后剩一个账号')
    eq(p3.activeAccountId, second, '删当前账号 → 自动接任剩余账号')
    eq(p3.apiKey, 'K2', '接任账号的 Key 生效')
    ok(ks2.state.map[solo] === undefined, '被删账号的 Key 一并清除')
  }

  console.log('')
  console.log(`${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
