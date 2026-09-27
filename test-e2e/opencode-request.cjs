// OpenCode Go 刷新请求形态回归：双端点（GET /zen/go/v1/usage 三窗口 + GET /console/api/v2/usage/export CSV 明细）
// + Bearer 头 + CSV 解析矩阵 + 按模型聚合 + 落库参数 + 错误码分层
// 用法：npm run test:opencode-request
//
// 背景（设计文档 2026-09-27 §1/§4 实测）：
//   windows：GET https://opencode.ai/zen/go/v1/usage（Authorization: Bearer <API Key>）→ 200，
//     响应 { usage: { rolling / weekly / monthly: { status, percent, resetsAt(ISO) } } }；
//     percent = 已用百分比（0-100 整数）；无效 key → 401；HEAD 恒 401 → 必须 GET。
//   detail：GET https://opencode.ai/console/api/v2/usage/export?scope=organization&range=30d（Accept: text/csv）→ 200，
//     14 列 CSV（day,…,cost_micro_cents,last_active_at）、CRLF、无引号包裹、无逗号内嵌；
//     cost_micro_cents 1e8 = $1；v1 端点对 Go key 恒 403（已废弃）；range 只支持 7d/30d（24h → 400）。
//
// 本测试 stub fetchProxy + keyStore + usageAccumulator 驱动**真实** refreshOpenCodeUsage / parseUsageExportCsv /
// aggregateExportRows（esbuild 打包，不触网），断言：
//   URL / Bearer / Accept 头、实测三窗口解析、resetsAt 多形态归一（ISO / epoch 秒 / epoch 毫秒 / 缺失 / 非法）、
//   percent 越界夹取、CSV 解析矩阵（标准 / 列数不一致跳过（不足与内嵌逗号多余）/ 表头不符 null / BOM 兼容 / 数值缺省 0 / day 解析 / 表头防回归锚）、
//   聚合（多行 SUM、成本降序）、落库参数（id=day|model、cost 1e8 换算、requests 列值）、
//   双端点降级矩阵（detail 403 / 网络失败 / CSV 不识别 → ok+detail=false；windows 失败 → 错误码照旧且不发 detail）。
const path = require('path')
const esbuild = require('esbuild')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, '.hermes', 'defense-test', 'opencode-request.cjs')
const API = 'https://opencode.ai/zen/go/v1/usage'
const EXPORT_API = 'https://opencode.ai/console/api/v2/usage/export?scope=organization&range=30d'

// 实测表头（2026-09-27，逐字）——防回归锚：opencode.ts 的 EXPORT_HEADER 若漂移，本组断言必红
const CSV_HEADER =
  'day,user_type,user_id,user_name,provider,model,requests,input_tokens,output_tokens,cache_read_tokens,cache_write_5m_tokens,cache_write_1h_tokens,cost_micro_cents,last_active_at'
// 实测行（2026-09-27）
const CSV_ROW_1 =
  '2026-09-27,service_account,svcacct_x,Legacy: user@x.com,opencode-go,deepseek-v4.1-flash,298,1418794,341157,35582464,0,0,52426066,2026-09-27T10:27:54.000Z'
const CSV_ROW_2 =
  '2026-09-27,service_account,svcacct_x,Legacy: user@x.com,opencode-go,deepseek-v4-flash,1,85,29,0,0,0,3015,2026-09-27T08:58:05.000Z'
const CRLF = String.fromCharCode(13) + String.fromCharCode(10)
const LF = String.fromCharCode(10)
const CSV_STANDARD = [CSV_HEADER, CSV_ROW_1, CSV_ROW_2].join(CRLF) + CRLF
const DAY_TS = Date.UTC(2026, 8, 27) // 2026-09-27T00:00:00Z
const ROW1_TOKENS_TOTAL = 1418794 + 341157 + 35582464
const ROW1_COST = 52426066 / 1e8

