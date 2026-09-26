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
//
// 2026-09-26 扩充（MiMo 对齐真实口径）：
//   - 订阅状态/到期来自 /tokenPlan/detail（planCode/currentPeriodEnd/expired/enableAutoRenew）；
//     原 /tokenPlan/subscription/status 为空壳端点（{code:0} 无 data），已弃用——请求不应再发。
//   - 当月明细双通道：/usage/detail/list（按量，含金额）+ /usage/token-plan/list（套餐，无金额），
//     按「日期 × 模型」合并；套餐行成本缺省（UI 显示 "—"），汇总成本仅含按量金额。
//   - Token Plan 无 5h/7d 滚动窗口：解析层不产出 fiveHour/weekly；monthly.usedPercent
//     按 used/limit 重算（服务端 percent 量纲不可信）、resetAt = 订阅到期时刻。
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
  if (method === 'POST' && url.includes('/usage/token-plan/list')) {
    // 套餐通道（官方控制台「套餐用量」页）：行无金额；含一行与按量同 (日期, 模型)（验证合并）
    // 与一行纯套餐（验证 cost 缺省）
    return {
      status: 200,
      body: {
        code: 0,
        data: [
          { date: '2026-09-26', model: 'mimo-v2.6-flash', inputHitToken: 50, inputMissToken: 50, outputToken: 100, totalToken: 200, requestCount: 3 },
          { date: '2026-09-25', model: 'mimo-v2.5', inputHitToken: 100, inputMissToken: 0, outputToken: 50, totalToken: 150, requestCount: 1 }
        ]
      }
    }
  }
  if (method === 'POST' && url.includes('/usage/detail/list')) {
    return {
      status: 200,
      body: {
        code: 0,
        data: [
          { date: '2026-09-26', model: 'mimo-v2.6-flash', currency: 'CNY', inputHitToken: 20, inputMissToken: 30, outputToken: 90, totalToken: 140, requestCount: 2, consumedAmount: 3 }
        ]
      }
    }
  }
  if (url.includes('/balance')) return { status: 200, body: { code: 0, data: { currency: 'CNY', balance: 129.25, cashBalance: 26.31, giftBalance: 102.93 } } }
  if (url.includes('/tokenPlan/usage')) {
    return {
      status: 200,
      body: {
        code: 0,
        data: {
          usage: {
            // 服务端 percent 量纲实测不可信（0.01 与 used/limit 不成比例）：解析层按 used/limit 重算
            percent: 0.01,
            items: [
              { name: 'plan_total_token', used: 5e8, limit: 1e9, percent: 0.01 },
              { name: 'compensation_total_token', used: 0, limit: 0, percent: 0 }
            ]
          }
        }
      }
    }
  }
  if (url.includes('/tokenPlan/detail')) {
    return {
      status: 200,
      body: {
        code: 0,
        data: {
          planCode: 'standard:year',
          planName: 'Standard',
          currentPeriodEnd: '2027-09-22 23:59:59',
          expired: false,
          enableAutoRenew: true,
          hasAutoRenewSubscribed: true
        }
      }
    }
  }
  return { status: 200, body: { code: 0, data: {} } }
}

let refreshMimoUsage = null

