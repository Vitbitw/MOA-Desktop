// 行为测试：从 commandCode.ts 抽取纯函数 + 分页/探针逻辑，注入假 ccGet 做断言
// 用法：npm run test:monitor   （或 node test-e2e/monitor-behavior.cjs <path-to-commandCode.ts>）
const fs = require('fs')
const path = require('path')

const file = process.argv[2] || path.resolve(__dirname, '../src/main/monitoring/commandCode.ts')
// 归一化换行：Windows 新检出（core.autocrlf=true）得到 CRLF，而下面的抽取正则按 LF 形状匹配（\n}）
const src = fs.readFileSync(file, 'utf8').split(String.fromCharCode(13)).join('')

function grab(name, re) {
  const m = src.match(re)
  if (!m) throw new Error('抽取失败: ' + name)
  return m[0]
}
const fn = (name) => grab(name, new RegExp('(?:async )?function ' + name + '\\([\\s\\S]*?\\n\\}\\n'))

const parts = [
  fn('toNum'),
  fn('isObj'),
  fn('unwrapSuccess'),
  fn('str'),
  fn('toEpochSec'),
  grab('CC_MODE_LABELS', /const CC_MODE_LABELS[\s\S]*?\n}/),
  fn('parseUsageRecord'),
  grab('extractUsageArray', /function extractUsageArray\([\s\S]*?\n  return null\n}/),
  grab('parseUsagePage', /function parseUsagePage\([\s\S]*?\n  return page\n}/),
  grab('USAGE_PAGE_SIZE', /const USAGE_PAGE_SIZE = \d+/),
  grab('USAGE_PROBE_PAGE_SIZE', /const USAGE_PROBE_PAGE_SIZE = \d+/),
  grab('USAGE_PROBE_COOLDOWN_MS', /const USAGE_PROBE_COOLDOWN_MS = [^\n]+/),
  grab('probeDisabledUntil', /let probeDisabledUntil = \d+/),
  grab('USAGE_MAX_PAGES', /const USAGE_MAX_PAGES = \d+/),
  grab('USAGE_PAGE_BUDGET_MS', /const USAGE_PAGE_BUDGET_MS = [\d_]+/),
  grab('DEBUG_USAGE_PAGES', /const DEBUG_USAGE_PAGES = [^\n]+/),
  fn('fetchUsagePages'),
  fn('fetchUsageRecords'),
  fn('recordTimeRange'),
  fn('parseUsageCharts'),
  fn('aggregateChartRows'),
  fn('parseSummary'),
  grab('CC_PLAN_TIERS', /const CC_PLAN_TIERS[\s\S]*?\n}/),
  fn('computeMonthlyWindow'),
  fn('classifyTotalFailure'),
  fn('aggregateRecords')
]

const cache = {}
function makeFactory(ccGet) {
  if (!cache.js) {
    const esbuild = require('esbuild')
    cache.js = esbuild.transformSync(parts.join('\n\n'), { loader: 'ts', format: 'cjs', target: 'node18' }).code
  }
  const f = new Function(
    'ccGet',
    cache.js +
      '\n; return { fetchUsageRecords, fetchUsagePages, aggregateRecords, parseUsageRecord, parseUsagePage, parseSummary, computeMonthlyWindow, parseUsageCharts, aggregateChartRows, recordTimeRange, classifyTotalFailure, USAGE_MAX_PAGES, USAGE_PAGE_SIZE, USAGE_PROBE_PAGE_SIZE }'
  )
  return f(ccGet)
}
const factory = makeFactory

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

function pageResp(usages, nextCursor, days) {
  return {
    status: 200,
    body: { success: true, data: { usages, window: days === undefined ? undefined : { days }, nextCursor: nextCursor ?? null } }
  }
}
function rec(model, opts = {}) {
  return {
    id: 'r' + Math.random().toString(36).slice(2),
    tokensIn: opts.tokensIn ?? 100,
    tokensOut: opts.tokensOut ?? 50,
    tokensTotal: opts.tokensTotal ?? 150,
    createdAt: opts.createdAt,
    mode: opts.mode,
    meta: opts.meta
  }
}
const many = (n, model) => Array.from({ length: n }, () => rec(model, { meta: { model } }))
const uuid = 'x'.repeat(10)

