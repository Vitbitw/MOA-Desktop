// 纯 Node 测试：src/main/providers/providerManager.ts（T1 同厂商分组 / 按量-Plan 通道 / 组 key 同步）
// 覆盖：① addProvider 三件套写入 + getAllProviders 映射（plan 缺省语义）
//      ② updateProvider 逐字段更新 + plan:null 清空
//      ③ updateProviderKey：组内同步 / 独立厂商只写自身 / 不存在 id 抛错
//      ④ **MF-1 回归**：第 2 个 key 写入失败 → 异常上抛且已写项回滚（组内无新旧混存）
//      ⑤ backfill：默认态标记 / 用户改过不覆盖 / 幂等
//      ⑥ seed 预设：清单命中 → plan / 组名
// 用法：node test-e2e/vendor-billing.cjs
// 加载方式：esbuild transform 各 TS 模块 → CJS，new Function 注入 stub require（db / key-store / fetchProxy / uiBridge）
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

// ── stub DB：内存 providers 行数组，按 SQL 文本分发 ──
function makeFakeDb() {
  const rows = []
  const def = (o) => ({
    model_list: '[]', enabled: 1, created_at: Date.now(),
    vendor_key: '', billing: 'usage', plan_amount: null, plan_currency: 'CNY', plan_anchor_ts: null,
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
      if (/^SELECT id, name, base_url, model_list, enabled, vendor_key, billing, plan_amount, plan_currency, plan_anchor_ts FROM providers ORDER BY name$/i.test(s)) {
        return rows.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))
      }
      if (/^SELECT id, name, base_url, model_list, enabled FROM providers ORDER BY name$/i.test(s)) {
        // T1 之前的旧列形态（不应出现，防御）
        return rows.slice()
      }
      if (/^SELECT id FROM providers WHERE vendor_key = \?$/i.test(s)) {
        return rows.filter((r) => r.vendor_key === params0(s, arguments)).map((r) => ({ id: r.id }))
      }
      if (/^SELECT id, name FROM providers WHERE billing = 'usage' AND vendor_key = ''$/i.test(s)) {
        return rows.filter((r) => r.billing === 'usage' && r.vendor_key === '').map((r) => ({ id: r.id, name: r.name }))
      }
      if (/^SELECT name FROM providers$/i.test(s)) {
        return rows.map((r) => ({ name: r.name }))
      }
      throw new Error('unexpected query sql: ' + s)
    },
    queryOne(sql, params = []) {
      const s = sql.trim()
      if (/^SELECT id, vendor_key FROM providers WHERE id = \?$/i.test(s)) {
        const r = rows.find((x) => x.id === params[0])
        return r ? { id: r.id, vendor_key: r.vendor_key } : null
      }
      throw new Error('unexpected queryOne sql: ' + s)
    }
  }
  // query 里 vendor_key 过滤的参数取用（避免闭包外 arguments 混淆，单独实现）
  function params0() { return undefined }
}

// query 的 vendor_key 过滤需要 params——query(sql, params) 签名在 db.query 中支持第二参
function patchQueryParams(db) {
  const rawQuery = db.query.bind(db)
  db.query = (sql, params = []) => {
    const s = sql.trim()
    if (/^SELECT id FROM providers WHERE vendor_key = \?$/i.test(s)) {
      return db.rows.filter((r) => r.vendor_key === params[0]).map((r) => ({ id: r.id }))
    }
    return rawQuery(sql, params)
  }
}

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

