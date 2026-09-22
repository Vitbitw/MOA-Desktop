// 纯 Node 测试：src/main/providers/providerManager.ts（按量-Plan 通道；v4 B 方案：厂商分组已移除）
// 覆盖：① addProvider 三件套写入 + getAllProviders 映射（plan 缺省语义）
//      ② updateProvider 逐字段更新 + plan:null 清空
//      ③ updateProviderKey：只写本条 / 不存在 id 抛错（v4 单条语义，组同步已退役）
//      ④ **MF-1 回归**：key 写入失败 → 异常上抛且本条回滚（无新旧混存）
//      ⑤ backfill（v4.1 一次性）：清单命中补 plan / 非清单名不动 / 一次性标记置位 / 手动改回不被覆盖
//      ⑥ seed 预设：清单命中 → plan
//      ⑦ Plan 比值摊销（T2）：跨 anchor 分桶 / 桶内 Σ=消费 / 未配订阅费单价链回退 / manual 优先 / CNY 折算 / 零 token 不除零
//      ⑧ 探查条目按通道过滤（T2 §5）：绑定条目仅同厂商命中、无标记条目全通道命中
//      ⑨ 查询范围汇聚重算（T2.1 评审 MF-1）：多行同桶 Σ=amountUSD（非行数×amountUSD）/ 跨 provider 独立桶 / 无 plan 行 null
//      ⑩ 挂接结构断言（T2.1）：SUMMARY/TODAY 必须调 computeRangePlanCosts（禁用挂接即红，封堵评审变异⑥零覆盖）
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

// ── stub DB：内存 providers 行数组，按 SQL 文本分发 ──
function makeFakeDb() {
  const rows = []
  const def = (o) => ({
    model_list: '[]', enabled: 1, created_at: Date.now(),
    billing: 'usage', plan_amount: null, plan_currency: 'CNY', plan_anchor_ts: null,
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
  return {
    rows,
    exec(sql, params = []) {
      const s = sql.trim()
      let m
      if ((m = s.match(/^INSERT INTO providers \(([^)]+)\) VALUES\s*\(([^)]+)\)$/i))) {
        // 列名与 VALUES 逐位对齐：'?' 消费 params，字面量（如 enabled 的 1）直接取值
        const cols = m[1].split(',').map((c) => c.trim())
        const vals = m[2].split(',').map((v) => v.trim())
        const obj = {}
        let pi = 0
        cols.forEach((c, i) => {
          if (vals[i] === '?') obj[c] = params[pi++]
          else obj[c] = /^-?\d+(\.\d+)?$/.test(vals[i]) ? Number(vals[i]) : vals[i]
        })
        rows.push(def(obj))
      } else if ((m = s.match(/^UPDATE providers SET (.+?) WHERE id = \?$/i))) {
        const id = params[params.length - 1]
        const row = rows.find((r) => r.id === id)
        if (row) applySet(row, m[1], params.slice(0, params.length - 1))
      } else if (/^DELETE FROM providers WHERE id = \?$/i.test(s)) {
        const i = rows.findIndex((r) => r.id === params[0])
        if (i >= 0) rows.splice(i, 1)
      } else {
        throw new Error('unexpected exec sql: ' + s)
      }
      return { changes: 1 }
    },
    query(sql) {
      const s = sql.trim()
      if (/^SELECT id, name, base_url, model_list, enabled, billing, plan_amount, plan_currency, plan_anchor_ts FROM providers ORDER BY name$/i.test(s)) {
        return rows.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))
      }
      if (/^SELECT id, name, base_url, model_list, enabled FROM providers ORDER BY name$/i.test(s)) {
        // T1 之前的旧列形态（不应出现，防御）
        return rows.slice()
      }
      if (/^SELECT id, name FROM providers WHERE billing = 'usage'$/i.test(s)) {
        return rows.filter((r) => r.billing === 'usage').map((r) => ({ id: r.id, name: r.name }))
      }
      if (/^SELECT name FROM providers$/i.test(s)) {
        return rows.map((r) => ({ name: r.name }))
      }
      throw new Error('unexpected query sql: ' + s)
    },
    queryOne(sql, params = []) {
      const s = sql.trim()
      if (/^SELECT id FROM providers WHERE id = \?$/i.test(s)) {
        const r = rows.find((x) => x.id === params[0])
        return r ? { id: r.id } : null
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
    eq(db.rows.find((r) => r.id === c.id).billing, 'usage', '缺省 billing = usage')

    const all = pm.getAllProviders()
    eq(all.find((p) => p.id === b.id).billing, 'plan', 'billing 映射 plan')
    eq(all.find((p) => p.id === b.id).plan, { amount: 68, currency: 'CNY', anchorTs: 1757000000000 }, 'plan 三件套映射')
    eq(all.find((p) => p.id === a.id).plan, undefined, 'plan_amount NULL → plan 省略（未配置订阅费）')
    eq(all.find((p) => p.id === c.id).plan, undefined, '独立记录 plan 省略')

    console.log('[2] updateProvider 逐字段 + plan:null 清空')
    pm.updateProvider(b.id, { billing: 'usage' })
    eq(pm.getAllProviders().find((p) => p.id === b.id).billing, 'usage', '单字段更新 billing')
    eq(pm.getAllProviders().find((p) => p.id === b.id).name, '阿里云 Token Plan', '未传字段保持原值')
    pm.updateProvider(b.id, { plan: null })
    eq(pm.getAllProviders().find((p) => p.id === b.id).plan, undefined, 'plan:null 清空订阅费')
    throws(() => pm.updateProvider(b.id, { billing: 'annual' }), '计费通道无效', '非法 billing 抛错')
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
    pm.updateProvider(d.id, { billing: 'usage' })
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
    eq(cc && cc.billing, 'plan', 'Command Code → plan')
    const ali = emptyDb.rows.find((r) => r.name === '阿里云 Token Plan')
    eq(ali && ali.billing, 'plan', '阿里云 Token Plan → plan')
    const qwen = emptyDb.rows.find((r) => r.name === '阿里云百炼 (Qwen)')
    eq(qwen && qwen.billing, 'usage', '阿里云百炼 → usage')
    const oai = emptyDb.rows.find((r) => r.name === 'OpenAI')
    eq(oai && oai.billing, 'usage', 'OpenAI → 默认 usage')
    const planCount = emptyDb.rows.filter((r) => r.billing === 'plan').length
    eq(planCount, defaults.PLAN_BILLING_NAMES.length, 'seed 后 plan 记录数 = 清单数')
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
    // v4 B 方案：groupBy=provider 拆行 key = 「来源名·通道」恒带后缀（分组字段公式已退役）
    ok(summarySeg.includes("info.name}·${info.billing === 'plan' ? 'Plan' : '按量'}"), 'SUMMARY 拆行 key = 来源名·通道（恒带后缀）')
    const legacyGroupField = ['vendor', 'Key'].join('')
    const legacyGroupCol = ['vendor', 'key'].join('_')
    ok(!idxSrc.includes(legacyGroupField) && !idxSrc.includes(legacyGroupCol), 'index.ts 无分组字段残留（v4 移除）')
  }

  console.log('')
  console.log(`${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
