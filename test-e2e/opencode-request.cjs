// OpenCode Go 刷新请求形态回归：GET /zen/go/v1/usage + Bearer 头 + 三窗口解析 + 错误码分层
// 用法：npm run test:opencode-request
//
// 背景（设计文档 2026-09-27 §2 实测）：
//   GET https://opencode.ai/zen/go/v1/usage（Authorization: Bearer <Provider API Key>）→ 200，
//   响应 { usage: { rolling / weekly / monthly: { status, percent, resetsAt(ISO) } } }；
//   percent = 已用百分比（0-100 整数）；响应不含金额（面板按官方 $60 档基准折算展示）；
//   无效 key → 401；HEAD 请求恒 401 → 必须 GET。
//
// 本测试用 stub fetchProxy + stub keyStore 驱动**真实** refreshOpenCodeUsage（esbuild 打包，不触网；
// opencode.ts 不 import electron / usageAccumulator，故只需这两个 stub），断言：
//   URL 与 Bearer 头、实测响应形态三窗口解析、resetsAt 多形态归一（ISO / epoch 秒 / epoch 毫秒 / 缺失 / 非法）、
//   percent 越界夹取、错误码分层（无 key / 401 / 403 / 500 / reject / 结构不识别）与部分窗口缺失语义。
const path = require('path')
const esbuild = require('esbuild')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, '.hermes', 'defense-test', 'opencode-request.cjs')
const API = 'https://opencode.ai/zen/go/v1/usage'

const STUBS = {
  fetchProxy: `module.exports = { fetchProxy: async (url, opts) => globalThis.__fetchImpl(url, opts) }`,
  keyStore: `module.exports = {
  getUsageCredential: (k) => (globalThis.__creds || {})[k],
  saveUsageCredential: () => {},
  removeUsageCredential: () => {}
}`
}

