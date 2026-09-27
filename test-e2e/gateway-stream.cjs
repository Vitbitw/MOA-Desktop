// 冒烟测试：src/main/gateway/server.ts 网关改造（T4）——
// MoA 真流式对外转发（真增量帧 + finish/[DONE]、非一次性到达）、UI 事件广播全序列
// （roundStart → subUpdate（含 running）→ aggStart → aggChunk（含 false / done:true）→ roundDone）、
// 客户端断开 abort 链路（引擎中止、聚合不发起、roundDone aborted:true、记账标注）、
// 透传兜底旁路直播（未配置子模型；逐字节透传，含畸形流）、聚合 fallback 无缝接续 / 已开流收流结束、非流式客户端 JSON 现状、
// MoA 流式 SSE 响应头（T4.1）+ 引擎失败未开流 502 JSON 保持；
// 网关出口模式（gatewayDirectModel 单模型直通：跳过席位/聚合与请求模型、/health 口径、清除与配置失效回落聚合）。
// 用法：node test-e2e/gateway-stream.cjs
// 加载方式：esbuild bundle（stdin 聚合入口：server / uiBridge / moaConfig 共享同一模块实例）+
//   plugin stub：electron、../db/database、../config/appSettings、../providers/providerManager、
//   ../local/fetchProxy（走全局 fetch）。起真实网关（createGatewayServer + app.listen 随机端口）
//   与 node:http mock 上游（按 body.model 分派脚本）；initUiBridge 注入广播收集器。
// 返回码：全部通过 0，有失败 1
const path = require('path')
const http = require('http')

const ROOT = path.resolve(__dirname, '..')

// ── 断言与工具 ──

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** 轮询等待条件成立（超时返回最终值） */
const waitFor = async (fn, ms) => {
  const t0 = Date.now()
  while (!fn() && Date.now() - t0 < ms) await sleep(10)
  return fn()
}

// ── 测试控制面（stub 与用例经 globalThis.__gwTest 通信；bundle 与测试同进程） ──

const gw = {
  providers: [],
  settings: {
    gateway: { enabled: true, host: '127.0.0.1', port: 0, maxConcurrency: 4, authEnabled: false, gatewayKey: '', recording: 'full', transparency: 'default' },
    pricing: {},
    probedPricing: [],
    network: { enabled: false, proxyUrl: '' }
  },
  dbLogs: [], // logGatewayRequest 落库记录（stub db.exec 捕获）
  broadcasts: [], // UI 广播（initUiBridge 注入的收集器）
  fetch: (url, init) => fetch(url, init)
}
gw.db = {
  exec(sql, params) { gw.dbLogs.push({ sql, params }) },
  query() { return [] },
  queryOne() { return null },
  init() {}
}
globalThis.__gwTest = gw

// ── 模块加载（esbuild bundle + plugin stub） ──

const STUBS = {
  electron: `export default {}
export const app = {}
export const BrowserWindow = class {}
export const ipcMain = { handle() {}, on() {} }
export const Menu = {}
export const clipboard = {}
export const safeStorage = {}
`,
  database: `export function getDatabase() { return globalThis.__gwTest.db }
`,
  appSettings: `export function readAppSettings() { return globalThis.__gwTest.settings }
export function updateRawAppSettings() { return globalThis.__gwTest.settings }
`,
  providerManager: `export function getAllProviders() { return globalThis.__gwTest.providers }
`,
  fetchProxy: `export function fetchProxy(url, init) { return globalThis.__gwTest.fetch(url, init) }
export function invalidateProxyCache() {}
`
}

async function loadGateway() {
  let esbuild
  try {
    esbuild = require('esbuild')
  } catch {
    throw new Error('缺少 esbuild（随 vite 安装）：请在项目根目录执行 npm i 后再跑本脚本')
  }
  const entry = [
    "export * as server from './src/main/gateway/server.ts'",
    "export * as uiBridge from './src/main/uiBridge.ts'",
    "export * as moaConfig from './src/main/moa/moaConfig.ts'"
  ].join('\n')
  const result = await esbuild.build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'ts', sourcefile: 'gateway-stream-entry.ts' },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'silent',
    external: ['express', 'cors'],
    plugins: [
      {
        name: 'stub-gateway-deps',
        setup(build) {
          const map = [
            [/(^|\/)electron$/, 'electron'],
            [/(^|\/)database$/, 'database'],
            [/(^|\/)appSettings$/, 'appSettings'],
            [/(^|\/)providerManager$/, 'providerManager'],
            [/(^|\/)fetchProxy$/, 'fetchProxy']
          ]
          for (const [filter, key] of map) {
            build.onResolve({ filter }, () => ({ path: key, namespace: 'gw-stub' }))
          }
          build.onLoad({ filter: /.*/, namespace: 'gw-stub' }, (args) => ({ contents: STUBS[args.path], loader: 'js' }))
        }
      }
    ]
  })
  const js = result.outputFiles[0].text
  const mod = { exports: {} }
  new Function('exports', 'module', 'require', js)(mod.exports, mod, require)
  return mod.exports
}

// ── mock 上游（node:http，按 body.model 分派脚本） ──

const mock = {
  requests: [], // { model, stream, t, body }
  scripts: new Map(), // model → { frames, gapMs, httpStatus, midFail, midFailDelayMs, usage, content, rawParts, holdOpen }
  sentStreams: [], // { model, bytes }：按请求顺序记录 mock 实际写往上游连接的全部字节（direct 逐字节比对基准）
  count(model) { return this.requests.filter((r) => r.model === model).length },
  /** 最近一次该 model 的请求体（含 messages/system 等，供提示词分叉断言） */
  lastBody(model) {
    const hit = this.requests.filter((r) => r.model === model).pop()
    return hit ? hit.body : null
  },
  /** 最近一次该 model 的流式上游字节（无记录时空 Buffer） */
  sentOf(model) {
    const hit = this.sentStreams.filter((s) => s.model === model).pop()
    return hit ? hit.bytes : Buffer.alloc(0)
  }
}

