// MiMo 刷新请求形态回归：POST 端点必须带 ?api-platform_ph=<cookie 去引号值，URL 编码>
// 用法：npm run test:mimo-request
//
// 背景（真实报障，2026-09-26）：云监控 MiMo 面板「刚登录就提示登录已过期（Cookie 约 24h 有效）」。
// 根因：平台网关对 POST /usage/detail/list 额外要求 query 带 api-platform_ph
// （值 = 同名 cookie 去首尾双引号后 URL 编码，官网前端 29618 请求层同款做法）；
// 缺失或带引号一律判未登录 → 401 + loginUrl + 服务端清登录 cookie。
// 该 401 命中 refreshMimoUsage 的「任一端点 401/403 → session_expired」判定，
// 于是每次刷新都误报「登录已过期」——与是否刚登录无关（POST 恒 401）。
// 实证：真实凭证下 5 个 GET 全 200、POST 无 ph 401 / ph 带引号 401 / ph 去引号 200；
//       官网控制台自身请求形态 POST .../usage/detail/list?api-platform_ph=wZksK9y0Ho%2Ff%2Bn1ukVgddA%3D%3D → 200。
//
// 本测试用 stub fetchProxy 驱动**真实** refreshMimoUsage（esbuild 打包 + electron /
// key-store / usageAccumulator stub，不触网），断言 URL 构造与错误语义，防止 ph query 被「简化」掉。
const path = require('path')
const esbuild = require('esbuild')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, '.hermes', 'defense-test', 'mimo-request.cjs')
const API = 'https://platform.xiaomimimo.com/api/v1'

const STUBS = {
  electron: `module.exports = {
  BrowserWindow: class { constructor(){ this.webContents = { on(){} } } on(){} loadURL(){ return Promise.resolve() } close(){} focus(){} isDestroyed(){ return true } },
  session: { fromPartition: () => ({ cookies: { get: async () => [] }, clearStorageData: async () => {} }) }
}`,
  fetchProxy: `module.exports = { fetchProxy: async (url, opts) => globalThis.__fetchImpl(url, opts) }`,
  keyStore: `module.exports = {
  getUsageCredential: (k) => (globalThis.__creds || {})[k],
  saveUsageCredential: () => {},
  removeUsageCredential: () => {}
}`,
  usageAccumulator: `module.exports = { persistUsageRecords: () => 0 }`
}