console.log('\n[1] parseUsageRecord：模型名与成本口径')
{
  const f = factory(() => {})
  eq(f.parseUsageRecord(rec(undefined, { meta: { model: 'opus-4.7', totalCost: 0.5 } })).model, 'opus-4.7', 'meta.model 优先')
  eq(f.parseUsageRecord({ tokensTotal: 10, mode: 'learning', meta: {} }).model, 'taste-1', 'mode=learning 无 meta.model → taste-1')
  eq(f.parseUsageRecord({ tokensTotal: 10, mode: 'web-search', meta: {} }).model, 'web-search', 'mode=web-search → web-search')
  eq(f.parseUsageRecord({ tokensTotal: 10, mode: 'weird-mode', meta: {} }).model, 'weird-mode', '未知 mode 原样兜底')
  ok(f.parseUsageRecord({ tokensTotal: 10, meta: {} }) === undefined, '既无 model 也无 mode → 仍丢弃')
  eq(f.parseUsageRecord(rec(undefined, { meta: { model: 'm', totalCost: 1.25 } })).cost, 1.25, '成本优先 meta.totalCost')
  eq(
    f.parseUsageRecord(rec(undefined, { meta: { model: 'm', inputCost: 1, outputCost: 2, cacheCost: 0.25, creditsTotal: 999 } })).cost,
    3.25,
    'totalCost 缺失 → 分项求和（studio 口径）'
  )
  eq(f.parseUsageRecord({ tokensTotal: 10, creditsTotal: 7, meta: { model: 'm' } }).cost, 7, '分项也缺失 → creditsTotal 兜底')
  eq(f.parseUsageRecord(rec(undefined, { meta: { model: 'm' } })).cost, 0, '全缺失 → 0')

  // id / createdAt（本地累计去重依赖）
  const withId = f.parseUsageRecord({ id: 'rec-1', createdAt: '2026-09-17T02:00:00.000Z', tokensTotal: 5, meta: { model: 'm' } })
  eq([withId.id, withId.createdAtMs], ['rec-1', Date.parse('2026-09-17T02:00:00.000Z')], 'id / createdAt 解析')
  const noId = f.parseUsageRecord({ createdAt: '2026-09-17T02:00:00.000Z', tokensTotal: 5, meta: { model: 'm' } })
  ok(noId.id.includes('|m|5|'), '无 id 时合成组合键: ' + noId.id)
  eq(
    f.parseUsageRecord({ createdAt: '2026-09-17T02:00:00.000Z', tokensTotal: 5, meta: { model: 'm' } }).id,
    noId.id,
    '合成键可复现（去重依赖此性质）'
  )
}