async function main() {
  const mod = await buildBundle()
  refreshMimoUsage = mod.refreshMimoUsage
  installFetch()

  // ── S1：真实形态凭证（ph 带引号，含 / + == 特殊字符）→ POST 必带去引号编码的 query ──
  console.log('\nS1 POST 端点带 ph query + 双通道/订阅解析（真实响应形态）')
  {
    globalThis.__creds = {
      'acc-1': 'api-platform_serviceToken="tok123=="; userId=1221469480; api-platform_slh="slh456=="; api-platform_ph="wZksK9y0Ho/f+n1ukVgddA=="'
    }
    routeHandler = happyRoute
    const res = await refreshMimoUsage('acc-1')
    ok(res.ok === true, '全 200 时 ok=true（修复前 POST 恒 401 → session_expired）', res)
    const post = reqOf('POST', '/usage/detail/list')
    const planPost = reqOf('POST', '/usage/token-plan/list')
    const get = reqOf('GET', '/balance')
    eq(
      post && post.url,
      `${API}/usage/detail/list?api-platform_ph=wZksK9y0Ho%2Ff%2Bn1ukVgddA%3D%3D`,
      'POST URL 带去引号 + URL 编码的 ph（与官网前端实测形态一致）'
    )
    eq(
      planPost && planPost.url,
      `${API}/usage/token-plan/list?api-platform_ph=wZksK9y0Ho%2Ff%2Bn1ukVgddA%3D%3D`,
      '套餐明细 POST 同样带 ph'
    )
    eq(get && get.url, `${API}/balance`, 'GET 不带 ph query')
    ok(requests.every((r) => r.method === 'POST' || !r.url.includes('api-platform_ph')), '所有 GET 请求均无 ph')
    ok(!requests.some((r) => r.url.includes('/tokenPlan/subscription/status')), '空壳端点 /tokenPlan/subscription/status 不再请求')

    // 解析链路：双通道合并（同 (日期, 模型) 相加；套餐行无金额）
    ok(res.ok && res.data.sourcesAvailable.detailList === true, 'sourcesAvailable.detailList=true（双通道明细解析生效）', res.ok ? res.data.sourcesAvailable : res)
    const rows = res.ok ? res.data.monthlyModels.rows : []
    const flash = rows.find((r) => r.model === 'mimo-v2.6-flash')
    const planOnly = rows.find((r) => r.model === 'mimo-v2.5')
    ok(rows.length === 2, '模型明细 2 行（合并行 flash + 纯套餐行 v2.5）', rows)
    ok(flash && flash.requests === 5 && flash.tokensTotal === 340, '同 (日期, 模型) 双通道相加：请求 2+3 / tokens 140+200', flash)
    ok(flash && flash.cost !== undefined && Math.abs(flash.cost * 7.2 - 3) < 1e-6, '成本 = 按量金额（3 元 → USD 归一）', flash)
    ok(!planOnly || planOnly.cost === undefined, '纯套餐行成本缺省（UI 显示 "—"，不伪造金额）', planOnly)
    ok(res.ok && res.data.summary.totalCount === 6, '汇总 = 合并后总量（flash 2+3 + 纯套餐行 1）', res.ok ? res.data.summary : res)
    ok(
      res.ok && res.data.summary.totalCost !== undefined && Math.abs(res.data.summary.totalCost * 7.2 - 3) < 1e-6,
      '汇总按量成本仅含金额通道',
      res.ok ? res.data.summary : res
    )

    // 订阅状态：来自 /tokenPlan/detail（planCode / currentPeriodEnd / expired / enableAutoRenew）
    const sub = res.ok ? res.data.subscription : null
    ok(sub && sub.planId === 'standard:year', '订阅 planId = standard:year', sub)
    ok(sub && sub.planName === 'Standard', '订阅 planName = Standard', sub)
    ok(sub && sub.expired === false, '订阅状态：expired=false（生效中）', sub)
    ok(sub && sub.autoRenew === true, '自动续费 enableAutoRenew=true 解析', sub)
    ok(sub && typeof sub.expireAtTs === 'number' && sub.expireAtTs > Date.now() / 1000, '到期时间 currentPeriodEnd 解析为未来 epoch', sub)

    // Token Plan：percent 按 used/limit 重算（服务端量纲不可信）、limit=0 补偿条目过滤
    const tp = res.ok ? res.data.tokenPlan : null
    ok(tp && tp.percent === 50, 'tokenPlan.percent = used/limit × 100（不信服务端 percent）', tp)
    ok(tp && tp.items.length === 1, 'limit=0 的补偿积分条目不产出（与官方前端一致）', tp && tp.items)

    // 额度窗口：MiMo 无 5h/7d；monthly.resetAt = 订阅到期时刻
    const win = res.ok ? res.data.windows : null
    ok(win && win.fiveHour === undefined && win.weekly === undefined, '不产出 5h/7d 窗口（MiMo 无该口径）', win)
    ok(win && win.monthly !== undefined && win.monthly.usedPercent === 50, '月度窗口 usedPercent 与套餐口径一致', win)
    ok(sub != null && win != null && win.monthly.resetAt === sub.expireAtTs, '月度窗口 resetAt = 订阅到期时刻', { win, sub })
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