const STUBS = {
  fetchProxy: `module.exports = { fetchProxy: async (url, opts) => globalThis.__fetchImpl(url, opts) }`,
  keyStore: `module.exports = {
  getUsageCredential: (k) => (globalThis.__creds || {})[k],
  saveUsageCredential: () => {},
  removeUsageCredential: () => {}
}`,
  usageAccumulator: `module.exports = {
  persistUsageRecords: (accountId, rows) => {
    ;(globalThis.__persistCalls || (globalThis.__persistCalls = [])).push({ accountId, rows })
    return 7
  }
}`
}

async function buildBundle() {
  await esbuild.build({
    stdin: {
      contents: `export { refreshOpenCodeUsage, usageApiKeyKey, parseUsageExportCsv, aggregateExportRows } from './src/main/monitoring/opencode'`,
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outfile: OUT,
    logLevel: 'silent',
    plugins: [
      {
        name: 'stubs',
        setup(build) {
          const rules = [
            [/local\/fetchProxy$/, 'fetchProxy'],
            [/store\/key-store$/, 'keyStore'],
            [/usageAccumulator$/, 'usageAccumulator']
          ]
          for (const [re, name] of rules) {
            const ns = 'stub:' + name
            build.onResolve({ filter: re }, () => ({ path: ns, namespace: 'stub' }))
            build.onLoad({ filter: new RegExp('^' + ns + '$'), namespace: 'stub' }, () => ({ contents: STUBS[name], loader: 'js' }))
          }
        }
      }
    ]
  })
  return require(OUT)
}

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
  ok(actual === expected, label, { actual, expected })
}
function closeTo(actual, expected, label) {
  ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-12, label, { actual, expected })
}

function epochSec(iso) {
  return Math.round(Date.parse(iso) / 1000)
}

// ── 假请求层：记录 URL/headers；windows 与 detail 分别路由；rejectMode（全挂）/ rejectDetail（仅明细挂）──
const requests = []
let usageRoute = () => liveShapeRoute()
let detailRoute = () => ({ status: 200, text: CSV_STANDARD })
let rejectMode = false
let rejectDetail = false

function installFetch() {
  requests.length = 0
  globalThis.__fetchImpl = async (url, opts) => {
    const u = String(url)
    requests.push({ url: u, headers: (opts && opts.headers) || {}, method: (opts && opts.method) || 'GET' })
    const isExport = u.includes('/console/api/v2/usage/export')
    if (rejectMode || (rejectDetail && isExport)) throw new Error('connect ETIMEDOUT')
    const r = isExport ? detailRoute(u) : usageRoute(u)
    return {
      status: r.status,
      json: async () => r.body,
      text: async () => (r.text !== undefined ? r.text : JSON.stringify(r.body))
    }
  }
}

/** 场景间清空请求记录（否则 find/索引会命中上一场景遗留的请求） */
function resetRequests() {
  requests.length = 0
}
function resetPersist() {
  globalThis.__persistCalls = []
}

/** 实测响应形态（2026-09-27，percent 0 三窗口全 ok） */
function liveShapeRoute() {
  return {
    status: 200,
    body: {
      usage: {
        rolling: { status: 'ok', percent: 0, resetsAt: '2026-09-27T13:50:34.916Z' },
        weekly: { status: 'ok', percent: 0, resetsAt: '2026-09-28T00:00:00.000Z' },
        monthly: { status: 'ok', percent: 0, resetsAt: '2026-10-27T03:11:54.000Z' }
      }
    }
  }
}

let refreshOpenCodeUsage = null
let usageApiKeyKey = null
let parseUsageExportCsv = null
let aggregateExportRows = null