// ── 模块加载（stub db / key-store / fetchProxy / uiBridge；defaults / ipc-channels 真实 transform） ──
function makeLoader(dbModule, keyStoreModule) {
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
    const load = makeLoader({ getDatabase: () => db }, ks.module)
    const pm = load(pmPath)
    const defaults = load(defaultsPath)

    const a = pm.addProvider('阿里云百炼 (Qwen)', 'https://dashscope.aliyuncs.com/v1', '***', {
      vendorKey: '阿里云', billing: 'usage'
    })
    const b = pm.addProvider('阿里云 Token Plan', 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', '***', {
      vendorKey: '阿里云', billing: 'plan',
      plan: { amount: 68, currency: 'CNY', anchorTs: 1757000000000 }
    })
    const c = pm.addProvider('OpenAI', '', '***') // 无 opts → 默认态
    eq(db.rows.find((r) => r.id === c.id).billing, 'usage', '缺省 billing = usage')
    eq(db.rows.find((r) => r.id === c.id).vendor_key, '', '缺省 vendor_key 为空')

    const all = pm.getAllProviders()
    eq(all.find((p) => p.id === b.id).billing, 'plan', 'billing 映射 plan')
    eq(all.find((p) => p.id === b.id).vendorKey, '阿里云', 'vendorKey 映射')
    eq(all.find((p) => p.id === b.id).plan, { amount: 68, currency: 'CNY', anchorTs: 1757000000000 }, 'plan 三件套映射')
    eq(all.find((p) => p.id === a.id).plan, undefined, 'plan_amount NULL → plan 省略（未配置订阅费）')
    eq(all.find((p) => p.id === c.id).plan, undefined, '独立记录 plan 省略')

    console.log('[2] updateProvider 逐字段 + plan:null 清空')
    pm.updateProvider(b.id, { billing: 'usage' })
    eq(pm.getAllProviders().find((p) => p.id === b.id).billing, 'usage', '单字段更新 billing')
    eq(pm.getAllProviders().find((p) => p.id === b.id).vendorKey, '阿里云', '未传字段保持原值')
    pm.updateProvider(b.id, { plan: null })
    eq(pm.getAllProviders().find((p) => p.id === b.id).plan, undefined, 'plan:null 清空订阅费')
    throws(() => pm.updateProvider(b.id, { billing: 'annual' }), '计费通道无效', '非法 billing 抛错')
    throws(() => pm.updateProvider(b.id, { baseUrl: 'ftp://x' }), 'API 地址无效', '非法 baseUrl 抛错')

    console.log('[3] updateProviderKey：组同步 / 独立 / 不存在 id')
    pm.updateProviderKey(a.id, 'NEW-KEY')
    eq([ks.state.map[a.id], ks.state.map[b.id]], ['NEW-KEY', 'NEW-KEY'], '同组两条同步为新值')
    pm.updateProviderKey(c.id, 'OPENAI-KEY')
    eq(ks.state.map[c.id], 'OPENAI-KEY', '独立厂商只写自身')
    eq([ks.state.map[a.id], ks.state.map[b.id]], ['NEW-KEY', 'NEW-KEY'], '独立厂商写入不影响他组')
    throws(() => pm.updateProviderKey('no-such-id', 'X'), 'not found', '不存在 id 抛错')

    console.log('[4] MF-1 回归：第 2 个 key 写入失败 → 上抛且无新旧混存')
    // 此刻组内均为 NEW-KEY；注入第 2 次 saveProviderKey 失败
    ks.state.saveCalls = 0
    ks.state.failAt = 2
    throws(() => pm.updateProviderKey(a.id, 'MIXED-NEW'), 'injected key-store failure', '写入失败向上抛出')
    ks.state.failAt = 0
    eq(
      [ks.state.map[a.id], ks.state.map[b.id]],
      ['NEW-KEY', 'NEW-KEY'],
      '已写项回滚为旧值：组内无新旧 key 混存'
    )

    console.log('[5] backfill：默认态标记 / 改过不覆盖 / 幂等')
    // 造三类记录：默认态命中 plan+组 / 默认态仅组 / 用户已改过（billing=plan, vendor_key=''）
    const d = pm.addProvider('StepFun', 'https://api.stepfun.com/step_plan/v1', '')       // 命中 plan + 组 StepFun
    const e = pm.addProvider('MiniMax (中国)', 'https://api.minimaxi.com/v1', '')         // 仅组 MiniMax
    const f = pm.addProvider('Kilo Code', 'https://api.kilo.ai/api/gateway', '')          // 命中 plan，无组清单
    // f：用户已手动改过（vendor_key 已有值 → 不在默认态）
    pm.updateProvider(f.id, { vendorKey: '用户自建组' })
    // d、e 用 seed 预设？addProvider 无 opts → 默认态 ✓
    pm.backfillProviderBilling()
    const g = (id) => pm.getAllProviders().find((p) => p.id === id)
    eq(g(d.id).billing, 'plan', 'backfill：默认态命中 → plan')
    eq(g(d.id).vendorKey, 'StepFun', 'backfill：默认态命中 → 组名')
    eq(g(e.id).billing, 'usage', 'backfill：仅组命中 → billing 不动')
    eq(g(e.id).vendorKey, 'MiniMax', 'backfill：组名补齐')
    eq(g(f.id).billing, 'usage', 'backfill：用户已改过（vendor_key 非空）→ billing 不覆盖')
    eq(g(f.id).vendorKey, '用户自建组', 'backfill：用户分组保留')
    pm.backfillProviderBilling()
    eq(g(d.id).billing, 'plan', '二次运行幂等（billing 不变）')
    eq(g(d.id).vendorKey, 'StepFun', '二次运行幂等（vendor_key 不变）')

    console.log('[6] seed 预设：清单命中 → plan / 组名')
    const emptyDb = makeFakeDb(); patchQueryParams(emptyDb)
    const seedPm = makeLoader({ getDatabase: () => emptyDb }, makeFakeKeyStore().module)
    seedPm(pmPath).seedBuiltInProviders()
    const names = emptyDb.rows.map((r) => r.name)
    const pa = seedPm(path.resolve(__dirname, '../src/shared/providerAccess.ts'))
    const nonLocal = defaults.BUILT_IN_PROVIDER_TEMPLATES.filter((t) => !pa.isLocalBaseUrl(t.baseUrl))
    ok(names.length === nonLocal.length, 'seed 条数 = 非本地模板数（本地回环模板不预置）', { got: names.length, want: nonLocal.length })
    const cc = emptyDb.rows.find((r) => r.name === 'Command Code')
    eq(cc && [cc.billing, cc.vendor_key], ['plan', ''], 'Command Code → plan、无组（单条厂商）')
    const ali = emptyDb.rows.find((r) => r.name === '阿里云 Token Plan')
    eq(ali && [ali.billing, ali.vendor_key], ['plan', '阿里云'], '阿里云 Token Plan → plan + 组阿里云')
    const qwen = emptyDb.rows.find((r) => r.name === '阿里云百炼 (Qwen)')
    eq(qwen && [qwen.billing, qwen.vendor_key], ['usage', '阿里云'], '阿里云百炼 → usage + 组阿里云')
    const oai = emptyDb.rows.find((r) => r.name === 'OpenAI')
    eq(oai && [oai.billing, oai.vendor_key], ['usage', ''], 'OpenAI → 默认态')
    const planCount = emptyDb.rows.filter((r) => r.billing === 'plan').length
    eq(planCount, defaults.PLAN_BILLING_NAMES.length, 'seed 后 plan 记录数 = 清单数')
  }

  console.log('')
  console.log(`${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