const sseFrame = (content) =>
  'data: ' + JSON.stringify({ id: 'mock-cmpl', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] }) + '\n\n'
const sseFinish = () =>
  'data: ' + JSON.stringify({ id: 'mock-cmpl', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n'
const sseUsage = (usage) =>
  'data: ' + JSON.stringify({ id: 'mock-cmpl', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens } }) + '\n\n'

async function mockHandle(body, res) {
  const model = String(body.model || '')
  mock.requests.push({ model, stream: body.stream === true, t: Date.now(), body })
  const script = mock.scripts.get(model)
  if (!script) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'no script for ' + model } }))
    return
  }
  if (script.httpStatus) {
    res.writeHead(script.httpStatus, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'mock http ' + script.httpStatus } }))
    return
  }
  if (body.stream !== true) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: 'mock-cmpl',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: script.content || '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: script.usage?.prompt_tokens || 0, completion_tokens: script.usage?.completion_tokens || 0 }
    }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  // 逐字节记录实际写往上游连接的字节（T4.1：direct 透传逐字节比对基准；字符串按 utf8、Buffer 原样）
  const sent = []
  const write = (part) => {
    sent.push(Buffer.isBuffer(part) ? part : Buffer.from(part, 'utf8'))
    res.write(part)
  }
  // rawParts：自含原样字节脚本（心跳注释/事件间空行/多字节切块/畸形行），与 frames 二选一
  if (script.rawParts) {
    for (const part of script.rawParts) {
      write(part)
      await sleep(script.gapMs || 10)
    }
    mock.sentStreams.push({ model, bytes: Buffer.concat(sent) })
    if (!script.holdOpen) res.end()
    return
  }
  for (const frame of script.frames || []) {
    write(sseFrame(frame))
    await sleep(script.gapMs || 10)
  }
  if (script.midFail) {
    await sleep(script.midFailDelayMs || 30)
    mock.sentStreams.push({ model, bytes: Buffer.concat(sent) })
    res.destroy() // 200 后流中途断开（无 [DONE]）
    return
  }
  write(sseFinish())
  if (script.usage) write(sseUsage(script.usage))
  write('data: [DONE]\n\n')
  mock.sentStreams.push({ model, bytes: Buffer.concat(sent) })
  if (!script.holdOpen) res.end()
}

// ── 网关客户端（node:http；可中途 destroy 模拟客户端断开） ──

function gatewayRequest(port, body, opts = {}) {
  return new Promise((resolve) => {
    const chunks = []
    let settled = false
    const done = (extra) => {
      if (settled) return
      settled = true
      resolve(Object.assign({ raw: chunks.map((c) => c.text).join(''), chunks }, extra))
    }
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        res.on('data', (d) => chunks.push({ t: Date.now(), text: d.toString('utf8'), buf: d }))
        res.on('end', () => done({ status: res.statusCode, headers: res.headers, ended: true }))
        res.on('close', () => done({ status: res.statusCode, headers: res.headers, closed: true }))
        res.on('error', () => done({ status: res.statusCode, error: true }))
      }
    )
    req.on('error', () => done({ error: true }))
    if (opts.destroyAfterMs) {
      setTimeout(() => {
        try { req.destroy() } catch { /* ignore */ }
      }, opts.destroyAfterMs)
    }
    req.end(JSON.stringify(body))
  })
}

// ── SSE / UI 事件解析 ──

const parseSseData = (raw) =>
  raw.split('\n\n').map((s) => s.trim()).filter(Boolean)
    .map((s) => (s.startsWith('data: ') ? s.slice(6) : null)).filter((s) => s !== null)
const jsonFrames = (raw) =>
  parseSseData(raw).filter((d) => d !== '[DONE]')
    .map((d) => { try { return JSON.parse(d) } catch { return null } }).filter((f) => f !== null)
const sseContent = (raw) => jsonFrames(raw).map((f) => f.choices?.[0]?.delta?.content || '').join('')
const finishCount = (raw) => jsonFrames(raw).filter((f) => f.choices?.[0]?.finish_reason === 'stop').length

const uiMark = () => gw.broadcasts.length
const uiSince = (mark) => gw.broadcasts.slice(mark)
const chanCount = (evts, channel) => evts.filter((e) => e.channel === channel).length
const roundIdOf = (evts) => evts[0]?.payload?.roundId

const SUB_MODELS = [
  { modelId: 'sub-a', providerId: 'prov-1', order: 0, role: 'critic' },
  { modelId: 'sub-b', providerId: 'prov-1', order: 1 }
]

// ── 用例 ──