async function main() {
  const mod = await buildBundle()
  refreshOpenCodeUsage = mod.refreshOpenCodeUsage
  usageApiKeyKey = mod.usageApiKeyKey
  parseUsageExportCsv = mod.parseUsageExportCsv
  aggregateExportRows = mod.aggregateExportRows
  installFetch()

  // ── S1：实测形态 —— 双端点（windows + detail）/ Bearer 头 / 三窗口 / models / 落库参数 ──
  console.log('')
  console.log('S1 实测响应形态：双端点 + Bearer 头 + 三窗口 + 明细聚合与落库')
  {
    globalThis.__creds = { 'acc-1.apiKey': 'oc-go-key-1' }
    rejectMode = false
    rejectDetail = false
    usageRoute = liveShapeRoute
    detailRoute = () => ({ status: 200, text: CSV_STANDARD })
    resetRequests()
    resetPersist()
    const res = await refreshOpenCodeUsage('acc-1')
    ok(res.ok === true, '200 + 实测结构 → ok=true', res)
    eq(requests.length, 2, '双端点：先 windows 后 detail，共 2 个请求')
    eq(requests[0] && requests[0].url, API, 'windows URL = https://opencode.ai/zen/go/v1/usage')
    eq(requests[0] && requests[0].headers.Authorization, 'Bearer oc-go-key-1', 'windows Authorization: Bearer <key>')
    eq(requests[0] && requests[0].headers.Accept, 'application/json', 'windows Accept: application/json')
    eq(requests[0] && requests[0].headers['User-Agent'], 'moa-desktop', 'windows User-Agent: moa-desktop')
    eq(requests[0] && requests[0].method, 'GET', 'windows GET（HEAD 恒 401，必须 GET）')
    eq(requests[1] && requests[1].url, EXPORT_API, 'detail URL = /console/api/v2/usage/export?scope=organization&range=30d（v2；v1 恒 403）')
    eq(requests[1] && requests[1].headers.Authorization, 'Bearer oc-go-key-1', 'detail Authorization: Bearer <key>')
    eq(requests[1] && requests[1].headers.Accept, 'text/csv', 'detail Accept: text/csv')
    eq(requests[1] && requests[1].method, 'GET', 'detail GET')
    eq(usageApiKeyKey && usageApiKeyKey('acc-1'), 'acc-1.apiKey', '凭据键约定 = <accountId>.apiKey（与 Command Code 一致）')
    ok(res.ok && typeof res.data.fetchedAt === 'number', 'fetchedAt 为数值（epoch 毫秒）', res.ok ? res.data : res)
    ok(
      res.ok && res.data.sourcesAvailable.windows === true && res.data.sourcesAvailable.detail === true,
      'sourcesAvailable = { windows: true, detail: true }',
      res.ok ? res.data.sourcesAvailable : res
    )
    const w = res.ok ? res.data.windows : {}
    eq(w.rolling && w.rolling.status, 'ok', 'rolling.status 原样保留')
    eq(w.rolling && w.rolling.usedPercent, 0, 'rolling.usedPercent = 0')
    eq(w.rolling && w.rolling.resetAt, epochSec('2026-09-27T13:50:34.916Z'), 'rolling.resetsAt ISO → epoch 秒')
    eq(w.weekly && w.weekly.resetAt, epochSec('2026-09-28T00:00:00.000Z'), 'weekly.resetsAt ISO → epoch 秒')
    eq(w.monthly && w.monthly.resetAt, epochSec('2026-10-27T03:11:54.000Z'), 'monthly.resetsAt ISO → epoch 秒')
    // 明细聚合（按模型）
    const models = res.ok ? res.data.models : undefined
    ok(Array.isArray(models) && models.length === 2, 'models = 2 个模型（按模型聚合）', models)
    const m1 = Array.isArray(models) ? models[0] : null
    const m2 = Array.isArray(models) ? models[1] : null
    eq(m1 && m1.model, 'deepseek-v4.1-flash', '成本降序：deepseek-v4.1-flash 在首位')
    eq(m2 && m2.model, 'deepseek-v4-flash', '次位 = deepseek-v4-flash')
    eq(m1 && m1.requests, 298, 'requests = 列值（298）')
    eq(m1 && m1.tokensIn, 1418794, 'tokensIn')
    eq(m1 && m1.tokensOut, 341157, 'tokensOut')
    eq(m1 && m1.cacheReadTokens, 35582464, 'cacheReadTokens')
    eq(m1 && m1.tokensTotal, ROW1_TOKENS_TOTAL, 'tokensTotal = 输入 + 输出 + 缓存读取 + 缓存写入（五字段之和）')
    closeTo(m1 && m1.cost, ROW1_COST, 'cost = cost_micro_cents / 1e8 = $0.52426066')
    eq(m2 && m2.tokensTotal, 85 + 29, '第二行 tokensTotal = 114（cache 全 0）')
    closeTo(m2 && m2.cost, 3015 / 1e8, '第二行 cost = 3015 / 1e8')
    // 覆盖信息
    const cov = res.ok ? res.data.modelsCoverage : undefined
    eq(cov && cov.rangeDays, 30, 'modelsCoverage.rangeDays = 30')
    eq(cov && cov.rows, 2, 'modelsCoverage.rows = 2（天 × 模型 行数）')
    eq(cov && cov.days, 1, 'modelsCoverage.days = 1（实际有数据的天数）')
    eq(cov && cov.fromTs, DAY_TS, 'fromTs = 2026-09-27 UTC 零点')
    eq(cov && cov.toTs, DAY_TS, 'toTs = 2026-09-27 UTC 零点')
    // 落库（persisted 随返回值 + 落库参数）
    eq(res.persisted, 7, 'persisted = 落库返回值透传（stub 固定返回 7，与行数 2 可分辨）')
    const call = globalThis.__persistCalls[0]
    ok(!!call, 'persistUsageRecords 被调用一次', globalThis.__persistCalls.length)
    eq(call && call.accountId, 'acc-1', '落库按 accountId 键控')
    eq(call && call.rows.length, 2, '落库行数 = CSV 行数')
    eq(call && call.rows[0].id, '2026-09-27|deepseek-v4.1-flash', '落库 id = `${day}|${model}`（自然键）')
    eq(call && call.rows[0].createdAtMs, DAY_TS, '落库 createdAtMs = day UTC 零点')
    eq(call && call.rows[0].model, 'deepseek-v4.1-flash', '落库 model')
    eq(call && call.rows[0].requests, 298, '落库 requests = 列值')
    eq(call && call.rows[0].tokensIn, 1418794, '落库 tokensIn')
    eq(call && call.rows[0].tokensTotal, ROW1_TOKENS_TOTAL, '落库 tokensTotal = 五字段之和')
    closeTo(call && call.rows[0].cost, ROW1_COST, '落库 cost = microcents / 1e8')
    eq(call && call.rows[1].id, '2026-09-27|deepseek-v4-flash', '第二行落库 id（同日不同模型不撞键）')
  }

  // ── S2：非零百分比 + resetsAt 多形态（ISO / epoch 秒 / 缺失）──
  console.log('')
  console.log('S2 非零百分比与 resetsAt 多形态')
  {
    globalThis.__creds = { 'acc-2.apiKey': 'k2' }
    usageRoute = () => ({
      status: 200,
      body: {
        usage: {
          rolling: { status: 'ok', percent: 37, resetsAt: '2026-09-27T13:50:34.916Z' },
          weekly: { status: 'ok', percent: 62, resetsAt: 1790000000 },
          monthly: { status: 'ok', percent: 95 }
        }
      }
    })
    const res = await refreshOpenCodeUsage('acc-2')
    ok(res.ok === true, 'ok=true', res)
    const w = res.ok ? res.data.windows : {}
    eq(w.rolling && w.rolling.usedPercent, 37, 'rolling.usedPercent = 37')
    eq(w.weekly && w.weekly.usedPercent, 62, 'weekly.usedPercent = 62')
    eq(w.monthly && w.monthly.usedPercent, 95, 'monthly.usedPercent = 95')
    eq(w.rolling && w.rolling.resetAt, epochSec('2026-09-27T13:50:34.916Z'), 'rolling resetsAt（ISO）正确')
    eq(w.weekly && w.weekly.resetAt, 1790000000, 'weekly resetsAt（epoch 秒）原样')
    ok(w.monthly !== undefined && w.monthly.resetAt === undefined, '缺失 resetsAt → resetAt 省略（该窗口仍产出）', w.monthly)
  }

  // ── S3：resetsAt 非法/毫秒形态 + percent 越界夹取（-5→0、150→100）+ 未知 status 原样 ──
  console.log('')
  console.log('S3 resetsAt 非法/毫秒形态、percent 夹取、status 原样')
  {
    globalThis.__creds = { 'acc-3.apiKey': 'k3' }
    usageRoute = () => ({
      status: 200,
      body: {
        usage: {
          rolling: { status: 'ok', percent: -5, resetsAt: 'not-a-date' },
          weekly: { status: 'ok', percent: 20, resetsAt: 1790000000000 },
          monthly: { status: 'limit-reached', percent: 150, resetsAt: 1790000000 }
        }
      }
    })
    const res = await refreshOpenCodeUsage('acc-3')
    ok(res.ok === true, 'ok=true（非法字段按缺失处理，不炸）', res)
    const w = res.ok ? res.data.windows : {}
    eq(w.rolling && w.rolling.usedPercent, 0, 'percent -5 → 夹取 0')
    ok(w.rolling !== undefined && w.rolling.resetAt === undefined, '非法 resetsAt 字符串 → resetAt 省略', w.rolling)
    eq(w.weekly && w.weekly.resetAt, 1790000000, 'epoch 毫秒 → 归一为 epoch 秒')
    eq(w.monthly && w.monthly.usedPercent, 100, 'percent 150 → 夹取 100')
    eq(w.monthly && w.monthly.status, 'limit-reached', '未知 status 原样保留（UI 不消费）')
  }

  // ── S4：无 key → not_authenticated（且不发请求）──
  console.log('')
  console.log('S4 无 key 时不发请求')
  {
    globalThis.__creds = {}
    resetRequests()
    const res = await refreshOpenCodeUsage('acc-4')
    ok(res.ok === false && res.code === 'not_authenticated', '无 key → not_authenticated', res)
    eq(requests.length, 0, '未发任何请求')
  }

  // ── S5：401 / 403 → session_expired；500 → unknown（error 带 HTTP n）；windows 失败不发 detail ──
  console.log('')
  console.log('S5 HTTP 状态错误分层（windows 失败 → 整体失败，不发 detail）')
  {
    globalThis.__creds = { 'acc-5.apiKey': 'k5' }
    usageRoute = () => ({ status: 401, body: { type: 'error', error: { type: 'AuthError', message: 'Unauthorized' } } })
    resetRequests()
    const r401 = await refreshOpenCodeUsage('acc-5')
    ok(r401.ok === false && r401.code === 'session_expired', '401 → session_expired（API Key 无效/过期）', r401)
    eq(requests.length, 1, 'windows 401 时不发 detail（整体已失败）')

    usageRoute = () => ({ status: 403, body: null })
    const r403 = await refreshOpenCodeUsage('acc-5')
    ok(r403.ok === false && r403.code === 'session_expired', '403 → session_expired', r403)

    usageRoute = () => ({ status: 500, body: null })
    const r500 = await refreshOpenCodeUsage('acc-5')
    ok(r500.ok === false && r500.code === 'unknown', '500 → unknown', r500)
    ok(r500.ok === false && typeof r500.error === 'string' && r500.error.includes('HTTP 500'), 'error 带 HTTP 500', r500)
  }

  // ── S6：fetch reject（网络异常）→ network ──
  console.log('')
  console.log('S6 网络异常 → network')
  {
    globalThis.__creds = { 'acc-6.apiKey': 'k6' }
    rejectMode = true
    const res = await refreshOpenCodeUsage('acc-6')
    rejectMode = false
    ok(res.ok === false && res.code === 'network', 'fetch 抛错 → network', res)
  }

  // ── S7：200 但结构不识别（{} / {usage:null} / body null / 窗口全非对象）→ unknown ──
  console.log('')
  console.log('S7 结构不识别 → unknown')
  {
    globalThis.__creds = { 'acc-7.apiKey': 'k7' }
    const cases = [
      ['{}', {}],
      ['{usage:null}', { usage: null }],
      ['body null', null],
      ['窗口全非对象', { usage: { rolling: 5, weekly: 'x', monthly: null } }]
    ]
    for (const [label, body] of cases) {
      usageRoute = () => ({ status: 200, body })
      const res = await refreshOpenCodeUsage('acc-7')
      ok(res.ok === false && res.code === 'unknown', '200 + ' + label + ' → unknown', res)
    }
  }

  // ── S8：部分窗口缺失 → 仍为 ok（缺失的窗口 UI 显示「暂无数据」）；detail 正常 → detail=true ──
  console.log('')
  console.log('S8 部分窗口缺失仍为 ok')
  {
    globalThis.__creds = { 'acc-8.apiKey': 'k8' }
    usageRoute = () => ({
      status: 200,
      body: { usage: { rolling: { status: 'ok', percent: 5, resetsAt: '2026-09-27T13:50:34.916Z' } } }
    })
    const res = await refreshOpenCodeUsage('acc-8')
    ok(res.ok === true, '只有 rolling → ok=true', res)
    const w = res.ok ? res.data.windows : {}
    eq(w.weekly, undefined, 'weekly 缺失')
    eq(w.monthly, undefined, 'monthly 缺失')
    eq(w.rolling && w.rolling.usedPercent, 5, 'rolling 正常解析')
    eq(res.ok && res.data.sourcesAvailable.detail, true, 'detail 正常 → sourcesAvailable.detail=true')
  }

  // ── S9：CSV 解析矩阵（标准 / LF 兼容 / 列数不足跳过 / 表头不符 null / 数值缺省 0 / day 解析）──
  console.log('')
  console.log('S9 CSV 解析矩阵（表头防回归锚）')
  {
    // 表头防回归锚：14 列逐字（与实测一致；opencode.ts 常量漂移时这里必红）
    eq(CSV_HEADER.split(',').length, 14, '实测表头 14 列（防回归锚）')
    const rows = parseUsageExportCsv(CSV_STANDARD)
    ok(rows !== null && rows.length === 2, '标准 14 列表头 + 2 行 → 2 行', rows && rows.length)
    eq(rows && rows[0].day, '2026-09-27', 'day 保留')
    eq(rows && rows[0].dayTs, DAY_TS, 'day → Date.parse(day + T00:00:00Z)（UTC 零点）')
    eq(rows && rows[0].model, 'deepseek-v4.1-flash', 'model 解析')
    eq(rows && rows[0].cacheWrite5mTokens, 0, '数值字段 = 0 时解析为 0（非缺省）')
    eq(rows && rows[1].requests, 1, '第二行 requests')
    closeTo(rows && rows[1].cost, 3015 / 1e8, '第二行 cost 换算')

    // \n 兼容（服务端若改换行符不炸）
    const lfRows = parseUsageExportCsv([CSV_HEADER, CSV_ROW_1].join(LF))
    ok(lfRows !== null && lfRows.length === 1, '兼容 LF 换行', lfRows && lfRows.length)
    eq(lfRows && lfRows[0].requests, 298, 'LF 形态字段照常解析')

    // 列数不足行跳过（其余行保留）
    const shortRow = '2026-09-27,service_account,svcacct_x,Legacy: user@x.com,opencode-go,deepseek-v4.1-flash,298'
    const skipRows = parseUsageExportCsv([CSV_HEADER, CSV_ROW_1, shortRow, CSV_ROW_2].join(CRLF) + CRLF)
    ok(skipRows !== null && skipRows.length === 2, '列数不足行跳过（其余行保留）', skipRows && skipRows.length)

    // 多余列行跳过（字段内嵌逗号 → 字段错位；错位后是脏数据，不猜）
    const extraRow = '2026-09-27,service_account,svcacct_x,Doe, John,opencode-go,deepseek-v4.1-flash,298,1418794,341157,35582464,0,0,52426066,2026-09-27T10:27:54.000Z'
    const extraRows = parseUsageExportCsv([CSV_HEADER, CSV_ROW_1, extraRow, CSV_ROW_2].join(CRLF) + CRLF)
    ok(extraRows !== null && extraRows.length === 2, '多余列（内嵌逗号）行跳过（其余行保留）', extraRows && extraRows.length)

    // BOM 前缀表头兼容（服务端若带 BOM 不炸）
    const bomRows = parseUsageExportCsv(String.fromCharCode(0xfeff) + CSV_HEADER + CRLF + CSV_ROW_1)
    ok(bomRows !== null && bomRows.length === 1, 'BOM 前缀表头兼容', bomRows && bomRows.length)

    // 表头不符 → null（结构不识别 → 区块级降级）
    eq(parseUsageExportCsv(CSV_STANDARD.replace('cost_micro_cents', 'cost')), null, '表头列名不符 → null（降级，不猜）')
    eq(parseUsageExportCsv(CSV_HEADER.split(',').slice(0, 13).join(',') + CRLF + CSV_ROW_1), null, '表头列数不足 → null')
    eq(parseUsageExportCsv(CSV_HEADER.split(',').reverse().join(',') + CRLF + CSV_ROW_1), null, '表头列序不符 → null')
    eq(parseUsageExportCsv(''), null, '空文本 → null')
    eq(parseUsageExportCsv('some,random'), null, '任意文本 → null')

    // 仅表头（无数据行）→ 空数组（合法的「无明细」空态，不是结构错误）
    const headerOnly = parseUsageExportCsv(CSV_HEADER + CRLF)
    ok(Array.isArray(headerOnly) && headerOnly.length === 0, '仅表头 → 空数组（合法空态）')

    // 数值缺省 0：requests 字段清空 → 0
    const emptyReqRow = CSV_ROW_1.split(',').map((v, i) => (i === 6 ? '' : v)).join(',')
    const zeroRows = parseUsageExportCsv([CSV_HEADER, emptyReqRow].join(CRLF) + CRLF)
    eq(zeroRows && zeroRows[0].requests, 0, '数值字段空 → 缺省 0')

    // day 非法 → dayTs 省略（行保留，降级不丢行）
    const badDayRow = CSV_ROW_1.split(',').map((v, i) => (i === 0 ? 'not-a-day' : v)).join(',')
    const badDay = parseUsageExportCsv([CSV_HEADER, badDayRow].join(CRLF) + CRLF)
    ok(badDay && badDay[0].dayTs === undefined && badDay[0].day === 'not-a-day', 'day 非法 → dayTs 省略（行保留）')
  }

  // ── S10：聚合（多行按模型 SUM、成本降序、空输入）──
  console.log('')
  console.log('S10 按模型聚合（SUM + 成本降序）')
  {
    const rows = parseUsageExportCsv(
      [CSV_HEADER, CSV_ROW_1, CSV_ROW_2, CSV_ROW_1.replace('2026-09-27', '2026-09-26')].join(CRLF) + CRLF
    )
    const agg = aggregateExportRows(rows)
    eq(agg.length, 2, '多行按模型聚合 → 2 行（同日不同天同模型合并）')
    eq(agg[0].model, 'deepseek-v4.1-flash', '成本降序：v4.1 在前')
    eq(agg[0].requests, 596, '同模型跨天 SUM：requests 298 × 2')
    eq(agg[0].tokensIn, 1418794 * 2, 'tokensIn SUM')
    eq(agg[0].tokensTotal, ROW1_TOKENS_TOTAL * 2, 'tokensTotal SUM')
    closeTo(agg[0].cost, ROW1_COST * 2, 'cost SUM（跨天相加）')
    eq(agg[1].model, 'deepseek-v4-flash', '次位为 deepseek-v4-flash')
    eq(agg[1].requests, 1, '单行模型原值')
    eq(aggregateExportRows([]).length, 0, '空输入 → 空数组')
  }

  // ── S11：detail 403 → ok + detail=false（区块级降级；三卡照常）──
  console.log('')
  console.log('S11 detail 403 → 区块级降级（ok + detail=false）')
  {
    globalThis.__creds = { 'acc-11.apiKey': 'k11' }
    usageRoute = liveShapeRoute
    detailRoute = () => ({ status: 403, body: null })
    resetRequests()
    resetPersist()
    const res = await refreshOpenCodeUsage('acc-11')
    ok(res.ok === true, 'windows 200 + detail 403 → 整体 ok（不 session_expired）', res)
    eq(res.ok && res.data.sourcesAvailable.windows, true, 'windows=true（三卡照常）')
    eq(res.ok && res.data.sourcesAvailable.detail, false, 'detail=false')
    ok(res.ok && res.data.models === undefined, 'detail 失败 → models 缺省', res.ok ? res.data.models : res)
    ok(res.ok && res.data.modelsCoverage === undefined, 'detail 失败 → modelsCoverage 缺省')
    eq(res.persisted, 0, 'detail 失败 → persisted=0')
    eq(globalThis.__persistCalls.length, 0, '未调用落库')
    eq(requests.length, 2, '两请求都已发出（windows 先行，detail 降级不中断流程）')
    ok(res.ok && res.data.windows.rolling !== undefined, '窗口数据仍完整返回', res.ok ? res.data.windows : res)
  }

  // ── S12：detail 网络失败 → ok + detail=false ──
  console.log('')
  console.log('S12 detail 网络失败 → ok + detail=false')
  {
    globalThis.__creds = { 'acc-12.apiKey': 'k12' }
    usageRoute = liveShapeRoute
    rejectDetail = true
    resetRequests()
    resetPersist()
    const res = await refreshOpenCodeUsage('acc-12')
    rejectDetail = false
    ok(res.ok === true, 'detail 抛错 → 整体仍 ok', res)
    eq(res.ok && res.data.sourcesAvailable.detail, false, 'detail=false')
    eq(res.persisted, 0, 'persisted=0')
    eq(globalThis.__persistCalls.length, 0, '未调用落库')
  }

  // ── S13：detail CSV 不识别 → ok + detail=false ──
  console.log('')
  console.log('S13 CSV 结构不识别 → ok + detail=false')
  {
    globalThis.__creds = { 'acc-13.apiKey': 'k13' }
    usageRoute = liveShapeRoute
    detailRoute = () => ({ status: 200, text: 'unexpected,format' + CRLF + 'foo,bar' + CRLF })
    const res = await refreshOpenCodeUsage('acc-13')
    ok(res.ok === true, 'CSV 不识别 → 整体仍 ok', res)
    eq(res.ok && res.data.sourcesAvailable.detail, false, 'detail=false')
    ok(res.ok && res.data.models === undefined, 'models 缺省')
    eq(res.persisted, 0, 'persisted=0')
  }

  // ── S14：detail 200 但仅表头（无数据行）→ detail=true + models 缺省（合法空态）──
  console.log('')
  console.log('S14 detail 空数据（仅表头）→ detail=true')
  {
    globalThis.__creds = { 'acc-14.apiKey': 'k14' }
    usageRoute = liveShapeRoute
    detailRoute = () => ({ status: 200, text: CSV_HEADER + CRLF })
    resetPersist()
    const res = await refreshOpenCodeUsage('acc-14')
    ok(res.ok === true, 'ok=true', res)
    eq(res.ok && res.data.sourcesAvailable.detail, true, 'detail=true（CSV 已识别，只是无数据）')
    ok(res.ok && res.data.models === undefined, 'models 缺省（无数据行）')
    eq(res.persisted, 0, 'persisted=0')
    eq(globalThis.__persistCalls.length, 0, '无数据行 → 不落库')
  }

  // ── S15：detail 非 200（500）→ ok + detail=false ──
  console.log('')
  console.log('S15 detail 非 200 → ok + detail=false')
  {
    globalThis.__creds = { 'acc-15.apiKey': 'k15' }
    usageRoute = liveShapeRoute
    detailRoute = () => ({ status: 500, body: null })
    const res = await refreshOpenCodeUsage('acc-15')
    ok(res.ok === true, 'detail 500 → 整体仍 ok', res)
    eq(res.ok && res.data.sourcesAvailable.detail, false, 'detail=false')
    eq(res.persisted, 0, 'persisted=0')
  }

  console.log('')
  console.log(`${pass} 通过，${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