async function buildBundle() {
  await esbuild.build({
    stdin: {
      contents: `export { refreshOpenCodeUsage, usageApiKeyKey } from './src/main/monitoring/opencode'`,
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
            [/store\/key-store$/, 'keyStore']
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

function epochSec(iso) {
  return Math.round(Date.parse(iso) / 1000)
}

// ── 假请求层：记录 URL/headers，按路由返回可编程响应（rejectMode = fetch 直接抛错）──
const requests = []
let routeHandler = () => ({ status: 200, body: {} })
let rejectMode = false

function installFetch() {
  requests.length = 0
  globalThis.__fetchImpl = async (url, opts) => {
    requests.push({ url, headers: (opts && opts.headers) || {}, method: (opts && opts.method) || 'GET' })
    if (rejectMode) throw new Error('connect ETIMEDOUT')
    const r = routeHandler(url)
    return { status: r.status, json: async () => r.body }
  }
}

/** 场景间清空请求记录（否则 find/索引会命中上一场景遗留的请求） */
function resetRequests() {
  requests.length = 0
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

async function main() {
  const mod = await buildBundle()
  refreshOpenCodeUsage = mod.refreshOpenCodeUsage
  usageApiKeyKey = mod.usageApiKeyKey
  installFetch()

  // ── S1：实测响应形态 —— URL / Bearer 头 / 三窗口解析（ISO resetsAt → epoch 秒）──
  console.log('\nS1 实测响应形态：URL + Bearer 头 + 三窗口解析')
  {
    globalThis.__creds = { 'acc-1.apiKey': 'oc-go-key-1' }
    rejectMode = false
    routeHandler = liveShapeRoute
    const res = await refreshOpenCodeUsage('acc-1')
    ok(res.ok === true, '200 + 实测结构 → ok=true', res)
    eq(requests.length, 1, '只发 1 个请求（单端点）')
    eq(requests[0] && requests[0].url, API, 'URL = https://opencode.ai/zen/go/v1/usage')
    eq(requests[0] && requests[0].headers.Authorization, 'Bearer oc-go-key-1', 'Authorization: Bearer <key>')
    eq(usageApiKeyKey && usageApiKeyKey('acc-1'), 'acc-1.apiKey', '凭据键约定 = <accountId>.apiKey（与 Command Code 一致）')
    eq(requests[0] && requests[0].headers.Accept, 'application/json', 'Accept: application/json')
    eq(requests[0] && requests[0].headers['User-Agent'], 'moa-desktop', 'User-Agent: moa-desktop')
    eq(requests[0] && requests[0].method, 'GET', 'GET 请求（HEAD 恒 401，必须 GET）')
    ok(res.ok && typeof res.data.fetchedAt === 'number', 'fetchedAt 为数值（epoch 毫秒）', res.ok ? res.data : res)
    const w = res.ok ? res.data.windows : {}
    eq(w.rolling && w.rolling.status, 'ok', 'rolling.status 原样保留')
    eq(w.rolling && w.rolling.usedPercent, 0, 'rolling.usedPercent = 0')
    eq(w.rolling && w.rolling.resetAt, epochSec('2026-09-27T13:50:34.916Z'), 'rolling.resetsAt ISO → epoch 秒')
    eq(w.weekly && w.weekly.resetAt, epochSec('2026-09-28T00:00:00.000Z'), 'weekly.resetsAt ISO → epoch 秒')
    eq(w.monthly && w.monthly.resetAt, epochSec('2026-10-27T03:11:54.000Z'), 'monthly.resetsAt ISO → epoch 秒')
  }

  // ── S2：非零百分比 + resetsAt 多形态（ISO / epoch 秒 / 缺失）──
  console.log('\nS2 非零百分比与 resetsAt 多形态')
  {
    globalThis.__creds = { 'acc-2.apiKey': 'k2' }
    routeHandler = () => ({
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
  console.log('\nS3 resetsAt 非法/毫秒形态、percent 夹取、status 原样')
  {
    globalThis.__creds = { 'acc-3.apiKey': 'k3' }
    routeHandler = () => ({
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
  console.log('\nS4 无 key 时不发请求')
  {
    globalThis.__creds = {}
    resetRequests()
    const res = await refreshOpenCodeUsage('acc-4')
    ok(res.ok === false && res.code === 'not_authenticated', '无 key → not_authenticated', res)
    eq(requests.length, 0, '未发任何请求')
  }

  // ── S5：401 / 403 → session_expired；500 → unknown（error 带 HTTP n）──
  console.log('\nS5 HTTP 状态错误分层')
  {
    globalThis.__creds = { 'acc-5.apiKey': 'k5' }
    routeHandler = () => ({ status: 401, body: { type: 'error', error: { type: 'AuthError', message: 'Unauthorized' } } })
    const r401 = await refreshOpenCodeUsage('acc-5')
    ok(r401.ok === false && r401.code === 'session_expired', '401 → session_expired（API Key 无效/过期）', r401)

    routeHandler = () => ({ status: 403, body: null })
    const r403 = await refreshOpenCodeUsage('acc-5')
    ok(r403.ok === false && r403.code === 'session_expired', '403 → session_expired', r403)

    routeHandler = () => ({ status: 500, body: null })
    const r500 = await refreshOpenCodeUsage('acc-5')
    ok(r500.ok === false && r500.code === 'unknown', '500 → unknown', r500)
    ok(r500.ok === false && typeof r500.error === 'string' && r500.error.includes('HTTP 500'), 'error 带 HTTP 500', r500)
  }

  // ── S6：fetch reject（网络异常）→ network ──
  console.log('\nS6 网络异常 → network')
  {
    globalThis.__creds = { 'acc-6.apiKey': 'k6' }
    rejectMode = true
    const res = await refreshOpenCodeUsage('acc-6')
    rejectMode = false
    ok(res.ok === false && res.code === 'network', 'fetch 抛错 → network', res)
  }

  // ── S7：200 但结构不识别（{} / {usage:null} / body null / 窗口全非对象）→ unknown ──
  console.log('\nS7 结构不识别 → unknown')
  {
    globalThis.__creds = { 'acc-7.apiKey': 'k7' }
    const cases = [
      ['{}', {}],
      ['{usage:null}', { usage: null }],
      ['body null', null],
      ['窗口全非对象', { usage: { rolling: 5, weekly: 'x', monthly: null } }]
    ]
    for (const [label, body] of cases) {
      routeHandler = () => ({ status: 200, body })
      const res = await refreshOpenCodeUsage('acc-7')
      ok(res.ok === false && res.code === 'unknown', `200 + ${label} → unknown`, res)
    }
  }

  // ── S8：部分窗口缺失 → 仍为 ok（缺失的窗口 UI 显示「暂无数据」）──
  console.log('\nS8 部分窗口缺失仍为 ok')
  {
    globalThis.__creds = { 'acc-8.apiKey': 'k8' }
    routeHandler = () => ({
      status: 200,
      body: { usage: { rolling: { status: 'ok', percent: 5, resetsAt: '2026-09-27T13:50:34.916Z' } } }
    })
    const res = await refreshOpenCodeUsage('acc-8')
    ok(res.ok === true, '只有 rolling → ok=true', res)
    const w = res.ok ? res.data.windows : {}
    eq(w.weekly, undefined, 'weekly 缺失')
    eq(w.monthly, undefined, 'monthly 缺失')
    eq(w.rolling && w.rolling.usedPercent, 5, 'rolling 正常解析')
  }

  console.log(`\n${pass} 通过，${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
