// 冒烟测试：POST /v1/messages（Anthropic Messages API 端点，T7）——
// ① 文本非流式响应格式（type/role/content/stop_reason/usage）② 流式 Anthropic SSE 事件序列完整
// （message_start … message_stop，文本增量真流）+ ③ tools 转换透传（子/聚合请求体断言）
// ④ 聚合模型 tool_calls → tool_use 块 + stop_reason:'tool_use' ⑤ UI 广播事件照常
// ⑥ 客户端断开 → abort 链路 ⑦ direct 模式（无聚合）透传 + 事件转换 ⑧ 失败未开流 → Anthropic 错误 JSON
// ⑨ 聚合截断 finish_reason=length → stop_reason max_tokens（T7-SF1）⑩ 多 index 交织工具帧 /
//   direct 非流式工具型上游 / compare 模式 / direct 断开与上游失败（T7-SF2：覆盖缺口固化）
// 用法：node test-e2e/anthropic-endpoint.cjs
// 加载方式：esbuild bundle（stdin 聚合入口：server / uiBridge / moaConfig 共享同一模块实例）+
//   plugin stub：electron、../db/database、../config/appSettings、../providers/providerManager、
//   ../local/fetchProxy（走全局 fetch）。起真实网关 + node:http mock 上游（按 body.model 分派脚本）。
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
  dbLogs: [],
  broadcasts: [],
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
    stdin: { contents: entry, resolveDir: ROOT, loader: 'ts', sourcefile: 'anthropic-endpoint-entry.ts' },
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
  requests: [], // { model, stream, body, path, headers }
  scripts: new Map(), // model → { frames, toolFrames, gapMs, usage, finishReason, httpStatus, content }
  closed: [], // 中途断开（socket 关闭且响应未正常结束）的上游模型：abort 链路断言用
  of(model) { return this.requests.filter((r) => r.model === model) },
  lastBody(model) { const hit = this.of(model).pop(); return hit ? hit.body : null },
  count(model) { return this.of(model).length }
}

const sseFrame = (content) =>
  'data: ' + JSON.stringify({ id: 'mock-cmpl', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] }) + '\n\n'
/** tool_calls 增量帧（标准嵌套形态：delta.tool_calls[].function.{name,arguments}） */
const sseToolFrame = (tf) =>
  'data: ' + JSON.stringify({
    id: 'mock-cmpl',
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: tf.index,
          ...(tf.id ? { id: tf.id, type: 'function' } : {}),
          function: { ...(tf.name ? { name: tf.name } : {}), arguments: tf.arguments || '' }
        }]
      },
      finish_reason: null
    }]
  }) + '\n\n'
const sseFinish = (reason) =>
  'data: ' + JSON.stringify({ id: 'mock-cmpl', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: reason }] }) + '\n\n'
const sseUsage = (usage) =>
  'data: ' + JSON.stringify({ id: 'mock-cmpl', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens } }) + '\n\n'