;(async () => {
  const mod = await loadGateway()
  const gatewayMod = mod.server
  const uiBridge = mod.uiBridge
  const moaConfig = mod.moaConfig

  // UI 广播收集器（真实 uiBridge 经 initUiBridge 注入）
  uiBridge.initUiBridge((channel, payload) => {
    gw.broadcasts.push({ channel, payload, t: Date.now() })
  })

  console.log('\n[0] uiBridge 静默语义：发送器抛错不向外抛（窗口销毁竞态）')
  {
    uiBridge.initUiBridge(() => { throw new Error('window destroyed') })
    let threw = false
    try { uiBridge.broadcastToUi('gateway:probe', {}) } catch { threw = true }
    ok(!threw, 'broadcastToUi 发送失败静默（不抛错）')
    // 恢复收集器
    uiBridge.initUiBridge((channel, payload) => {
      gw.broadcasts.push({ channel, payload, t: Date.now() })
    })
  }

  const app = gatewayMod.createGatewayServer()
  const gwServer = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const GW_PORT = gwServer.address().port

  const mockServer = http.createServer((req, res) => {
    res.on('error', () => {}) // 客户端断开后的 write 错误忽略
    let raw = ''
    req.on('error', () => {})
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw || '{}') } catch { /* 非 JSON 请求体 */ }
      mockHandle(body, res).catch(() => { try { res.destroy() } catch { /* ignore */ } })
    })
  })
  mockServer.on('clientError', (err, socket) => { try { socket.destroy() } catch { /* ignore */ } })
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve))
  const MOCK_PORT = mockServer.address().port

  gw.providers = [
    {
      id: 'prov-1',
      name: 'Mock',
      baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
      apiKey: 'gw-test-key',
      models: ['sub-a', 'sub-b', 'sub-slow-a', 'sub-slow-b', 'sub-f', 'agg-1', 'direct-1', 'direct-t', 'direct-t2'].map((id) => ({ id, name: id, providerId: 'prov-1' })),
      enabled: true
    }
  ]

  console.log('\n[1] aggregate + stream:true：对外真流式增量（拼接=全文）+ UI 事件全序列')
  {
    moaConfig.setMoaConfig({ mode: 'aggregate', subModels: SUB_MODELS, aggregator: { primaryModelId: 'agg-1', primaryProviderId: 'prov-1' } })
    mock.scripts.set('sub-a', { frames: ['甲1', '甲2', '甲3'], gapMs: 70, usage: { prompt_tokens: 3, completion_tokens: 6 } })
    mock.scripts.set('sub-b', { frames: ['乙1', '乙2'], gapMs: 70, usage: { prompt_tokens: 1, completion_tokens: 2 } })
    mock.scripts.set('agg-1', { frames: ['聚合', '结果'], gapMs: 80, usage: { prompt_tokens: 11, completion_tokens: 22 } })

    const mark = uiMark()
    const client = await gatewayRequest(GW_PORT, { model: 'sub-a', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    const evts = uiSince(mark)
    const roundId = roundIdOf(evts)

    eq(client.status, 200, 'HTTP 200')
    // T4.1：MoA 真流式分支须在首帧前补上 SSE 三个响应头（旧版 L493-495 行为回归）
    ok(String(client.headers['content-type'] || '').includes('text/event-stream'), 'MoA 流式响应头 content-type 含 text/event-stream', client.headers['content-type'])
    eq(client.headers['cache-control'], 'no-cache', 'MoA 流式响应头 cache-control = no-cache')
    eq(client.headers['connection'], 'keep-alive', 'MoA 流式响应头 connection = keep-alive')
    eq(sseContent(client.raw), '聚合结果', '增量拼接 = 聚合全文')
    eq(parseSseData(client.raw)[parseSseData(client.raw).length - 1], '[DONE]', '以 [DONE] 结束')
    eq(finishCount(client.raw), 1, '恰一帧 finish_reason:stop')
    const contentChunks = client.chunks.filter((c) => c.text.includes('"delta":{"content"'))
    ok(contentChunks.length >= 2, '内容帧 ≥ 2（真增量）', { n: contentChunks.length })
    ok(contentChunks.length >= 2 && contentChunks[contentChunks.length - 1].t - contentChunks[0].t >= 40,
      '内容帧分时到达（非一次性，跨度 ≥ 40ms）', { span: contentChunks.length >= 2 ? contentChunks[contentChunks.length - 1].t - contentChunks[0].t : -1 })
    const first = jsonFrames(client.raw)[0]
    eq(first.object, 'chat.completion.chunk', 'object = chat.completion.chunk')
    eq(first.model, 'moa-aggregated', 'model = moa-aggregated')
    ok(typeof first.id === 'string' && first.id.indexOf('chatcmpl-moa-') === 0, 'id = chatcmpl-moa-*（' + first.id + '）')

    // UI 事件序列
    eq(evts[0]?.channel, 'gateway:roundStart', '序列以 roundStart 开始')
    eq(evts[0]?.payload.mode, 'aggregate', 'roundStart.mode = aggregate')
    eq(evts[0]?.payload.subModels, [
      { index: 0, modelId: 'sub-a', role: 'critic' },
      { index: 1, modelId: 'sub-b', role: '' }
    ], 'roundStart 子模型清单（index/modelId/role）')
    eq(evts[0]?.payload.aggregator, { modelId: 'agg-1' }, 'roundStart.aggregator = 聚合模型')

    const subEvts = evts.filter((e) => e.channel === 'gateway:subUpdate' && e.payload.roundId === roundId)
    ok(subEvts.some((e) => e.payload.status === 'running'), '含 running 累计更新', { statuses: subEvts.map((e) => e.payload.status) })
    ok(subEvts.filter((e) => e.payload.status === 'running').every((e) => typeof e.payload.content === 'string' && e.payload.content.length > 0),
      'running 更新携带累计文本')
    for (const idx of [0, 1]) {
      const term = subEvts.filter((e) => e.payload.index === idx && e.payload.status === 'success').pop()
      ok(Boolean(term) && term.payload.content.length > 0, '子模型 index ' + idx + ' 终态 success 且带内容', term && term.payload)
    }
    eq(subEvts.filter((e) => e.payload.index === 0 && e.payload.status === 'success').pop()?.payload.tokenUsage,
      { prompt: 3, completion: 6 }, '终态 usage 透传（子模型）')

    eq(chanCount(evts.filter((e) => e.payload.roundId === roundId), 'gateway:aggStart'), 1, '恰一次 aggStart')
    const aggChunks = evts.filter((e) => e.channel === 'gateway:aggChunk' && e.payload.roundId === roundId)
    ok(aggChunks.some((e) => e.payload.done === false), '含 aggChunk done=false（节流累计）')
    const doneChunk = aggChunks.find((e) => e.payload.done === true)
    ok(Boolean(doneChunk), '含 aggChunk done=true（终态）')
    eq(doneChunk?.payload.text, '聚合结果', '终态 text = 聚合全文')

    const seq = evts.map((e) => e.channel)
    ok(seq.indexOf('gateway:aggStart') < seq.lastIndexOf('gateway:aggChunk'), 'aggStart 先于 aggChunk')
    ok(seq.lastIndexOf('gateway:subUpdate') < seq.indexOf('gateway:roundDone'), 'subUpdate 先于 roundDone')
    eq(seq[seq.length - 1], 'gateway:roundDone', '序列以 roundDone 结束')
    const doneEvt = evts[evts.length - 1]
    eq(doneEvt.payload.success, true, 'roundDone.success = true')
    ok(!doneEvt.payload.aborted, 'roundDone.aborted 非真')
    ok(!JSON.stringify(evts).includes('"apiKey"') && !JSON.stringify(evts).includes('gw-test-key'), '广播 payload 不含密钥/敏感字段')

    // 记账保持：成功一条 aggregate（models 明细含 2 子模型 + 1 聚合）
    const log = gw.dbLogs.filter((l) => String(l.sql).includes('request_logs')).pop()
    ok(Boolean(log) && log.params[2] === 'aggregate' && log.params[8] === 1, '记账：aggregate 成功一条', log && log.params)
    const loggedModels = log ? JSON.parse(log.params[10]) : []
    eq(loggedModels.length, 3, '记账 models 明细 = 2 子模型 + 1 聚合')
    ok(loggedModels.some((m) => m.role === 'agg' && m.modelId === 'agg-1' && m.completion === 22), '记账含聚合模型 usage')
  }

  console.log('\n[2] 客户端中途断开 → abort 链路：聚合不发起 + roundDone aborted:true')
  {
    moaConfig.setMoaConfig({
      mode: 'aggregate',
      subModels: [
        { modelId: 'sub-slow-a', providerId: 'prov-1', order: 0 },
        { modelId: 'sub-slow-b', providerId: 'prov-1', order: 1 }
      ],
      aggregator: { primaryModelId: 'agg-never', primaryProviderId: 'prov-1' }
    })
    mock.scripts.set('sub-slow-a', { frames: ['S1', 'S2'], gapMs: 400 })
    mock.scripts.set('sub-slow-b', { frames: ['T1', 'T2'], gapMs: 400 })
    mock.scripts.set('agg-never', { frames: ['不应到达'] })

    const mark = uiMark()
    const aggBefore = mock.count('agg-never')
    const clientPromise = gatewayRequest(GW_PORT, { model: 'sub-slow-a', stream: true, messages: [{ role: 'user', content: 'hi' }] }, { destroyAfterMs: 150 })
    await waitFor(() => mock.count('sub-slow-a') > 0, 2000) // 确认请求在途
    const client = await clientPromise
    ok(Boolean(client.error) || Boolean(client.closed), '客户端已断开（连接销毁）')

    const evts = uiSince(mark)
    const roundId = roundIdOf(evts)
    eq(evts[0]?.channel, 'gateway:roundStart', 'roundStart 已广播')
    const doneEvt = await waitFor(() => evts.find((e) => e.channel === 'gateway:roundDone' && e.payload.roundId === roundId), 3000)
    ok(Boolean(doneEvt), 'roundDone 已广播')
    eq(doneEvt?.payload.aborted, true, 'roundDone.aborted = true')
    eq(doneEvt?.payload.success, false, 'roundDone.success = false')
    eq(mock.count('agg-never') - aggBefore, 0, '聚合请求零发起（abort 短路）')
    eq(chanCount(evts, 'gateway:aggStart'), 0, '无 aggStart 事件')
    eq(chanCount(evts, 'gateway:aggChunk'), 0, '无 aggChunk 事件')
    const subEvts = evts.filter((e) => e.channel === 'gateway:subUpdate')
    ok(subEvts.some((e) => e.payload.status === 'error' && String(e.payload.error || '').includes('已中止')),
      '子模型终态标注「已中止」（保留已收文本）')
    const log = gw.dbLogs.filter((l) => String(l.sql).includes('request_logs')).pop()
    ok(Boolean(log) && log.params[8] === 0 && String(log.params[9]).includes('客户端断开中止'),
      '记账：中止按已发生用量记 + error_detail 标注', log && log.params)
  }

  console.log('\n[3] 透传兜底（未配置子模型）：透传字节不变 + 单模型直播事件 + 非流式终态一次')
  {
    moaConfig.setMoaConfig({ mode: 'direct', subModels: [], aggregator: null })
    mock.scripts.set('direct-1', { frames: ['直', '通'], gapMs: 80, usage: { prompt_tokens: 5, completion_tokens: 7 }, content: '非流式直通' })

    const mark = uiMark()
    const client = await gatewayRequest(GW_PORT, { model: 'direct-1', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    const evts = uiSince(mark)

    eq(client.status, 200, 'HTTP 200')
    // T4.1：子串断言升级为逐字节比对（评审变异 M7「事件间插空行」可整体漏过子串检查）
    const directUp = mock.sentOf('direct-1')
    const directGot = Buffer.concat(client.chunks.map((c) => c.buf))
    ok(directUp.length > 0, 'mock 已记录上游字节（比对基准非空）', { n: directUp.length })
    ok(Buffer.compare(directGot, directUp) === 0, '上游帧逐字节透传（Buffer.compare === 0）', { client: directGot.length, upstream: directUp.length })
    ok(client.raw.trimEnd().endsWith('data: [DONE]'), '客户端收到 [DONE]')
    eq(evts[0]?.channel, 'gateway:roundStart', 'roundStart 已广播')
    eq(evts[0]?.payload.mode, 'direct', 'roundStart.mode = direct')
    eq(evts[0]?.payload.subModels, [{ index: 0, modelId: 'direct-1', role: '' }], 'direct 单模型清单')
    eq(evts[0]?.payload.aggregator, undefined, 'direct 无聚合清单')
    const subEvts = evts.filter((e) => e.channel === 'gateway:subUpdate')
    ok(subEvts.some((e) => e.payload.status === 'running' && e.payload.content.length > 0), 'running 直播（旁路累计文本）')
    const term = subEvts.find((e) => e.payload.status === 'success')
    eq(term?.payload.content, '直通', '终态 content = 旁路累计全文')
    eq(term?.payload.tokenUsage, { prompt: 5, completion: 7 }, '终态 usage 来自旁路终结帧')
    eq(subEvts.filter((e) => e.payload.status === 'success').length, 1, '终态只广播一次')
    eq(chanCount(evts, 'gateway:aggStart') + chanCount(evts, 'gateway:aggChunk'), 0, 'direct 无 agg 事件')
    eq(evts[evts.length - 1]?.channel, 'gateway:roundDone', '以 roundDone 结束')
    eq(evts[evts.length - 1]?.payload.success, true, 'roundDone.success = true')

    // 非流式透传兜底：roundStart → 完成时终态一次 → roundDone
    const mark2 = uiMark()
    const client2 = await gatewayRequest(GW_PORT, { model: 'direct-1', stream: false, messages: [{ role: 'user', content: 'hi' }] })
    const evts2 = uiSince(mark2)
    eq(client2.status, 200, '非流式 HTTP 200')
    eq(JSON.parse(client2.raw).choices[0].message.content, '非流式直通', '非流式直回 JSON 不变')
    eq(evts2[0]?.channel, 'gateway:roundStart', '非流式 roundStart 已广播')
    const term2 = evts2.filter((e) => e.channel === 'gateway:subUpdate' && e.payload.status === 'success')
    eq(term2.length, 1, '非流式 direct 终态恰一次')
    eq(term2[0]?.payload.content, '非流式直通', '非流式终态 content = 直回内容')
    eq(evts2[evts2.length - 1]?.channel, 'gateway:roundDone', '非流式以 roundDone 结束')
  }

  console.log('\n[3b] 透传兜底字节级透传：心跳注释/事件间空行/多字节切块/畸形行（Buffer.compare === 0）')
  {
    moaConfig.setMoaConfig({ mode: 'direct', subModels: [], aggregator: null })
    // 自含原样字节脚本：注释心跳 + emoji 跨 write 拦腰截断 + 事件间多余空行（M7 类变异：
    // 语义等价但字节改变）+ 畸形行 + JSON 内孤立 \r + [DONE]；逐字节比对须全部原样保留。
    const emojiFrame = sseFrame('甲🙂乙')
    const emojiBuf = Buffer.from(emojiFrame, 'utf8')
    const cut = emojiBuf.indexOf(Buffer.from('🙂', 'utf8')) + 2 // 把 4 字节 emoji 切成 2+2 两次 write
    mock.scripts.set('direct-1', {
      gapMs: 15,
      rawParts: [
        ': keep-alive\r\n\r\n',
        emojiBuf.subarray(0, cut),
        emojiBuf.subarray(cut),
        '\n',
        'data: {"malformed\n\n',
        'data: {"broken":"a\rb"}\n\n',
        sseFinish(),
        'data: [DONE]\n\n'
      ]
    })

    const mark = uiMark()
    const client = await gatewayRequest(GW_PORT, { model: 'direct-1', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    const up = mock.sentOf('direct-1')
    const got = Buffer.concat(client.chunks.map((c) => c.buf))

    eq(client.status, 200, 'HTTP 200')
    ok(up.length > 0, 'mock 已记录上游字节（比对基准非空）', { n: up.length })
    ok(Buffer.compare(got, up) === 0, '上游字节逐字节透传（含畸形流，Buffer.compare === 0）', { client: got.length, upstream: up.length })
    ok(client.raw.includes('甲🙂乙') && !client.raw.includes('\uFFFD'), '多字节内容完好（无 U+FFFD）')
    ok(client.raw.includes(': keep-alive') && client.raw.includes('a\rb'), '心跳注释与孤立 \\r 原样保留')
    ok(client.raw.trimEnd().endsWith('data: [DONE]'), '以 [DONE] 收尾')
    eq(uiSince(mark).filter((e) => e.channel === 'gateway:roundDone').length, 1, 'roundDone 恰一次（旁路解析对畸形数据容错）')
  }

  console.log('\n[4] 非流式客户端（aggregate stream:false）：完整 JSON + UI 事件仍全')
  {
    moaConfig.setMoaConfig({ mode: 'aggregate', subModels: SUB_MODELS, aggregator: { primaryModelId: 'agg-1', primaryProviderId: 'prov-1' } })
    gw.settings.gateway.transparency = 'extended'
    const mark = uiMark()
    const client = await gatewayRequest(GW_PORT, { model: 'sub-a', stream: false, messages: [{ role: 'user', content: 'hi' }] })
    const evts = uiSince(mark)

    eq(client.status, 200, 'HTTP 200')
    const body = JSON.parse(client.raw)
    eq(body.model, 'moa-aggregated', 'JSON model = moa-aggregated')
    eq(body.choices[0].message.content, '聚合结果', 'JSON content = 聚合全文')
    eq(body.choices[0].finish_reason, 'stop', 'JSON finish_reason = stop')
    ok(Array.isArray(body.x_moa_sub_models) && body.x_moa_sub_models.length === 2, 'transparency extended：x_moa_sub_models 明细保留')
    eq(evts[0]?.channel, 'gateway:roundStart', 'roundStart 已广播')
    ok(evts.some((e) => e.channel === 'gateway:subUpdate' && e.payload.status === 'success'), '子模型终态事件仍全')
    ok(evts.some((e) => e.channel === 'gateway:aggChunk' && e.payload.done === true), '聚合终态事件仍全（UI 直播不受客户端类型影响）')
    eq(evts[evts.length - 1]?.channel, 'gateway:roundDone', '以 roundDone 结束')
    eq(evts[evts.length - 1]?.payload.success, true, 'roundDone.success = true')
    gw.settings.gateway.transparency = 'default'
  }

  console.log('\n[5] 旧配置残留 mode:\'compare\'：模式不可配置，网关仍按聚合执行（出口必给唯一答案）')
  {
    // 网关固定聚合模式（direct/compare 已从网关移除）：残留旧值不得改变行为
    moaConfig.setMoaConfig({ mode: 'compare', subModels: SUB_MODELS, aggregator: { primaryModelId: 'agg-1', primaryProviderId: 'prov-1' } })
    const mark = uiMark()
    const client = await gatewayRequest(GW_PORT, { model: 'sub-a', stream: false, messages: [{ role: 'user', content: 'hi' }] })
    const evts = uiSince(mark)

    eq(client.status, 200, 'HTTP 200')
    const body = JSON.parse(client.raw)
    eq(body.model, 'moa-aggregated', '残留 compare 被忽略：JSON model = moa-aggregated')
    eq(body.choices[0].message.content, '聚合结果', 'JSON content = 聚合全文（唯一最终答案）')
    eq(evts[0]?.payload.mode, 'aggregate', 'roundStart.mode = aggregate')
    eq(evts[0]?.payload.subModels.length, 2, '全部子模型在清单中')
    ok(evts.some((e) => e.channel === 'gateway:subUpdate' && e.payload.status === 'success'), '子模型流直播照常')
    eq(chanCount(evts, 'gateway:aggStart'), 1, '聚合确实发生：恰一次 aggStart')
    ok(evts.some((e) => e.channel === 'gateway:aggChunk' && e.payload.done === true), '含聚合终态 aggChunk')
    eq(evts[evts.length - 1]?.channel, 'gateway:roundDone', '以 roundDone 结束')
    eq(evts[evts.length - 1]?.payload.success, true, 'roundDone.success = true')
  }

  console.log('\n[6] 聚合 fallback（未写增量）：对外无缝接续，UI 收 fallback 全文')
  {
    moaConfig.setMoaConfig({
      mode: 'aggregate',
      subModels: [{ modelId: 'sub-f', providerId: 'prov-1', order: 0 }],
      aggregator: { primaryModelId: 'agg-500', primaryProviderId: 'prov-1', fallbackModelId: 'agg-fb', fallbackProviderId: 'prov-1' }
    })
    mock.scripts.set('sub-f', { frames: ['F1'], gapMs: 20 })
    mock.scripts.set('agg-500', { httpStatus: 500 })
    mock.scripts.set('agg-fb', { frames: ['回退', '结果'], gapMs: 60, usage: { prompt_tokens: 2, completion_tokens: 4 } })

    const mark = uiMark()
    const before500 = mock.count('agg-500')
    const beforeFb = mock.count('agg-fb')
    const client = await gatewayRequest(GW_PORT, { model: 'sub-f', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    const evts = uiSince(mark)

    eq(mock.count('agg-500') - before500, 1, 'primary 聚合已尝试一次')
    eq(mock.count('agg-fb') - beforeFb, 1, 'fallback 聚合恰一次')
    eq(sseContent(client.raw), '回退结果', '对外只收到 fallback 内容（primary 无产出，无缝接续）')
    eq(parseSseData(client.raw)[parseSseData(client.raw).length - 1], '[DONE]', '以 [DONE] 结束')
    eq(finishCount(client.raw), 1, '恰一帧 finish（未重复收流）')
    const aggChunks = evts.filter((e) => e.channel === 'gateway:aggChunk')
    const doneChunk = aggChunks.find((e) => e.payload.done === true)
    eq(doneChunk?.payload.text, '回退结果', 'UI 终态 = fallback 全文')
    eq(evts[evts.length - 1]?.channel, 'gateway:roundDone', '以 roundDone 结束')
    eq(evts[evts.length - 1]?.payload.success, true, 'roundDone.success = true（fallback 救回）')
  }

  console.log('\n[7] 聚合 fallback（已写增量）：对外收流结束不可撤回，UI 继续 fallback')
  {
    moaConfig.setMoaConfig({
      mode: 'aggregate',
      subModels: [{ modelId: 'sub-f', providerId: 'prov-1', order: 0 }],
      aggregator: { primaryModelId: 'agg-part', primaryProviderId: 'prov-1', fallbackModelId: 'agg-fb2', fallbackProviderId: 'prov-1' }
    })
    mock.scripts.set('agg-part', { frames: ['前半'], gapMs: 10, midFail: true })
    mock.scripts.set('agg-fb2', { frames: ['新结果'], gapMs: 20 })

    const mark = uiMark()
    const client = await gatewayRequest(GW_PORT, { model: 'sub-f', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    // 本场景对外在 fallback 开始前即收流结束（客户端先行返回），等 roundDone 再取 UI 事件全集
    const doneEvt = await waitFor(() => gw.broadcasts.slice(mark).find((e) => e.channel === 'gateway:roundDone'), 3000)
    const evts = uiSince(mark)

    eq(sseContent(client.raw), '前半', '对外内容停在已流出部分（不可撤回）')
    eq(parseSseData(client.raw)[parseSseData(client.raw).length - 1], '[DONE]', '对外已收流结束（finish + [DONE]）')
    eq(finishCount(client.raw), 1, '恰一帧 finish')
    ok(Boolean(doneEvt), 'roundDone 已广播')
    const aggChunks = evts.filter((e) => e.channel === 'gateway:aggChunk')
    eq(aggChunks[aggChunks.length - 1]?.payload.done, true, 'UI 聚合终态已广播')
    eq(aggChunks[aggChunks.length - 1]?.payload.text, '新结果', 'UI 终态 = fallback 全文（UI 继续直播）')
    eq(evts[evts.length - 1]?.channel, 'gateway:roundDone', '以 roundDone 结束')
    eq(evts[evts.length - 1]?.payload.success, true, 'roundDone.success = true（fallback 救回）')
  }

  console.log('\n[8] MoA 引擎失败（未开流）+ stream:true：仍返回 application/json 的 502（T4.1）')
  {
    moaConfig.setMoaConfig({
      mode: 'aggregate',
      subModels: [{ modelId: 'sub-dead', providerId: 'prov-1', order: 0 }],
      aggregator: { primaryModelId: 'agg-dead', primaryProviderId: 'prov-1' }
    })
    mock.scripts.set('sub-dead', { httpStatus: 500 })
    mock.scripts.set('agg-dead', { frames: ['不应到达'] })

    const mark = uiMark()
    const aggBefore = mock.count('agg-dead')
    const client = await gatewayRequest(GW_PORT, { model: 'sub-dead', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    const evts = uiSince(mark)

    eq(client.status, 502, 'HTTP 502')
    ok(String(client.headers['content-type'] || '').includes('application/json'),
      'content-type = application/json（SSE 头未泄漏到失败路径）', client.headers['content-type'])
    ok(!client.raw.includes('data: ') && !client.raw.includes('[DONE]'), '响应体为 JSON（非 SSE 帧）')
    const body = JSON.parse(client.raw)
    ok(typeof body.error?.message === 'string' && body.error.message.length > 0, 'JSON 错误体含 error.message', body)
    eq(mock.count('agg-dead') - aggBefore, 0, '全子模型失败：聚合未发起')
    eq(chanCount(evts, 'gateway:aggStart'), 0, '无 aggStart 事件')
    eq(evts[evts.length - 1]?.channel, 'gateway:roundDone', '以 roundDone 结束')
    eq(evts[evts.length - 1]?.payload.success, false, 'roundDone.success = false')
  }

  console.log('\n[9] 网关独立协作架构：gatewayArchitecture 优先，未设置时跟随全局 architecture')
  {
    mock.scripts.set('sub-a', { frames: ['甲'], gapMs: 10 })
    mock.scripts.set('sub-b', { frames: ['乙'], gapMs: 10 })
    mock.scripts.set('agg-1', { frames: ['主持结果'], gapMs: 10 })

    // ① 独立架构生效：全局选举 + 网关主席团 → 聚合请求用主席团提示词（CHAIR_PROMPT_ZH）
    moaConfig.setMoaConfig({
      architecture: 'election',
      gatewayArchitecture: 'committee',
      subModels: SUB_MODELS,
      aggregator: { primaryModelId: 'agg-1', primaryProviderId: 'prov-1' }
    })
    const client1 = await gatewayRequest(GW_PORT, { model: 'sub-a', stream: false, messages: [{ role: 'user', content: 'hi' }] })
    eq(client1.status, 200, 'HTTP 200（独立架构=主席团）')
    const agg1 = mock.lastBody('agg-1')
    ok(String(agg1?.messages?.[0]?.content || '').includes('主席团主持人'),
      '独立架构生效：聚合请求 system = 主席团提示词（CHAIR_PROMPT_ZH）', String(agg1?.messages?.[0]?.content || '').slice(0, 40))

    // ② 清除独立架构（undefined）→ 跟随全局；全局改为主席团同样跟随
    moaConfig.setMoaConfig({ architecture: 'committee', gatewayArchitecture: undefined })
    const client2 = await gatewayRequest(GW_PORT, { model: 'sub-a', stream: false, messages: [{ role: 'user', content: 'hi' }] })
    eq(client2.status, 200, 'HTTP 200（跟随全局=主席团）')
    const agg2 = mock.lastBody('agg-1')
    ok(String(agg2?.messages?.[0]?.content || '').includes('主席团主持人'), '未设置独立架构：跟随全局 committee')

    // ③ 全局切回选举 + 未设置独立 → 聚合用选举提示词（STANDARD_PROMPT_ZH）
    moaConfig.setMoaConfig({ architecture: 'election', gatewayArchitecture: undefined })
    const client3 = await gatewayRequest(GW_PORT, { model: 'sub-a', stream: false, messages: [{ role: 'user', content: 'hi' }] })
    eq(client3.status, 200, 'HTTP 200（跟随全局=选举）')
    const agg3 = mock.lastBody('agg-1')
    ok(String(agg3?.messages?.[0]?.content || '').includes('多模型融合器'),
      '跟随全局 election：聚合请求 system = 选举提示词（STANDARD_PROMPT_ZH）')
  }

  console.log('\n[10] 网关出口模式：gatewayDirectModel 单模型直通（跳过席位/聚合与请求模型），清除/失效回落聚合')
  {
    mock.scripts.set('sub-a', { frames: ['甲'], gapMs: 10 })
    mock.scripts.set('agg-1', { frames: ['聚合结果'], gapMs: 10 })
    mock.scripts.set('direct-t', { frames: ['直通', '结果'], gapMs: 20, usage: { prompt_tokens: 5, completion_tokens: 7 } })
    mock.scripts.set('direct-t2', { content: '直通非流式' })

    // ① 直通生效：请求模型（sub-a）与席位/聚合全部让位，固定走 direct-t
    moaConfig.setMoaConfig({
      architecture: 'election',
      gatewayArchitecture: undefined,
      gatewayDirectModel: 'prov-1:direct-t',
      subModels: SUB_MODELS,
      aggregator: { primaryModelId: 'agg-1', primaryProviderId: 'prov-1' }
    })
    const mark = uiMark()
    const aggBefore = mock.count('agg-1')
    const tBefore = mock.count('direct-t')
    const subBefore = mock.count('sub-a')
    const client = await gatewayRequest(GW_PORT, { model: 'sub-a', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    const evts = uiSince(mark)

    eq(client.status, 200, 'HTTP 200')
    eq(mock.count('direct-t') - tBefore, 1, '上游恰一次调用（所选直通模型）')
    eq(mock.count('sub-a') - subBefore, 0, '席位子模型未被调用（聚合链路被跳过）')
    eq(mock.count('agg-1') - aggBefore, 0, '聚合未发起')
    eq(sseContent(client.raw), '直通结果', '对外内容 = 直通模型输出')
    eq(evts[0]?.channel, 'gateway:roundStart', '序列以 roundStart 开始')
    eq(evts[0]?.payload.mode, 'direct', 'roundStart.mode = direct')
    eq(evts[0]?.payload.subModels, [{ index: 0, modelId: 'direct-t', role: '' }], 'roundStart 单模型清单 = 所选直通模型')
    eq(evts[evts.length - 1]?.channel, 'gateway:roundDone', '以 roundDone 结束')
    eq(evts[evts.length - 1]?.payload.success, true, 'roundDone.success = true')

    // ② /health 反映实际执行路径与所选模型
    const health1 = await (await fetch(`http://127.0.0.1:${GW_PORT}/health`)).json()
    eq(health1.moaConfig.mode, 'direct', '/health moaConfig.mode = direct')
    eq(health1.moaConfig.directModel, 'direct-t', '/health moaConfig.directModel = 所选模型')

    // ③ Anthropic 端点（/v1/messages）同样固定直通（非流式 → Anthropic 响应形态）
    moaConfig.setMoaConfig({ gatewayDirectModel: 'prov-1:direct-t2' })
    const anthBefore = mock.count('direct-t2')
    const anthAggBefore = mock.count('agg-1')
    const anth = await new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: GW_PORT, path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (res) => {
          let raw = ''
          res.on('data', (d) => { raw += d })
          res.on('end', () => resolve({ status: res.statusCode, raw }))
        }
      )
      req.on('error', () => resolve({ status: 0, raw: '' }))
      req.end(JSON.stringify({ model: 'claude-3-5-sonnet', stream: false, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }))
    })
    eq(anth.status, 200, '/v1/messages HTTP 200（直通生效）')
    eq(mock.count('direct-t2') - anthBefore, 1, '/v1/messages 上游恰一次调用（所选模型）')
    eq(mock.count('agg-1') - anthAggBefore, 0, '/v1/messages 聚合未发起')
    eq(JSON.parse(anth.raw).content?.[0]?.text, '直通非流式', 'Anthropic 响应 content = 直通模型输出')

    // ④ 清除直通（undefined）→ 回落聚合
    moaConfig.setMoaConfig({ gatewayDirectModel: undefined })
    const aggBefore2 = mock.count('agg-1')
    const client4 = await gatewayRequest(GW_PORT, { model: 'sub-a', stream: false, messages: [{ role: 'user', content: 'hi' }] })
    eq(client4.status, 200, '清除直通后 HTTP 200')
    eq(mock.count('agg-1') - aggBefore2, 1, '清除直通 → 聚合恢复（agg-1 恰一次）')
    eq(JSON.parse(client4.raw).model, 'moa-aggregated', '聚合出口：JSON model = moa-aggregated')

    // ⑤ 配置失效（厂商不存在 / 模型不在列表）→ 回落聚合，不静默走错模型
    moaConfig.setMoaConfig({ gatewayDirectModel: 'prov-none:whatever' })
    const aggBefore3 = mock.count('agg-1')
    const client5 = await gatewayRequest(GW_PORT, { model: 'sub-a', stream: false, messages: [{ role: 'user', content: 'hi' }] })
    eq(client5.status, 200, '厂商不存在配置 HTTP 200')
    eq(mock.count('agg-1') - aggBefore3, 1, '厂商不存在 → 回落聚合')
    moaConfig.setMoaConfig({ gatewayDirectModel: 'prov-1:ghost-model' })
    const aggBefore4 = mock.count('agg-1')
    const client6 = await gatewayRequest(GW_PORT, { model: 'sub-a', stream: false, messages: [{ role: 'user', content: 'hi' }] })
    eq(client6.status, 200, '模型不在列表配置 HTTP 200')
    eq(mock.count('agg-1') - aggBefore4, 1, '模型不在列表 → 回落聚合')
    const health2 = await (await fetch(`http://127.0.0.1:${GW_PORT}/health`)).json()
    eq(health2.moaConfig.mode, 'aggregate', '配置失效时 /health mode = aggregate（不虚报直通）')

    // 清理：不留直通配置（防御性收敛）
    moaConfig.setMoaConfig({ gatewayDirectModel: undefined })
  }

  console.log('\n──────────────────────────────')
  console.log(`通过 ${pass} / 失败 ${fail}`)
  try { gwServer.close() } catch { /* ignore */ }
  try { mockServer.close() } catch { /* ignore */ }
  process.exit(fail === 0 ? 0 : 1)
})().catch((err) => {
  console.error('测试脚本异常：', err)
  process.exit(1)
})