;(async () => {
  console.log('\n[2] fetchUsageRecords：游标翻页')
  {
    const calls = []
    const pages = [
      pageResp([rec(undefined, { meta: { model: 'a', totalCost: 1 } }), rec(undefined, { meta: { model: 'b', totalCost: 2 } })], 'CUR1', 30),
      pageResp([rec(undefined, { meta: { model: 'b', totalCost: 3 } }), rec(undefined, { mode: 'web-search' })], 'CUR2', 30),
      pageResp([rec(undefined, { meta: { model: 'c', totalCost: 4 } })], null, 30)
    ]
    const ccGet = async (url) => {
      calls.push(url)
      const cursor = new URL('https://x' + url).searchParams.get('cursor')
      return pages[cursor === null ? 0 : Number(cursor.slice(3))]
    }
    const f = factory(ccGet)
    const res = await f.fetchUsageRecords(uuid)
    eq(res.pages, 3, '翻满 3 页')
    eq(res.records.length, 5, '记录合并 5 条')
    eq(res.truncated, false, '末页 nextCursor=null → 未截断')
    eq(res.windowDays, 30, 'window.days 解析')
    eq(calls.length, 3, '请求 3 次（未触发试探）')
    ok(calls[0].includes('limit=100') && !calls[0].includes('cursor'), '第 1 页 limit=100 且不带 cursor')
    ok(calls[1].includes('cursor=CUR1') && calls[2].includes('cursor=CUR2'), '后续页带上一页 nextCursor')
    const models = f.aggregateRecords(res.records)
    eq(models.map((m) => m.model), ['b', 'c', 'a', 'web-search'], '按成本降序聚合（b=5, c=4, a=1, web-search=0）')
    eq(models.find((m) => m.model === 'b').requests, 2, 'b 跨页合并为 2 次请求')
    eq(models.find((m) => m.model === 'b').cost, 5, 'b 成本跨页累加')
  }

  console.log('\n[3] fetchUsageRecords：页数上限 → truncated')
  {
    let served = 0
    const f = factory(async () => {
      served++
      return pageResp(many(100, 'm' + served), 'CUR' + served, 7)
    })
    const res = await f.fetchUsageRecords(uuid)
    eq(res.pages, f.USAGE_MAX_PAGES, '页数停在 USAGE_MAX_PAGES=' + f.USAGE_MAX_PAGES)
    eq(res.records.length, f.USAGE_MAX_PAGES * 100, '记录数 = 页数×100')
    eq(res.truncated, true, '仍有更早记录 → truncated=true')
  }

  console.log('\n[4] 失败分层：首页 / 后续页 / 网络')
  {
    let n = 0
    const f = factory(async () => {
      n++
      if (n === 1) return pageResp([rec(undefined, { meta: { model: 'a' } })], 'CUR1')
      throw new Error('ECONNRESET')
    })
    const res = await f.fetchUsageRecords(uuid)
    eq([res.records.length, res.truncated, res.status], [1, true, 200], '后续页网络异常 → 保留第 1 页 + truncated')
  }
  {
    const f = factory(async () => {
      throw new Error('ENOTFOUND')
    })
    const res = await f.fetchUsageRecords(uuid)
    eq([res.status, res.records.length, res.truncated], [null, 0, false], '首页网络异常 → status=null / 无记录 / 不算截断')
  }
  {
    const f = factory(async () => ({ status: 401, body: null }))
    eq((await f.fetchUsageRecords(uuid)).status, 401, '首页 401 → 透传给调用方')
  }
  {
    let n = 0
    const f = factory(async () => {
      n++
      return n === 1 ? pageResp([rec(undefined, { meta: { model: 'a' } })], 'CUR1') : { status: 500, body: { message: 'boom' } }
    })
    eq((await f.fetchUsageRecords(uuid)).truncated, true, '第 2 页 500 → truncated')
  }

  console.log('\n[5] fetchUsageRecords：页大小自适应试探（新增核心逻辑）')
  {
    const calls = []
    const f = factory(async (url) => {
      const limit = Number(new URL('https://x' + url).searchParams.get('limit'))
      calls.push(limit)
      return limit === 500 ? pageResp(many(300, 'big'), null, 1) : pageResp(many(100, 'small'), null, 1)
    })
    const res = await f.fetchUsageRecords(uuid)
    eq(calls, [100, 500], '先试 100，命中「拿满一页且无游标」后用 500 复探')
    eq(res.records.length, 300, '采用真正拿到更多记录的结果（300 条）')
    eq(res.requestedLimit, 500, '记录实际生效的页大小')
    eq(res.truncated, false, '服务端明确末页 → 未截断')
    const models = f.aggregateRecords(res.records)
    eq([models.length, models[0].requests], [1, 300], '聚合覆盖全部 300 条')
  }
  {
    const calls = []
    const f = factory(async (url) => {
      const limit = Number(new URL('https://x' + url).searchParams.get('limit'))
      calls.push(limit)
      return limit === 500 ? { status: 400, body: { message: 'invalid limit' } } : pageResp(many(100, 'small'), null, 1)
    })
    const res = await f.fetchUsageRecords(uuid)
    eq(calls, [100, 500], '试探确实发出过')
    eq([res.status, res.records.length, res.requestedLimit], [200, 100, 100], '400 → 静默沿用 100 条结果，不改行为')
    // 冷却：同一进程内第二轮不应再次试探
    await f.fetchUsageRecords(uuid)
    eq(calls.filter((c) => c === 500).length, 1, '被拒后进入冷却：后续刷新不再重复试探')
    eq(calls.length, 3, '请求序列 = 100,500,100（第二轮只打基础页）')
  }
  {
    const f = factory(async () => pageResp(many(100, 'same'), null, 1))
    const res = await f.fetchUsageRecords(uuid)
    eq([res.records.length, res.requestedLimit], [100, 100], '服务端 clamp 到 100 → 沿用 base')
  }
  {
    let n = 0
    const f = factory(async () => {
      n++
      return { status: 401, body: null }
    })
    eq((await f.fetchUsageRecords(uuid)).status, 401, '试探返回 401 → 仍判会话失效（不能退化成「明细为空」）')
  }

  console.log('\n[6] recordTimeRange：明细覆盖的时间跨度')
  {
    const f = factory(() => {})
    const t1 = '2026-09-17T02:00:00.000Z'
    const t2 = '2026-09-17T02:30:00.000Z'
    const range = f.recordTimeRange([rec(undefined, { createdAt: t2 }), rec(undefined, { createdAt: t1 }), { createdAt: 1790000000 }])
    eq(range.fromTs, Date.parse(t1), '取最小时间（ISO 形态）')
    eq(range.toTs, 1790000000 * 1000, '取最大时间（epoch 秒形态参与比较）')
    eq(f.recordTimeRange([{ noModel: true }]), {}, '无 createdAt → 返回空对象')
  }

  console.log('\n[7] parseUsagePage：多种响应形态')
  {
    const f = factory(() => {})
    eq(f.parseUsagePage({ usages: [{}, {}], nextCursor: 'C' }).nextCursor, 'C', '根部 usages + nextCursor')
    eq(f.parseUsagePage({ success: true, data: { usages: [], nextCursor: null } }).nextCursor, undefined, 'nextCursor=null → 无下一页')
    eq(f.parseUsagePage({ data: { usages: [{}] } }).usages.length, 1, '嵌套 data.usages')
    eq(f.parseUsagePage({ items: [{}] }).usages.length, 1, 'items 兼容')
    eq(f.parseUsagePage([{}]).usages.length, 1, '根部数组兼容')
    ok(f.parseUsagePage({ message: 'nope' }) === null, '无法识别 → null')
  }

  console.log('\n[8] classifyTotalFailure：全端点失败判定（避免网络全挂伪装成空数据）')
  {
    const f = factory(() => {})
    const base = {
      anySection: false,
      usageStatus: 200,
      requiredStatuses: [200, 200, 200],
      requiredRejected: false,
      statuses: [200, 200, 200]
    }
    eq(f.classifyTotalFailure({ ...base, anySection: true, usageStatus: null }), null, '有区块成功 → 不算失败')
    eq(f.classifyTotalFailure({ ...base, usageStatus: null }).code, 'network', '明细网络异常 → network')
    eq(f.classifyTotalFailure({ ...base, requiredRejected: true }).code, 'network', '必发端点被 reject → network')
    eq(f.classifyTotalFailure({ ...base, requiredStatuses: [null, 200, 200] }).code, 'network', '必发端点无状态 → network')
    eq(f.classifyTotalFailure({ ...base, requiredStatuses: [500, 502, 503], statuses: [500, 502, 503] }).code, 'unknown', '全 5xx → unknown')
    eq(f.classifyTotalFailure(base), null, '全 200 但无数据（真实空白账号）→ 不算失败，保持空态')
    eq(f.classifyTotalFailure({ ...base, requiredStatuses: [500, 200, 200], statuses: [500, 200, 200] }), null, '部分成功 → 不算失败')
  }

  console.log('\n[9] parseSummary：汇总口径（periodBasis 决定「当前计费月 / 最近 30 天」）')
  {
    const f = factory(() => {})
    const s1 = f.parseSummary({
      success: true,
      data: { totalCount: 566, totalCost: 2.15, totalTokens: '55312251', successRate: 100, periodBasis: 'billing-period' }
    })
    eq(
      [s1.totalCount, s1.totalCost, s1.totalTokens, s1.periodBasis],
      [566, 2.15, 55312251, 'billing-period'],
      '解析 totalCost / totalTokens(字符串) / periodBasis'
    )
    eq(f.parseSummary({ totalCount: 1, totalCost: 0, periodBasis: 'last-30-days' }).periodBasis, 'last-30-days', 'last-30-days 口径')
    eq(f.parseSummary({ totalCount: 1, totalCost: 0 }).periodBasis, undefined, '缺 periodBasis → undefined（UI 回退"服务端口径"）')
    ok(f.parseSummary({ message: 'nope' }) === undefined, '无 totalCount/totalCost → undefined')
  }

  console.log('\n[10] parseUsageCharts / aggregateChartRows：本月按模型聚合（charts 端点）')
  {
    const f = factory(() => {})
    const mk = (model, bucket, requests, cost, tin = 100, tout = 200) => ({
      model,
      provider: 'vercel-ai-gateway',
      timeBucket: bucket,
      requests,
      totalCost: cost,
      inputCost: 1,
      outputCost: 2,
      creditsTotal: cost,
      cacheCost: 0,
      cacheSavings: 0,
      tokensIn: tin,
      tokensOut: tout,
      tokensTotal: tin + tout,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0
    })
    // 实测形态：索引对象 {0:{...},1:{...}} + window
    const p = f.parseUsageCharts({
      success: true,
      data: {
        0: mk('a', '2026-09-17 00:45:00', 2, 1.5),
        1: mk('b', '2026-09-17 00:45:00', 1, 0.5),
        2: mk('a', '2026-09-17 01:00:00', 3, 2.5)
      },
      window: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-17T10:00:00.000Z', periodBasis: 'billing-period' }
    })
    eq([p.rows.length, p.buckets], [3, 2], '索引对象解析 + 不同时间桶计数')
    eq(p.window.periodBasis, 'billing-period', 'window.periodBasis')
    ok(typeof p.window.fromTs === 'number' && typeof p.window.toTs === 'number', 'window.from/to 归一化为 epoch 秒')

    const rows = f.aggregateChartRows([
      { model: 'a', requests: 2, cost: 1.5, tokensIn: 100, tokensOut: 200, tokensTotal: 300, cacheCost: 0, cacheSavings: 0.1 },
      { model: 'b', requests: 1, cost: 0.5, tokensIn: 10, tokensOut: 20, tokensTotal: 30, cacheCost: 0, cacheSavings: 0 },
      { model: 'a', requests: 3, cost: 2.5, tokensIn: 300, tokensOut: 600, tokensTotal: 900, cacheCost: 0.2, cacheSavings: 0.4 }
    ])
    eq(rows.map((r) => r.model), ['a', 'b'], '按成本降序')
    eq(
      [rows[0].requests, rows[0].cost, rows[0].tokensTotal, Number(rows[0].cacheSavings.toFixed(2))],
      [5, 4, 1200, 0.5],
      '同一模型跨时间桶相加'
    )

    eq(f.parseUsageCharts([mk('x', 't', 1, 1)]).rows.length, 1, '根部数组兼容')
    eq(f.parseUsageCharts({ data: [mk('x', 't', 1, 1)] }).rows.length, 1, 'data 数组兼容')
    ok(f.parseUsageCharts({ message: 'nope' }) === null, '无法识别 → null（区块级降级）')
    ok(f.parseUsageCharts({ 0: { provider: 'x' } }) === null, '行内无 model → null')
  }

  console.log('\n[11] computeMonthlyWindow：月度额度（官网口径 = 1 − 余额/套餐额度）')
  {
    const f = factory(() => {})
    // GOAT：套餐额度 70，余额 48.418 → 已用 21.582 → 30.83%
    const goat = f.computeMonthlyWindow({ planId: 'individual-goat', status: 'active', monthlyCredits: 48.418, currentPeriodEndTs: 1790000000 })
    eq(goat.usedPercent.toFixed(2), '30.83', 'GOAT：已用% = 1 − 余额/70')
    eq(goat.resetAt, 1790000000, 'resetAt = 账单周期结束时间')
    eq(
      f.computeMonthlyWindow({ planId: 'individual-go', monthlyCredits: 5, monthlyCreditsGranted: 45 }).usedPercent.toFixed(2),
      '88.89',
      'monthlyCreditsGranted > 套餐额度 → cap 取 granted'
    )
    eq(
      f.computeMonthlyWindow({ planId: 'teams-pro', quantity: 3, monthlyCredits: 30 }).usedPercent.toFixed(2),
      '75.00',
      'org 套餐：cap = 基础额度 × 席位'
    )
    ok(f.computeMonthlyWindow({ planId: 'nope', monthlyCredits: 1 }) === undefined, '未知套餐 → undefined（不显示百分比）')
    ok(f.computeMonthlyWindow({ planId: 'individual-goat', status: 'past_due', monthlyCredits: 1 }) === undefined, 'past_due → 隐藏计量（官网行为）')
    ok(f.computeMonthlyWindow({ planId: 'individual-goat' }) === undefined, '无余额数据 → undefined')
    eq(f.computeMonthlyWindow({ planId: 'individual-goat', monthlyCredits: 0 }).usedPercent, 100, '余额 0 → 已用 100% 封顶')
    eq(f.computeMonthlyWindow({ planId: 'individual-goat', monthlyCredits: 80 }).usedPercent, 0, '余额 > cap（追加额度）→ 已用 0（官网同此夹取）')
  }

  console.log('\n──────────────────────────────')
  console.log(`通过 ${pass} / 失败 ${fail}`)
  process.exit(fail === 0 ? 0 : 1)
})()