async function mockHandle(body, res, meta) {
  const model = String(body.model || '')
  mock.requests.push({ model, stream: body.stream === true, body, path: meta.path, headers: meta.headers })
  // 网关中途断开：socket 关闭且响应未正常结束 → 记为「上游连接被取消」（direct abort 用例断言用）
  res.on('close', () => { if (!res.writableEnded) mock.closed.push(model) })
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
    const message = script.toolFrames
      ? {
          role: 'assistant',
          content: null,
          tool_calls: Object.values(script.toolFrames.reduce((acc, tf) => {
            const cur = acc[tf.index] || { id: tf.id || '', type: 'function', function: { name: tf.name || '', arguments: '' } }
            if (tf.id) cur.id = tf.id
            if (tf.name) cur.function.name = tf.name
            cur.function.arguments += tf.arguments || ''
            acc[tf.index] = cur
            return acc
          }, {})).map((c) => ({ id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments } }))
        }
      : { role: 'assistant', content: script.content || '' }
    res.end(JSON.stringify({
      id: 'mock-cmpl',
      object: 'chat.completion',
      choices: [{ index: 0, message, finish_reason: script.finishReason || 'stop' }],
      usage: { prompt_tokens: script.usage?.prompt_tokens || 0, completion_tokens: script.usage?.completion_tokens || 0 }
    }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  const write = (part) => res.write(part)
  for (const frame of script.frames || []) {
    write(sseFrame(frame))
    await sleep(script.gapMs || 10)
  }
  for (const tf of script.toolFrames || []) {
    write(sseToolFrame(tf))
    await sleep(script.gapMs || 10)
  }
  write(sseFinish(script.finishReason || (script.toolFrames ? 'tool_calls' : 'stop')))
  if (script.usage) write(sseUsage(script.usage))
  write('data: [DONE]\n\n')
  res.end()
}

// ── 网关客户端（node:http；可中途 destroy 模拟客户端断开） ──

function messagesRequest(port, body, opts = {}) {
  return new Promise((resolve) => {
    const chunks = []
    let settled = false
    const done = (extra) => {
      if (settled) return
      settled = true
      resolve(Object.assign({ raw: chunks.map((c) => c.text).join(''), chunks }, extra))
    }
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: opts.path || '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 必须被忽略不报错：anthropic-version / anthropic-beta 头
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31',
          'x-api-key': 'gw-test-key'
        }
      },
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

// ── Anthropic SSE 解析（event: 行 + data: 行 + 空行） ──

function parseAnthropicSse(raw) {
  const events = []
  for (const block of raw.split('\n\n')) {
    const lines = block.split('\n').filter((l) => l !== '')
    if (lines.length === 0) continue
    const evLine = lines.find((l) => l.startsWith('event: '))
    const dataLine = lines.find((l) => l.startsWith('data: '))
    if (!evLine) continue
    const event = evLine.slice('event: '.length)
    let data = null
    try { data = JSON.parse(dataLine.slice('data: '.length)) } catch { data = null }
    events.push({ event, data })
  }
  return events
}
const eventNames = (raw) => parseAnthropicSse(raw).map((e) => e.event)
const textOf = (raw) => parseAnthropicSse(raw)
  .filter((e) => e.event === 'content_block_delta' && e.data?.delta?.type === 'text_delta')
  .map((e) => e.data.delta.text).join('')
const blockStarts = (raw) => parseAnthropicSse(raw).filter((e) => e.event === 'content_block_start').map((e) => e.data.content_block)
const messageDelta = (raw) => parseAnthropicSse(raw).find((e) => e.event === 'message_delta')?.data
const messageStart = (raw) => parseAnthropicSse(raw).find((e) => e.event === 'message_start')?.data

const uiMark = () => gw.broadcasts.length
const uiSince = (mark) => gw.broadcasts.slice(mark)
const chanCount = (evts, channel) => evts.filter((e) => e.channel === channel).length
const roundIdOf = (evts) => evts[0]?.payload?.roundId

// v9：预设角色已退役——夹具采用「迁移后形态」（role 空 + 自定义介绍），旧预设数据由 app 启动迁移自动转换
const SUB_MODELS = [
  {
    modelId: 'sub-a',
    providerId: 'prov-1',
    order: 0,
    role: '',
    systemPrompt: '你是一位严格的批判者。请从逻辑、事实可靠性、潜在风险和缺陷角度审视该问题，并给出建设性改进点。参考本轮上下文，只输出你的批判性意见。'
  },
  { modelId: 'sub-b', providerId: 'prov-1', order: 1 }
]
const TOOLS_REQUEST = {
  model: 'sub-a',
  max_tokens: 4096,
  system: [
    { type: 'text', text: '你是助手' },
    { type: 'text', text: '缓存段', cache_control: { type: 'ephemeral' } }
  ],
  tools: [{
    name: 'Read',
    description: '读文件',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }],
  tool_choice: { type: 'auto' },
  thinking: { type: 'enabled', budget_tokens: 1024 },
  metadata: { user_id: 'u1' },
  messages: [
    { role: 'user', content: '读一下 a.txt' },
    { role: 'assistant', content: [{ type: 'text', text: '好的' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '文件内容' }] }
  ]
}

// ── 用例 ──

;(async () => {
  const mod = await loadGateway()
  const gatewayMod = mod.server
  const uiBridge = mod.uiBridge
  const moaConfig = mod.moaConfig

  uiBridge.initUiBridge((channel, payload) => {
    gw.broadcasts.push({ channel, payload, t: Date.now() })
  })

  const app = gatewayMod.createGatewayServer()
  const gwServer = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const GW_PORT = gwServer.address().port

  const mockServer = http.createServer((req, res) => {
    res.on('error', () => {})
    let raw = ''
    req.on('error', () => {})
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw || '{}') } catch { /* 非 JSON 请求体 */ }
      mockHandle(body, res, { path: req.url, headers: req.headers }).catch(() => { try { res.destroy() } catch { /* ignore */ } })
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
      models: ['sub-a', 'sub-b', 'sub-slow-a', 'sub-slow-b', 'sub-f', 'agg-1', 'agg-tools', 'agg-dead', 'agg-cut', 'agg-cut-tools', 'agg-inter', 'direct-1', 'direct-tc', 'direct-slow', 'direct-fail'].map((id) => ({ id, name: id, providerId: 'prov-1' })),
      enabled: true
    }
  ]

  console.log('\n[1] 文本对话（非流式）：Anthropic message JSON + UI 事件全序列')
  {
    moaConfig.setMoaConfig({ mode: 'aggregate', subModels: SUB_MODELS, aggregator: { primaryModelId: 'agg-1', primaryProviderId: 'prov-1' } })
    // gapMs ≥ 节流窗口（50ms，STREAM_PUSH_INTERVAL_MS）且帧数 ≥2：否则 running 累计更新会被终态 flush 覆盖（窗口内合并是设计行为）
    mock.scripts.set('sub-a', { frames: ['甲1', '甲2', '甲3'], gapMs: 70, usage: { prompt_tokens: 3, completion_tokens: 6 } })
    mock.scripts.set('sub-b', { frames: ['乙1', '乙2'], gapMs: 70, usage: { prompt_tokens: 1, completion_tokens: 2 } })
    mock.scripts.set('agg-1', { frames: ['聚合', '结果'], gapMs: 80, usage: { prompt_tokens: 11, completion_tokens: 22 } })

    const mark = uiMark()
    const client = await messagesRequest(GW_PORT, { model: 'sub-a', max_tokens: 1024, system: '你是助手', stream: false, messages: [{ role: 'user', content: '你好' }] })
    const evts = uiSince(mark)

    eq(client.status, 200, 'HTTP 200')
    ok(String(client.headers['content-type'] || '').includes('application/json'), 'content-type = application/json', client.headers['content-type'])
    const body = JSON.parse(client.raw)
    ok(/^msg_/.test(body.id), 'id 以 msg_ 开头（' + body.id + '）')
    eq(body.type, 'message', "type = 'message'")
    eq(body.role, 'assistant', "role = 'assistant'")
    eq(body.model, 'moa-aggregated', "model = 'moa-aggregated'")
    eq(body.content, [{ type: 'text', text: '聚合结果' }], 'content = [text 块（聚合全文）]')
    eq(body.stop_reason, 'end_turn', "stop_reason = 'end_turn'")
    eq(body.stop_sequence, null, 'stop_sequence = null')
    eq(body.usage, { input_tokens: 11, output_tokens: 22 }, 'usage 来自聚合模型用量')

    // UI 广播（与 chat/completions 同链路）
    eq(evts[0]?.channel, 'gateway:roundStart', '序列以 roundStart 开始')
    eq(evts[0]?.payload.mode, 'aggregate', 'roundStart.mode = aggregate')
    eq(evts[0]?.payload.subModels, [
      { index: 0, modelId: 'sub-a', role: '' },
      { index: 1, modelId: 'sub-b', role: '' }
    ], 'roundStart 子模型清单（index/modelId/role；role 已退役恒空）')
    const roundId = roundIdOf(evts)
    const subEvts = evts.filter((e) => e.channel === 'gateway:subUpdate' && e.payload.roundId === roundId)
    ok(subEvts.some((e) => e.payload.status === 'running'), '含 running 累计更新')
    ok(subEvts.some((e) => e.payload.status === 'success'), '含子模型终态')
    eq(chanCount(evts, 'gateway:aggStart'), 1, '恰一次 aggStart')
    const aggChunks = evts.filter((e) => e.channel === 'gateway:aggChunk' && e.payload.roundId === roundId)
    eq(aggChunks.find((e) => e.payload.done === true)?.payload.text, '聚合结果', 'aggChunk 终态 = 聚合全文')
    eq(evts[evts.length - 1]?.channel, 'gateway:roundDone', '序列以 roundDone 结束')
    eq(evts[evts.length - 1]?.payload.success, true, 'roundDone.success = true')
  }

  console.log('\n[2] 文本对话（流式）：Anthropic SSE 事件序列完整 + 文本增量真流')
  {
    const mark = uiMark()
    const client = await messagesRequest(GW_PORT, { model: 'sub-a', max_tokens: 1024, stream: true, messages: [{ role: 'user', content: '你好' }] })
    const evts = uiSince(mark)

    eq(client.status, 200, 'HTTP 200')
    ok(String(client.headers['content-type'] || '').includes('text/event-stream'), 'content-type 含 text/event-stream', client.headers['content-type'])
    eq(client.headers['cache-control'], 'no-cache', 'cache-control = no-cache')
    eq(eventNames(client.raw), [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop'
    ], '事件序列：message_start → block_start → delta×2 → block_stop → message_delta → message_stop')
    eq(textOf(client.raw), '聚合结果', '文本增量拼接 = 聚合全文')
    eq(messageStart(client.raw)?.message?.model, 'moa-aggregated', 'message_start.message.model')
    eq(messageDelta(client.raw)?.delta?.stop_reason, 'end_turn', "message_delta.stop_reason = 'end_turn'")
    eq(messageDelta(client.raw)?.usage, { input_tokens: 11, output_tokens: 22 }, 'message_delta.usage = 聚合模型用量')
    ok(!client.raw.includes('[DONE]'), 'Anthropic 格式不带 OpenAI 的 [DONE]（event: 行格式）')
    const textChunks = client.chunks.filter((c) => c.text.includes('"text_delta"'))
    ok(textChunks.length >= 2, '文本增量帧 ≥ 2（真流式）', { n: textChunks.length })
    ok(textChunks.length >= 2 && textChunks[textChunks.length - 1].t - textChunks[0].t >= 40,
      '文本增量分时到达（非一次性，跨度 ≥ 40ms）', { span: textChunks.length >= 2 ? textChunks[textChunks.length - 1].t - textChunks[0].t : -1 })

    const doneEvt = evts.find((e) => e.channel === 'gateway:roundDone')
    eq(doneEvt?.payload.success, true, 'roundDone.success = true（流式路径直播照常）')
  }

  console.log('\n[3] tools 请求转换：子 / 聚合请求体含 OpenAI tools + 消息结构转换（mock 上游断言）')
  {
    const beforeSub = mock.count('sub-a')
    const beforeAgg = mock.count('agg-1')
    const client = await messagesRequest(GW_PORT, { ...TOOLS_REQUEST, stream: false })
    eq(client.status, 200, 'HTTP 200')
    eq(mock.count('sub-a') - beforeSub, 1, '子模型 sub-a 恰一次调用')
    eq(mock.count('agg-1') - beforeAgg, 1, '聚合模型恰一次调用')

    const subBody = mock.lastBody('sub-a')
    eq(subBody.tools, [{
      type: 'function',
      function: {
        name: 'Read',
        description: '读文件',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
      }
    }], '子模型请求体：Anthropic tools → OpenAI tools（input_schema → parameters）')
    eq(subBody.tool_choice, 'auto', '子模型请求体：tool_choice 映射 auto')
    const subSystem = subBody.messages.find((m) => m.role === 'system')
    ok(subSystem?.content.includes('你是助手') && subSystem?.content.includes('缓存段') && subSystem?.content.includes('批判者'),
      '子模型请求体：system blocks 拼接（cache_control 忽略）+ 角色提示词合并保留', subSystem)
    const assistantMsg = subBody.messages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))
    eq(assistantMsg?.tool_calls, [{ id: 'toolu_1', type: 'function', function: { name: 'Read', arguments: '{"path":"a.txt"}' } }],
      '子模型请求体：assistant tool_use → tool_calls（arguments = JSON(input)）')
    const toolMsg = subBody.messages.find((m) => m.role === 'tool')
    eq(toolMsg, { role: 'tool', tool_call_id: 'toolu_1', content: '文件内容' }, '子模型请求体：tool_result → role:tool 消息')
    ok(!('thinking' in (subBody || {})) && !('metadata' in (subBody || {})), 'thinking / metadata 未透传（忽略不报错）')

    const aggBody = mock.lastBody('agg-1')
    eq(aggBody.tools?.length, 1, '聚合请求体同样带 tools（聚合模型为工具调用最终发言人）')
    eq(aggBody.tool_choice, 'auto', '聚合请求体带 tool_choice')
    ok(aggBody.messages.some((m) => m.role === 'user' && m.content === '读一下 a.txt'), '聚合请求体：末条 user 原句')
  }

  console.log('\n[4] 聚合模型 tool_calls → tool_use 块 + stop_reason:\'tool_use\'（流式真实增量拼接）')
  {
    moaConfig.setMoaConfig({ mode: 'aggregate', subModels: SUB_MODELS, aggregator: { primaryModelId: 'agg-tools', primaryProviderId: 'prov-1' } })
    // 参数跨帧分片（'{"pa' + 'th":"a.txt"}'）——验证 tool_calls 增量按 index 累积
    mock.scripts.set('agg-tools', {
      toolFrames: [
        { index: 0, id: 'call_1', name: 'Read', arguments: '{"pa' },
        { index: 0, arguments: 'th":"a.txt"}' },
        { index: 1, id: 'call_2', name: 'Bash', arguments: '{"cmd":"ls"}' }
      ],
      gapMs: 30,
      usage: { prompt_tokens: 7, completion_tokens: 9 }
    })

    const mark = uiMark()
    const client = await messagesRequest(GW_PORT, { ...TOOLS_REQUEST, stream: true })
    const evts = uiSince(mark)

    eq(client.status, 200, 'HTTP 200')
    eq(textOf(client.raw), '', '子模型 tool_calls 不进最终响应（聚合无文本 → 无 text_delta）')
    eq(blockStarts(client.raw), [
      { type: 'text', text: '' },
      { type: 'tool_use', id: 'call_1', name: 'Read', input: {} },
      { type: 'tool_use', id: 'call_2', name: 'Bash', input: {} }
    ], 'content_block_start：空 text 块 + tool_use 块（id/name 原样）')
    const jsonDeltas = parseAnthropicSse(client.raw)
      .filter((e) => e.event === 'content_block_delta' && e.data?.delta?.type === 'input_json_delta')
    eq(jsonDeltas.map((e) => e.data.delta.partial_json), ['{"path":"a.txt"}', '{"cmd":"ls"}'],
      'input_json_delta 一次性完整 JSON（跨帧分片已拼接）')
    eq(messageDelta(client.raw)?.delta?.stop_reason, 'tool_use', "message_delta.stop_reason = 'tool_use'")
    eq(messageDelta(client.raw)?.usage, { input_tokens: 7, output_tokens: 9 }, 'message_delta.usage = 聚合模型用量')
    eq(eventNames(client.raw)[eventNames(client.raw).length - 1], 'message_stop', 'message_stop 收尾')
    eq(evts[evts.length - 1]?.channel, 'gateway:roundDone', 'UI 直播照常（roundDone 收尾）')

    // 同样脚本的非流式路径：tool_use 块 + stop_reason tool_use
    const client2 = await messagesRequest(GW_PORT, { ...TOOLS_REQUEST, stream: false })
    const body2 = JSON.parse(client2.raw)
    eq(body2.content, [
      { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a.txt' } },
      { type: 'tool_use', id: 'call_2', name: 'Bash', input: { cmd: 'ls' } }
    ], '非流式：content = tool_use 块（input 已解析）')
    eq(body2.stop_reason, 'tool_use', "非流式 stop_reason = 'tool_use'")
    eq(body2.usage, { input_tokens: 7, output_tokens: 9 }, '非流式 usage 来自聚合模型')
  }

  console.log('\n[5] 客户端断开 → abort 链路：聚合不发起 + roundDone aborted:true + 记账标注')
  {
    moaConfig.setMoaConfig({
      mode: 'aggregate',
      subModels: [
        { modelId: 'sub-slow-a', providerId: 'prov-1', order: 0 },
        { modelId: 'sub-slow-b', providerId: 'prov-1', order: 1 }
      ],
      aggregator: { primaryModelId: 'agg-dead', primaryProviderId: 'prov-1' }
    })
    mock.scripts.set('sub-slow-a', { frames: ['S1', 'S2'], gapMs: 400 })
    mock.scripts.set('sub-slow-b', { frames: ['T1', 'T2'], gapMs: 400 })
    mock.scripts.set('agg-dead', { frames: ['不应到达'] })

    const mark = uiMark()
    const aggBefore = mock.count('agg-dead')
    const clientPromise = messagesRequest(GW_PORT, { model: 'sub-slow-a', max_tokens: 256, stream: true, messages: [{ role: 'user', content: 'hi' }] }, { destroyAfterMs: 150 })
    await waitFor(() => mock.count('sub-slow-a') > 0, 2000)
    const client = await clientPromise
    ok(Boolean(client.error) || Boolean(client.closed), '客户端已断开（连接销毁）')

    const evts = uiSince(mark)
    const roundId = roundIdOf(evts)
    eq(evts[0]?.channel, 'gateway:roundStart', 'roundStart 已广播')
    const doneEvt = await waitFor(() => gw.broadcasts.slice(mark).find((e) => e.channel === 'gateway:roundDone' && e.payload.roundId === roundId), 3000)
    ok(Boolean(doneEvt), 'roundDone 已广播')
    eq(doneEvt?.payload.aborted, true, 'roundDone.aborted = true')
    eq(doneEvt?.payload.success, false, 'roundDone.success = false')
    eq(mock.count('agg-dead') - aggBefore, 0, '聚合请求零发起（abort 短路）')
    eq(chanCount(gw.broadcasts.slice(mark), 'gateway:aggStart'), 0, '无 aggStart 事件')
    const subEvts = gw.broadcasts.slice(mark).filter((e) => e.channel === 'gateway:subUpdate')
    ok(subEvts.some((e) => e.payload.status === 'error' && String(e.payload.error || '').includes('已中止')),
      '子模型终态标注「已中止」（保留已收文本）')
    const log = gw.dbLogs.filter((l) => String(l.sql).includes('request_logs')).pop()
    ok(Boolean(log) && log.params[8] === 0 && String(log.params[9]).includes('客户端断开中止'),
      '记账：中止按已发生用量记 + error_detail 标注', log && log.params)
  }

  console.log('\n[6] 透传兜底（未配置子模型）：单模型透传 + Anthropic 事件转换 + extraBody（tools）透传')
  {
    moaConfig.setMoaConfig({ mode: 'direct', subModels: [], aggregator: null })
    mock.scripts.set('direct-1', { frames: ['直', '通'], gapMs: 70, usage: { prompt_tokens: 5, completion_tokens: 7 }, content: '非流式直通' })

    const mark = uiMark()
    const before = mock.count('direct-1')
    const client = await messagesRequest(GW_PORT, {
      model: 'direct-1',
      max_tokens: 512,
      stream: true,
      temperature: 0.2,
      tools: [{ name: 'Read', description: '读文件', input_schema: { type: 'object', properties: {} } }],
      messages: [{ role: 'user', content: 'hi' }]
    })
    const evts = uiSince(mark)

    eq(client.status, 200, 'HTTP 200')
    eq(mock.count('direct-1') - before, 1, '上游恰一次调用')
    const upBody = mock.lastBody('direct-1')
    eq(upBody.messages, [{ role: 'user', content: 'hi' }], '上游请求体：转换后的 messages')
    eq(upBody.temperature, 0.2, '上游请求体：temperature 透传')
    eq(upBody.tools?.[0]?.function?.name, 'Read', '上游请求体：tools 透传')
    eq(eventNames(client.raw), [
      'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
      'content_block_stop', 'message_delta', 'message_stop'
    ], '事件序列完整（direct 真流）')
    eq(textOf(client.raw), '直通', '文本增量拼接 = 上游全文')
    eq(messageDelta(client.raw)?.delta?.stop_reason, 'end_turn', 'direct stop_reason = end_turn')
    eq(messageDelta(client.raw)?.usage, { input_tokens: 5, output_tokens: 7 }, 'direct usage 来自上游终结帧')
    eq(evts[0]?.channel, 'gateway:roundStart', 'direct roundStart 已广播')
    eq(evts[0]?.payload.mode, 'direct', 'roundStart.mode = direct')
    eq(evts[0]?.payload.subModels, [{ index: 0, modelId: 'direct-1', role: '' }], 'direct 单模型清单')
    ok(evts.some((e) => e.channel === 'gateway:subUpdate' && e.payload.status === 'running'), 'direct running 直播')
    const term = evts.find((e) => e.channel === 'gateway:subUpdate' && e.payload.status === 'success')
    eq(term?.payload.content, '直通', 'direct 终态 content = 旁路累计全文')
    eq(evts[evts.length - 1]?.channel, 'gateway:roundDone', 'direct 以 roundDone 结束')

    // 非流式 direct
    const client2 = await messagesRequest(GW_PORT, { model: 'direct-1', max_tokens: 512, stream: false, messages: [{ role: 'user', content: 'hi' }] })
    const body2 = JSON.parse(client2.raw)
    eq(body2.content, [{ type: 'text', text: '非流式直通' }], '非流式 direct：JSON content = text 块')
    eq(body2.stop_reason, 'end_turn', '非流式 direct stop_reason = end_turn')
    eq(body2.usage, { input_tokens: 5, output_tokens: 7 }, '非流式 direct usage 来自上游 JSON')
  }

  console.log('\n[7] 失败未开流：Anthropic 错误 JSON（type:\'error\'，非 SSE 帧）')
  {
    moaConfig.setMoaConfig({
      mode: 'aggregate',
      subModels: [{ modelId: 'sub-dead2', providerId: 'prov-1', order: 0 }],
      aggregator: { primaryModelId: 'agg-1', primaryProviderId: 'prov-1' }
    })
    mock.scripts.set('sub-dead2', { httpStatus: 500 })

    const mark = uiMark()
    const client = await messagesRequest(GW_PORT, { model: 'sub-dead2', max_tokens: 256, stream: true, messages: [{ role: 'user', content: 'hi' }] })
    const evts = uiSince(mark)

    eq(client.status, 502, 'HTTP 502')
    ok(String(client.headers['content-type'] || '').includes('application/json'), 'content-type = application/json（SSE 头未泄漏）', client.headers['content-type'])
    ok(!client.raw.includes('event: '), '响应体非 SSE（无 event: 行）')
    const body = JSON.parse(client.raw)
    eq(body.type, 'error', "type = 'error'")
    eq(body.error.type, 'api_error', "error.type = 'api_error'")
    ok(typeof body.error.message === 'string' && body.error.message.length > 0, 'error.message 非空', body.error)
    eq(evts[evts.length - 1]?.channel, 'gateway:roundDone', '以 roundDone 结束')
    eq(evts[evts.length - 1]?.payload.success, false, 'roundDone.success = false')
  }

  console.log('\n[8] 聚合截断：聚合末帧 finish_reason=length → stop_reason max_tokens（T7-SF1）')
  {
    moaConfig.setMoaConfig({ mode: 'aggregate', subModels: SUB_MODELS, aggregator: { primaryModelId: 'agg-cut', primaryProviderId: 'prov-1' } })
    // content 供非流式 mock 直回；frames 供流式路径（同一 finishReason='length'）
    mock.scripts.set('agg-cut', { frames: ['截断稿'], content: '截断稿', finishReason: 'length', gapMs: 70, usage: { prompt_tokens: 4, completion_tokens: 5 } })

    const client = await messagesRequest(GW_PORT, { model: 'sub-a', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] })
    eq(client.status, 200, 'HTTP 200')
    eq(textOf(client.raw), '截断稿', '截断文本照常送达（真流）')
    eq(messageDelta(client.raw)?.delta?.stop_reason, 'max_tokens', "流式：聚合 finish_reason=length → message_delta.stop_reason = 'max_tokens'")
    eq(messageDelta(client.raw)?.usage, { input_tokens: 4, output_tokens: 5 }, 'message_delta.usage = 聚合模型用量')

    const client2 = await messagesRequest(GW_PORT, { model: 'sub-a', max_tokens: 100, stream: false, messages: [{ role: 'user', content: 'hi' }] })
    const body2 = JSON.parse(client2.raw)
    eq(body2.content, [{ type: 'text', text: '截断稿' }], '非流式 content = 聚合全文 text 块')
    eq(body2.stop_reason, 'max_tokens', "非流式：同样映射 'max_tokens'（此前恒 end_turn）")

    // toolCalls 优先于 length：有工具调用时仍为 tool_use
    moaConfig.setMoaConfig({ mode: 'aggregate', subModels: SUB_MODELS, aggregator: { primaryModelId: 'agg-cut-tools', primaryProviderId: 'prov-1' } })
    mock.scripts.set('agg-cut-tools', {
      toolFrames: [{ index: 0, id: 'cut_1', name: 'Read', arguments: '{\"p\":\"a\"}' }],
      finishReason: 'length',
      gapMs: 30,
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    })
    const client3 = await messagesRequest(GW_PORT, { model: 'sub-a', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] })
    eq(messageDelta(client3.raw)?.delta?.stop_reason, 'tool_use', '有 toolCalls 时 tool_use 优先于 length')
  }

  console.log('\n[9] 聚合工具帧多 index 交织：分片按 index 归并、后到 name 不覆盖（T7-SF2①）')
  {
    moaConfig.setMoaConfig({ mode: 'aggregate', subModels: SUB_MODELS, aggregator: { primaryModelId: 'agg-inter', primaryProviderId: 'prov-1' } })
    // 交织：idx0 首片 → idx1 整条 → idx0 尾片 → idx0 补发 name（应被忽略）
    mock.scripts.set('agg-inter', {
      toolFrames: [
        { index: 0, id: 'tu_0', name: 'Write', arguments: '{\"file\":\"a' },
        { index: 1, id: 'tu_1', name: 'Bash', arguments: '{\"cmd\":\"ls\"}' },
        { index: 0, arguments: '.txt\",\"body\":\"hi\"}' },
        { index: 0, name: 'IGNORED', arguments: '' }
      ],
      gapMs: 40,
      usage: { prompt_tokens: 8, completion_tokens: 9 }
    })

    const client = await messagesRequest(GW_PORT, { model: 'sub-a', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] })
    eq(client.status, 200, 'HTTP 200')
    eq(textOf(client.raw), '', '聚合无文本 → 无 text_delta')
    eq(blockStarts(client.raw), [
      { type: 'text', text: '' },
      { type: 'tool_use', id: 'tu_0', name: 'Write', input: {} },
      { type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }
    ], 'tool_use 块顺序 + id/name（后到 name 未覆盖）')
    const jsonDeltas = parseAnthropicSse(client.raw)
      .filter((e) => e.event === 'content_block_delta' && e.data?.delta?.type === 'input_json_delta')
    eq(jsonDeltas.map((e) => e.data.delta.partial_json), ['{\"file\":\"a.txt\",\"body\":\"hi\"}', '{\"cmd\":\"ls\"}'],
      'input_json_delta = 交织分片拼接后的完整 JSON')
    eq(jsonDeltas.map((e) => e.data.index), [1, 2], 'input_json_delta 指向各自块 index')
    eq(eventNames(client.raw), [
      'message_start',
      'content_block_start', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'message_delta', 'message_stop'
    ], '事件序列严格顺序（块 start/stop 配对，start/stop 各恰一次）')
    eq(messageDelta(client.raw)?.delta?.stop_reason, 'tool_use', "stop_reason = 'tool_use'")
    eq(messageDelta(client.raw)?.usage, { input_tokens: 8, output_tokens: 9 }, 'usage = 聚合用量')
    ok(!client.raw.includes('[DONE]'), '无 OpenAI [DONE] 帧')
  }

  console.log('\n[10] 透传兜底非流式工具型上游：content:null + tool_calls → tool_use 块（T7-SF2②）')
  {
    moaConfig.setMoaConfig({ mode: 'direct', subModels: [], aggregator: null })
    mock.scripts.set('direct-tc', {
      toolFrames: [{ index: 0, id: 'c1', name: 'Read', arguments: '{\"path\":\"x.ts\"}' }],
      usage: { prompt_tokens: 2, completion_tokens: 3 }
    })

    const client = await messagesRequest(GW_PORT, { model: 'direct-tc', max_tokens: 100, stream: false, messages: [{ role: 'user', content: 'hi' }] })
    eq(client.status, 200, 'HTTP 200')
    const body = JSON.parse(client.raw)
    eq(body.type, 'message', "type = 'message'")
    eq(body.content, [{ type: 'tool_use', id: 'c1', name: 'Read', input: { path: 'x.ts' } }],
      'content:null + tool_calls → 仅 tool_use 块（无空文本块）')
    eq(body.stop_reason, 'tool_use', "stop_reason = 'tool_use'")
    eq(body.usage, { input_tokens: 2, output_tokens: 3 }, 'usage 来自上游 JSON')
  }

  console.log('\n[11] 旧配置残留 mode:\'compare\'：模式不可配置，网关仍按聚合执行（Anthropic 端点同语义）')
  {
    moaConfig.setMoaConfig({ mode: 'compare', subModels: SUB_MODELS, aggregator: { primaryModelId: 'agg-1', primaryProviderId: 'prov-1' } })

    const mark = uiMark()
    const client = await messagesRequest(GW_PORT, { model: 'sub-a', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] })
    const evts = uiSince(mark)
    eq(client.status, 200, 'HTTP 200')
    eq(textOf(client.raw), '聚合结果', '残留 compare 被忽略：文本 = 聚合全文（唯一最终答案）')
    eq(messageStart(client.raw)?.message?.model, 'moa-aggregated', 'message_start.message.model = moa-aggregated')
    eq(messageDelta(client.raw)?.delta?.stop_reason, 'end_turn', 'stop_reason = end_turn')
    eq(chanCount(evts, 'gateway:aggStart'), 1, '聚合确实发生：恰一次 aggStart')
    eq(evts[evts.length - 1]?.channel, 'gateway:roundDone', '以 roundDone 收尾')
    eq(evts[evts.length - 1]?.payload.success, true, 'roundDone.success = true')
  }

  console.log('\n[12] 透传兜底断开与上游失败：上游恰一次 + 连接被取消 + 错误体（T7-SF2④）')
  {
    moaConfig.setMoaConfig({ mode: 'direct', subModels: [], aggregator: null })

    // 上游失败：502 Anthropic 错误 JSON + roundDone error（非 SSE）
    mock.scripts.set('direct-fail', { httpStatus: 503 })
    const markFail = uiMark()
    const clientFail = await messagesRequest(GW_PORT, { model: 'direct-fail', max_tokens: 50, stream: false, messages: [{ role: 'user', content: 'h' }] })
    eq(clientFail.status, 502, '上游 503 → 网关 502')
    const bodyFail = JSON.parse(clientFail.raw)
    eq(bodyFail.type, 'error', "错误体 type = 'error'")
    ok(String(bodyFail.error?.message).includes('503'), '错误信息含上游状态', bodyFail.error)
    const evtsFail = uiSince(markFail)
    eq(evtsFail[evtsFail.length - 1]?.channel, 'gateway:roundDone', 'roundDone 收尾')
    eq(evtsFail[evtsFail.length - 1]?.payload.success, false, 'roundDone.success = false')

    // 客户端中途断开：上游恰一次调用 + 上游连接被取消（socket 关闭）+ roundDone success:false
    mock.scripts.set('direct-slow', { frames: ['慢1', '慢2', '慢3'], gapMs: 400 })
    const markAbort = uiMark()
    const beforeAbort = mock.count('direct-slow')
    const clientPromise = messagesRequest(GW_PORT, { model: 'direct-slow', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'h' }] }, { destroyAfterMs: 150 })
    await waitFor(() => mock.count('direct-slow') > beforeAbort, 2000)
    const clientAbort = await clientPromise
    ok(Boolean(clientAbort.error) || Boolean(clientAbort.closed), '客户端已断开（连接销毁）')
    const doneEvt = await waitFor(() => gw.broadcasts.slice(markAbort).find((e) => e.channel === 'gateway:roundDone'), 3000)
    ok(Boolean(doneEvt), 'roundDone 已广播')
    eq(doneEvt?.payload.success, false, '提前断开 → roundDone.success = false')
    eq(mock.count('direct-slow') - beforeAbort, 1, '上游恰一次调用（未重发）')
    await waitFor(() => mock.closed.includes('direct-slow'), 1500)
    ok(mock.closed.includes('direct-slow'), '上游连接被取消（socket 关闭）', mock.closed)
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