async function buildBundle() {
  await esbuild.build({
    stdin: {
      contents: `export { refreshMimoUsage } from './src/main/monitoring/mimo'`,
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
            [/^electron$/, 'electron'],
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

// ── 假请求层：记录 URL/方法，按路由返回可编程响应 ──
const requests = []
let routeHandler = () => ({ status: 200, body: { code: 0, data: {} } })

function installFetch() {
  requests.length = 0
  globalThis.__fetchImpl = async (url, opts) => {
    const method = (opts && opts.method) || 'GET'
    requests.push({ url, method, body: opts && opts.body })
    const r = routeHandler(url, method)
    return { status: r.status, json: async () => r.body }
  }
}

function reqOf(method, pathFragment) {
  return requests.find((r) => r.method === method && r.url.includes(pathFragment))
}

/** 场景间清空请求记录（否则 find 会命中上一场景遗留的同名请求） */
function resetRequests() {
  requests.length = 0
}

/** 全 200 的默认路由（含真实形态的响应数据） */
function happyRoute(url, method) {
  if (method === 'POST' && url.includes('/usage/detail/list')) {
    return {
      status: 200,
      body: {
        code: 0,
        data: [
          { date: '2026-09-26', model: 'mimo-v2.6-flash', currency: 'CNY', totalToken: 100, tokensIn: 10, tokensOut: 90, requestCount: 2, consumedAmount: 3 }
        ]
      }
    }
  }
  if (url.includes('/balance')) return { status: 200, body: { code: 0, data: { currency: 'CNY', balance: 129.25, cashBalance: 26.31, giftBalance: 102.93 } } }
  if (url.includes('/tokenPlan/usage')) return { status: 200, body: { code: 0, data: { usage: { percent: 10, items: [{ name: 'standard', used: 1, limit: 10 }] } } } }
  if (url.includes('/tokenPlan/detail')) return { status: 200, body: { code: 0, data: { planId: 'pro' } } }
  if (url.includes('/tokenPlan/subscription/status')) return { status: 200, body: { code: 0, data: {} } }
  if (url.includes('/usage')) return { status: 200, body: { code: 0, data: {} } }
  return { status: 200, body: { code: 0, data: {} } }
}

let refreshMimoUsage = null

async function main() {
  const mod = await buildBundle()
  refreshMimoUsage = mod.refreshMimoUsage
  installFetch()

  // ── S1：真实形态凭证（ph 带引号，含 / + == 特殊字符）→ POST 必带去引号编码的 query ──
  console.log('\nS1 POST 端点带 ph query（真实凭证形态）')
  {
    globalThis.__creds = {
      'acc-1': 'api-platform_serviceToken="tok123=="; userId=1221469480; api-platform_slh="slh456=="; api-platform_ph="wZksK9y0Ho/f+n1ukVgddA=="'
    }
    routeHandler = happyRoute
    const res = await refreshMimoUsage('acc-1')
    ok(res.ok === true, '全 200 时 ok=true（修复前 POST 恒 401 → session_expired）', res)
    const post = reqOf('POST', '/usage/detail/list')
    const get = reqOf('GET', '/balance')
    eq(
      post && post.url,
      `${API}/usage/detail/list?api-platform_ph=wZksK9y0Ho%2Ff%2Bn1ukVgddA%3D%3D`,
      'POST URL 带去引号 + URL 编码的 ph（与官网前端实测形态一致）'
    )
    eq(get && get.url, `${API}/balance`, 'GET 不带 ph query')
    ok(requests.every((r) => r.method === 'POST' || !r.url.includes('api-platform_ph')), '所有 GET 请求均无 ph')
    // 解析链路仍生效
    ok(res.ok && res.data.sourcesAvailable.detailList === true, 'sourcesAvailable.detailList=true（POST 明细解析生效）', res.ok ? res.data.sourcesAvailable : res)
    ok(res.ok && res.data.monthlyModels.rows.length === 1 && res.data.monthlyModels.rows[0].model === 'mimo-v2.6-flash', '模型明细行解析正确')
    ok(res.ok && res.data.summary.totalCount === 2, '汇总 requestCount 解析正确')
  }

  // ── S2：ph 无引号（Cookie 头形态差异）→ 同样正确取值编码 ──
  console.log('\nS2 ph 值不带引号时同样正确')
  {
    resetRequests()
    globalThis.__creds = { 'acc-2': 'userId=1; api-platform_ph=plain==; api-platform_serviceToken=t' }
    const res = await refreshMimoUsage('acc-2')
    const post = reqOf('POST', '/usage/detail/list')
    eq(post && post.url, `${API}/usage/detail/list?api-platform_ph=plain%3D%3D`, '无引号 ph 也去成对解析并编码（== → %3D%3D）')
    ok(res.ok === true, '仍正常刷新')
  }

  // ── S3：凭证缺 ph（旧凭证/异常）→ 优雅退化为不带 query，不抛错 ──
  console.log('\nS3 凭证缺 ph 时优雅退化')
  {
    resetRequests()
    globalThis.__creds = { 'acc-3': 'userId=1; api-platform_serviceToken=t' }
    const res = await refreshMimoUsage('acc-3')
    const post = reqOf('POST', '/usage/detail/list')
    eq(post && post.url, `${API}/usage/detail/list`, '缺 ph 时 POST 不带 query（不抛错、不中断刷新）')
    ok(res.ok === true, '仍按各端点结果正常返回')
  }

  // ── S4：POST 401（ph 缺失/失效的真实表现）→ 错误语义保持 session_expired ──
  console.log('\nS4 POST 401 的判定语义保持（真实过期仍提示重新登录）')
  {
    globalThis.__creds = { 'acc-4': 'userId=1; api-platform_serviceToken=t; api-platform_ph="p=="' }
    routeHandler = (url, method) => {
      if (method === 'POST' && url.includes('/usage/detail/list')) return { status: 401, body: { code: 401, loginUrl: 'https://account.xiaomi.com/pass/serviceLogin?callback=...' } }
      return happyRoute(url, method)
    }
    const res = await refreshMimoUsage('acc-4')
    ok(res.ok === false && res.code === 'session_expired', '任一端点 401 → session_expired（UI 提示重新登录）', res)
  }

  // ── S5：全端点网络失败 → network；无凭证 → not_authenticated ──
  console.log('\nS5 错误分层不回归')
  {
    globalThis.__creds = { 'acc-5': 'userId=1; api-platform_ph="p=="' }
    routeHandler = () => ({ status: 0, body: null })
    const res = await refreshMimoUsage('acc-5')
    ok(res.ok === false && res.code === 'network', '全端点失败 → network', res)

    globalThis.__creds = {}
    const res2 = await refreshMimoUsage('acc-6')
    ok(res2.ok === false && res2.code === 'not_authenticated', '无凭证 → not_authenticated', res2)
  }

  console.log(`\n${pass} 通过，${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
