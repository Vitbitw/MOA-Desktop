// 冒烟测试：src/main/moa/streamChat.ts + src/main/moa/subModelCaller.ts 的流式调用层
// （SSE 收流 / 回退链 / 三档超时 / abort 组合 / 200 直回 JSON 本地抢救 / T7：extraBody 透传 + tool_calls 增量收集）
// 用法：node test-e2e/stream-call.cjs
// 加载方式：esbuild bundle 两个 TS 入口（同 sse-parser.cjs 思路），'../local/fetchProxy' 用 esbuild plugin
//          替换为 stub（直接走全局 fetch）——fetchProxy 真实实现依赖 Electron/DB（读代理设置），测试不依赖它。
//          上游用 node:http mock（本地回环），不依赖真实网络/外部服务。（plugin 需异步 build API，模块在用例前加载）
// 返回码：全部通过 0，有失败 1
const path = require('path')
const http = require('http')

// ── 模块加载（esbuild bundle + fetchProxy stub） ──

async function loadBundle(tsFile) {
  let esbuild
  try {
    esbuild = require('esbuild')
  } catch {
    throw new Error('缺少 esbuild（随 vite 安装）：请在项目根目录执行 npm i 后再跑本脚本')
  }
  const result = await esbuild.build({
    entryPoints: [tsFile],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'silent',
    plugins: [
      {
        name: 'stub-fetch-proxy',
        setup(build) {
          build.onResolve({ filter: /(^|\/)fetchProxy$/ }, () => ({ path: 'fetchProxy-stub', namespace: 'stub-fetch-proxy' }))
          build.onLoad({ filter: /.*/, namespace: 'stub-fetch-proxy' }, () => ({
            contents: 'export function fetchProxy(url, init) { return fetch(url, init) }\n',
            loader: 'js'
          }))
        }
      }
    ]
  })
  const js = result.outputFiles[0].text
  const mod = { exports: {} }
  new Function('exports', 'module', 'require', js)(mod.exports, mod, require)
  return mod.exports
}

let streamChat = null
let callSubModelStream = null

// ── mock 上游（node:http，逐场景行为） ──

const frameOf = (content) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] }) + '\n\n'
const FINISH_FRAME = 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n'
const USAGE_FRAME = 'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + '\n\n'
const DONE_FRAME = 'data: [DONE]\n\n'

/** 延迟回调（unref：不阻塞脚本退出） */
const hold = (fn, ms) => setTimeout(fn, ms).unref()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** 轮询等待条件成立（超时返回最终值） */
const waitFor = async (fn, ms) => {
  const t0 = Date.now()
  while (!fn() && Date.now() - t0 < ms) await sleep(5)
  return fn()
}

/** 请求日志：{ scenario, body }（按调用区间切片断言） */
const requestLog = []

/** 修复 A 探针：回退请求是否到达 / 是否在 socket 层被客户端真实中止 */
const serverProbe = { fallbackReached: false, fallbackAborted: false }

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}

function startSse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
}

/** 各场景的服务端行为（scenario = URL 第一段路径） */
async function handle(scenario, body, res) {
  // stream_options 不被识别：带 stream_options 即 400（去掉后走下方 normal 流）
  if (scenario === 'opts-unsupported' && body.stream_options) {
    return sendJson(res, 400, { error: { message: 'unknown parameter: stream_options' } })
  }
  // 中转不支持流式：任何流式请求 400；非流式正常返回 JSON
  if (scenario === 'stream-unsupported' && body.stream) {
    return sendJson(res, 400, { error: { message: 'stream is not supported' } })
  }
  if (scenario === 'stream-unsupported') {
    return sendJson(res, 200, {
      choices: [{ message: { role: 'assistant', content: '非流式回退成功' } }],
      usage: { prompt_tokens: 3, completion_tokens: 7 }
    })
  }
  if (scenario === 'http-500') {
    return sendJson(res, 500, { error: { message: 'boom' } })
  }
  // 忽略 stream:true 的中转：任何请求都返回 200 + JSON（响应体不是 SSE）
  if (scenario === 'json-200') {
    return sendJson(res, 200, {
      choices: [{ message: { role: 'assistant', content: 'JSON 直回内容' } }],
      usage: { prompt_tokens: 8, completion_tokens: 2 }
    })
  }
  // 同上但无 usage：抢救成功时同样不写假 0
  if (scenario === 'json-200-no-usage') {
    return sendJson(res, 200, {
      choices: [{ message: { role: 'assistant', content: '无 usage 直回' } }]
    })
  }
  // 200 直回非 JSON 垃圾（流式）；非流式请求正常返回 JSON（验证抢救失败 → 重发回退）
  if (scenario === 'garbage-200') {
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      return res.end('<html>502 bad gateway page</html>')
    }
    return sendJson(res, 200, {
      choices: [{ message: { role: 'assistant', content: '重发救回内容' } }],
      usage: { prompt_tokens: 4, completion_tokens: 9 }
    })
  }
  // 200 直回超过 2MB 的非 JSON 垃圾：超过抢救上限 → 放弃抢救走重发回退
  if (scenario === 'huge-200') {
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      return res.end('x'.repeat(2 * 1024 * 1024 + 64 * 1024))
    }
    return sendJson(res, 200, {
      choices: [{ message: { role: 'assistant', content: '超限后重发救回' } }]
    })
  }
  // 修复 A：流式被 400 拒绝，非流式回退慢响应（1500ms）；客户端在回退请求到达后 abort
  if (scenario === 'slow-fallback') {
    if (body.stream) return sendJson(res, 400, { error: { message: 'stream is not supported' } })
    serverProbe.fallbackReached = true
    const timer = hold(() => {
      try {
        sendJson(res, 200, {
          choices: [{ message: { role: 'assistant', content: '回退慢响应' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      } catch {
        /* 客户端已中止 */
      }
    }, 1500)
    res.on('close', () => {
      clearTimeout(timer)
      if (!res.writableEnded) serverProbe.fallbackAborted = true
    })
    return
  }
  // 200 但 0 字节：自然结束
  if (scenario === 'empty') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    return res.end()
  }
  // 迟迟不发响应头：TTFT 超时应在首个字节前触发（服务端延迟 800ms）
  if (scenario === 'ttft') {
    hold(() => {
      try {
        startSse(res)
        res.write(frameOf('迟到的内容'))
        res.end()
      } catch {
        /* 客户端已中止 */
      }
    }, 800)
    return
  }
  // 写一半 destroy：200 后流中途断开（无 [DONE]）
  if (scenario === 'mid-cut') {
    startSse(res)
    res.write(frameOf('前半'))
    res.write(frameOf('内容'))
    await sleep(80) // 等两帧到达客户端
    res.destroy()
    return
  }
  // 首帧后长期无字节：idle 超时场景（客户端在收到首帧后 abort）
  if (scenario === 'abort') {
    startSse(res)
    res.write(frameOf('甲'))
    await sleep(400)
    try {
      res.write(frameOf('乙'))
    } catch {
      /* 客户端已断开 */
    }
    return
  }
  // 首帧后不再有任何字节：idle 超时
  if (scenario === 'idle') {
    startSse(res)
    res.write(frameOf('文'))
    return
  }
  // 每 60ms 一帧持续输出：验证总上限（idle 不会触发）
  if (scenario === 'max') {
    startSse(res)
    let n = 0
    const timer = setInterval(() => {
      try {
        res.write(frameOf(String(++n)))
      } catch {
        /* 客户端已断开 */
      }
    }, 60)
    res.on('close', () => clearInterval(timer))
    return
  }
  // 每 100ms 一帧、共 5 帧：间隔 < idle 但总时长 > idle → 只有 idle 每次 chunk 重置才能成功
  if (scenario === 'slow') {
    startSse(res)
    let n = 0
    const timer = setInterval(() => {
      try {
        res.write(frameOf(String(++n)))
        if (n === 5) {
          clearInterval(timer)
          res.write(FINISH_FRAME)
          res.write(DONE_FRAME)
          res.end()
        }
      } catch {
        /* 客户端已断开 */
      }
    }, 100)
    res.on('close', () => clearInterval(timer))
    return
  }
  // 无 [DONE] 且无 usage 帧：内容帧 + finish 后直接 end（自然结束）
  if (scenario === 'no-done') {
    startSse(res)
    res.write(frameOf('你'))
    res.write(frameOf('好'))
    res.write(FINISH_FRAME)
    res.end()
    return
  }
  // T7：tool_calls 增量（跨帧分片：index 0 分两条拼接，index 1 一次给全）+ 文本混合
  if (scenario === 'tools') {
    startSse(res)
    res.write(frameOf('我来'))
    res.write(
      'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"pa' } }] }, finish_reason: null }] }) + '\n\n'
    )
    await sleep(20)
    res.write(
      'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }, finish_reason: null }] }) + '\n\n'
    )
    res.write(
      'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } }] }, finish_reason: null }] }) + '\n\n'
    )
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n')
    res.write(USAGE_FRAME)
    res.write(DONE_FRAME)
    res.end()
    return
  }
  // T7：中转忽略 stream:true 直回 JSON，且 content 为 null（仅 tool_calls）→ 本地抢救路径
  if (scenario === 'tools-json') {
    return sendJson(res, 200, {
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'Glob', arguments: '{"pattern":"*.ts"}' } }]
        }
      }],
      usage: { prompt_tokens: 2, completion_tokens: 3 }
    })
  }
  // normal（含 opts-unsupported 重发）：两帧 + finish + usage 终结帧 + [DONE]；
  // [DONE] 后故意不关连接 → 客户端应收到 [DONE] 即停止读取
  startSse(res)
  res.write(frameOf('你'))
  await sleep(20)
  res.write(frameOf('好'))
  res.write(FINISH_FRAME)
  res.write(USAGE_FRAME)
  res.write(DONE_FRAME)
  hold(() => {
    try {
      res.end()
    } catch {
      /* ignore */
    }
  }, 3000)
}

const server = http.createServer((req, res) => {
  res.on('error', () => {}) // 客户端断开后的 write 错误忽略
  let raw = ''
  req.on('error', () => {})
  req.on('data', (chunk) => {
    raw += chunk
  })
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      /* 非 JSON 请求体 */
    }
    const scenario = (req.url || '/').split('?')[0].split('/')[1] || ''
    requestLog.push({ scenario, body })
    handle(scenario, body, res).catch(() => {
      try {
        res.destroy()
      } catch {
        /* ignore */
      }
    })
  })
})
server.on('clientError', (err, socket) => {
  try {
    socket.destroy()
  } catch {
    /* ignore */
  }
})

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
/** 捕获 console.warn 运行 fn（抢救失败日志断言 + 防测试输出噪声） */
async function captureWarns(fn) {
  const warns = []
  const orig = console.warn
  console.warn = (...args) => warns.push(args.join(' '))
  try {
    const value = await fn()
    return { value, warns }
  } finally {
    console.warn = orig
  }
}

let PORT = 0
const baseUrl = (scenario) => `http://127.0.0.1:${PORT}/${scenario}`

/** callSubModelStream 的标准选项 */
const subOpts = (scenario, extra) =>
  Object.assign(
    {
      providerBaseUrl: baseUrl(scenario),
      providerId: 'mock-provider',
      apiKey: 'sk-test',
      modelId: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 5000
    },
    extra || {}
  )

/** streamChat 的标准选项 */
const chatOpts = (scenario, extra) =>
  Object.assign(
    {
      providerBaseUrl: baseUrl(scenario),
      apiKey: 'sk-test',
      modelId: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 5000
    },
    extra || {}
  )

// ── 用例 ──

;(async () => {
  const streamChatMod = await loadBundle(path.resolve(__dirname, '../src/main/moa/streamChat.ts'))
  const callerMod = await loadBundle(path.resolve(__dirname, '../src/main/moa/subModelCaller.ts'))
  streamChat = streamChatMod.streamChat
  callSubModelStream = callerMod.callSubModelStream

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  PORT = server.address().port

  console.log('\n[1] 正常 SSE 流（多帧）：onDelta 累计序列 + content/usage')
  {
    const before = requestLog.length
    const deltas = []
    const t0 = Date.now()
    const out = await callSubModelStream(subOpts('normal', { onDelta: (acc) => deltas.push(acc) }))
    const elapsed = Date.now() - t0
    const used = requestLog.slice(before)
    eq(deltas, ['你', '你好'], 'onDelta 逐帧回调累计全文')
    eq(out.status, 'success', 'status = success')
    eq(out.content, '你好', 'content = 全文拼接')
    eq(out.tokenUsage, { prompt: 10, completion: 5 }, 'usage 从终结帧提取')
    eq('error' in out, false, '成功时无 error 字段')
    eq(used.length, 1, '单次请求成功（未触发回退）')
    eq(used[0].body.stream, true, '请求 stream:true')
    eq(used[0].body.stream_options, { include_usage: true }, '请求 stream_options.include_usage')
    ok(elapsed < 1500, '[DONE] 后立即停止读取，不等服务端关闭连接（' + elapsed + 'ms）')
  }

  console.log('\n[2] stream_options 400 → 去掉 stream_options 重发成功')
  {
    const before = requestLog.length
    const deltas = []
    const out = await callSubModelStream(subOpts('opts-unsupported', { onDelta: (acc) => deltas.push(acc) }))
    const used = requestLog.slice(before)
    eq(out.status, 'success', '重发后成功')
    eq(out.content, '你好', 'content 来自重发后的流')
    eq(deltas, ['你', '你好'], '重发的流照常触发 onDelta')
    eq(used.length, 2, '恰好两次请求（400 → 重发）')
    eq(used[0].body.stream_options, { include_usage: true }, '第一次带 stream_options')
    eq(used[1].body.stream === true && used[1].body.stream_options === undefined, true, '第二次 stream:true 且无 stream_options')
  }

  console.log('\n[3] stream:true 400 → 回退非流式（callSubModelStream 经 callSubModel）')
  {
    const before = requestLog.length
    const out = await callSubModelStream(subOpts('stream-unsupported'))
    const used = requestLog.slice(before)
    eq(out.status, 'success', '非流式回退成功')
    eq(out.content, '非流式回退成功', 'content 来自非流式 JSON')
    eq(out.tokenUsage, { prompt: 3, completion: 7 }, 'usage 从非流式响应映射')
    eq(used.length, 3, '三级链：stream+options → stream → 非流式')
    eq(used[1].body.stream, true, '第二次仍为流式（无 options）')
    eq(used[2].body.stream, false, '第三次为非流式请求')
  }

  console.log('\n[3b] stream:true 400 → streamChat 内置非流式回退（callAggregator 路径）')
  {
    const before = requestLog.length
    const r = await streamChat(chatOpts('stream-unsupported'))
    const used = requestLog.slice(before)
    eq(r, { content: '非流式回退成功', usage: { prompt: 3, completion: 7 } }, '内置回退结果：content + usage')
    eq(used.length, 3, '同样三级链（无 nonStreamFallback 钩子时走内置 JSON 请求）')
  }

  console.log('\n[3c] 200 但不是 SSE（中转忽略 stream:true 直回 JSON）→ 本地抢救：零额外请求保住内容与 usage')
  {
    const before = requestLog.length
    const out = await callSubModelStream(subOpts('json-200'))
    const used = requestLog.slice(before)
    eq(out.status, 'success', '抢救成功（不再静默返回空文本）')
    eq(out.content, 'JSON 直回内容', 'content 取自直回 JSON 体')
    eq(out.tokenUsage, { prompt: 8, completion: 2 }, '第一次请求的 usage 直接保住')
    eq('error' in out, false, '成功时无 error 字段')
    eq(used.length, 1, '只发 1 次请求（直回 JSON 即完整响应，零重发）')

    const before2 = requestLog.length
    const r = await streamChat(chatOpts('json-200'))
    eq(r, { content: 'JSON 直回内容', usage: { prompt: 8, completion: 2 } }, 'streamChat 内置路径同样本地抢救')
    eq(requestLog.length - before2, 1, '内置路径同样只 1 次请求')

    const before3 = requestLog.length
    const out3 = await callSubModelStream(subOpts('json-200-no-usage'))
    eq(out3.content, '无 usage 直回', '无 usage 的直回 JSON 同样抢救成功')
    eq('tokenUsage' in out3, false, '无 usage 时不写假 0（字段省略）')
    eq(requestLog.length - before3, 1, '仍只 1 次请求')
  }

  console.log('\n[3d] 200 直回非 JSON 垃圾 → 抢救失败：重发非流式 + warn 日志')
  {
    const before = requestLog.length
    const { value: out, warns } = await captureWarns(() => callSubModelStream(subOpts('garbage-200')))
    const used = requestLog.slice(before)
    eq(out.status, 'success', '重发回退成功')
    eq(out.content, '重发救回内容', 'content 来自非流式重发响应')
    eq(out.tokenUsage, { prompt: 4, completion: 9 }, 'usage 来自重发响应')
    eq(used.length, 2, '抢救失败 → 重发一次（2 次请求）')
    eq(used[1].body.stream, false, '第二次为非流式请求')
    eq(warns.length, 1, '恰好 1 条抢救失败 warn')
    ok(warns[0] && warns[0].includes('抢救失败'), 'warn 标注抢救失败原因（' + (warns[0] || '') + '）')

    const before2 = requestLog.length
    const { value: r, warns: warns2 } = await captureWarns(() => streamChat(chatOpts('garbage-200')))
    eq(r, { content: '重发救回内容', usage: { prompt: 4, completion: 9 } }, 'streamChat 内置路径同样重发取回')
    eq(requestLog.length - before2, 2, '内置路径同样 2 次请求')
    eq(warns2.length, 1, '内置路径同样 1 条 warn')
  }

  console.log('\n[3e] 200 直回超过 2MB 上限 → 放弃抢救：重发非流式')
  {
    const before = requestLog.length
    const { value: out, warns } = await captureWarns(() => callSubModelStream(subOpts('huge-200')))
    const used = requestLog.slice(before)
    eq(out.status, 'success', '重发回退成功')
    eq(out.content, '超限后重发救回', 'content 来自重发响应')
    eq(used.length, 2, '超限不抢救 → 重发一次（2 次请求）')
    ok(warns.length === 1 && warns[0].includes('上限'), 'warn 标注超上限原因（' + (warns[0] || '') + '）')
  }

  console.log('\n[4] HTTP 200 后流中途断开 → 不重试，保留已收文本 + error')
  {
    const before = requestLog.length
    const deltas = []
    const out = await callSubModelStream(subOpts('mid-cut', { onDelta: (acc) => deltas.push(acc) }))
    const used = requestLog.slice(before)
    eq(out.status, 'error', 'status = error')
    eq(out.content, '前半内容', '已收文本保留')
    eq(deltas, ['前半', '前半内容'], '断流前的增量已回调')
    ok(typeof out.error === 'string' && out.error.length > 0, 'error 非空（' + out.error + '）')
    ok(out.error.includes('流中断'), 'error 标注流中断')
    eq(used.length, 1, '断流不重试')
  }

  console.log('\n[5] 外部 signal 中止 → 保留已收文本 + error「已中止」')
  {
    const before = requestLog.length
    const ctrl = new AbortController()
    const deltas = []
    const out = await callSubModelStream(
      subOpts('abort', {
        signal: ctrl.signal,
        onDelta: (acc) => {
          deltas.push(acc)
          ctrl.abort()
        }
      })
    )
    const used = requestLog.slice(before)
    eq(out.content, '甲', '已收文本保留')
    eq(out.status, 'error', 'status = error')
    eq(out.error, '已中止', 'error = 已中止')
    eq(deltas, ['甲'], '中止后不再有增量')
    eq(used.length, 1, '中止不重试')

    const pre = new AbortController()
    pre.abort()
    const before2 = requestLog.length
    const out2 = await callSubModelStream(subOpts('abort', { signal: pre.signal }))
    eq(out2.error, '已中止', '调用前已 aborted → 直接返回已中止')
    eq(requestLog.length, before2, '已 aborted 不发起请求')
  }

  console.log('\n[6] 无 [DONE] 自然结束 → 成功；无 usage 帧 → tokenUsage 省略')
  {
    const out = await callSubModelStream(subOpts('no-done'))
    eq(out.status, 'success', '按成功处理')
    eq(out.content, '你好', 'content 完整')
    eq('tokenUsage' in out, false, '无 usage 时不写假 0（字段省略）')
    eq('error' in out, false, '无 error 字段')
  }

  console.log('\n[7] 空流（200 无任何字节）→ 按自然结束返回')
  {
    const out = await callSubModelStream(subOpts('empty'))
    eq(out.status, 'success', 'status = success')
    eq(out.content, '', 'content 为空串')
    eq('error' in out, false, '无 error')
  }

  console.log('\n[8] 三档超时之 TTFT：请求发出 → 首个 chunk')
  {
    const t0 = Date.now()
    const r = await streamChat(chatOpts('ttft', { timeoutMs: 200 }))
    const elapsed = Date.now() - t0
    ok(r.error === '首块响应超时（200ms）', 'error = 首块响应超时（实际 ' + r.error + '）', r)
    eq(r.content, '', '无已收文本')
    ok(elapsed < 700, '在服务端响应头到达前中止（' + elapsed + 'ms < 800ms）')
  }

  console.log('\n[9] 三档超时之 idle：chunk 间隔，且每次 chunk 重置')
  {
    const r = await streamChat(chatOpts('idle', { timeoutMs: 2000, idleTimeoutMs: 200 }))
    ok(r.error === '流空闲超时（200ms）', 'error = 流空闲超时（实际 ' + r.error + '）', r)
    eq(r.content, '文', '首帧已收文本保留')

    // slow：每 100ms 一帧共 5 帧，总时长 ~500ms > idle 200ms —— 只有逐 chunk 重置才不误杀
    const r2 = await streamChat(chatOpts('slow', { timeoutMs: 2000, idleTimeoutMs: 250 }))
    eq(r2.error, undefined, 'chunk 间隔 < idle：不被误杀（' + (r2.error || '无错误') + '）')
    eq(r2.content, '12345', '累计全文完整')
  }

  console.log('\n[10] 三档超时之总上限：绝对保护（持续输出也中断）')
  {
    const r = await streamChat(chatOpts('max', { timeoutMs: 2000, idleTimeoutMs: 5000, maxTimeoutMs: 250 }))
    ok(r.error === '流总时长超时（250ms）', 'error = 流总时长超时（实际 ' + r.error + '）', r)
    ok(/^\d+$/.test(r.content) && r.content.length >= 1, '持续流在总上限处中断，保留已收文本（' + r.content + '）')
  }

  console.log('\n[11] 非 400 错误不降级（单请求 + HTTP 错误透传）')
  {
    const before = requestLog.length
    const out = await callSubModelStream(subOpts('http-500'))
    const used = requestLog.slice(before)
    eq(used.length, 1, '不触发回退链')
    eq(out.status, 'error', 'status = error')
    eq(out.content, '', 'content 为空')
    ok(typeof out.error === 'string' && out.error.indexOf('HTTP 500') === 0, 'error 以 HTTP 500 开头（' + out.error + '）')
  }

  console.log('\n[12] AbortSignal.any 不可用 → 手写事件转发组合（兼容 fallback）')
  {
    const originalAny = AbortSignal.any
    AbortSignal.any = undefined
    try {
      ok(typeof AbortSignal.any === 'undefined', '已屏蔽 AbortSignal.any')
      const deltas = []
      const out = await callSubModelStream(subOpts('normal', { onDelta: (acc) => deltas.push(acc) }))
      eq(out.content, '你好', 'fallback 组合下正常收流')
      eq(deltas, ['你', '你好'], 'onDelta 正常')

      const ctrl = new AbortController()
      const r2 = await callSubModelStream(
        subOpts('abort', {
          signal: ctrl.signal,
          onDelta: () => ctrl.abort()
        })
      )
      eq(r2.error, '已中止', 'fallback 组合下外部中止同样生效')
      eq(r2.content, '甲', 'fallback 组合下保留已收文本')
    } finally {
      AbortSignal.any = originalAny
    }
  }

  console.log('\n[13] 修复 A：非流式回退链路透传外部 signal（回退中 abort → 快速返回「已中止」）')
  {
    // 钩子路径（callSubModelStream → callSubModel）：回退请求到达服务端后立即 abort
    serverProbe.fallbackReached = false
    serverProbe.fallbackAborted = false
    const before = requestLog.length
    const ctrl = new AbortController()
    const aborter = (async () => {
      await waitFor(() => serverProbe.fallbackReached, 3000)
      ctrl.abort()
    })()
    const t0 = Date.now()
    const out = await callSubModelStream(subOpts('slow-fallback', { signal: ctrl.signal }))
    const elapsed = Date.now() - t0
    await aborter
    const used = requestLog.slice(before)
    eq(used.length, 3, '三级链：回退非流式请求已发出（3 次请求）')
    eq(used[2].body.stream, false, '第 3 次为非流式请求')
    eq(out.status, 'error', 'status = error')
    eq(out.error, '已中止', 'error = 已中止（abort 透传到回退请求）')
    eq(out.content, '', 'content 保持为空（回退未产出文本）')
    eq('tokenUsage' in out, false, '中止时不写 usage')
    ok(elapsed < 800, '远早于服务端 1500ms 慢响应（实测 ' + elapsed + 'ms）')
    ok(await waitFor(() => serverProbe.fallbackAborted, 500), '回退请求在 socket 层被真实中止（未等慢响应写完）')

    // 内置路径（streamChat 无钩子 → requestNonStream）
    serverProbe.fallbackReached = false
    serverProbe.fallbackAborted = false
    const ctrl2 = new AbortController()
    const aborter2 = (async () => {
      await waitFor(() => serverProbe.fallbackReached, 3000)
      ctrl2.abort()
    })()
    const t1 = Date.now()
    const r = await streamChat(chatOpts('slow-fallback', { signal: ctrl2.signal }))
    const elapsed2 = Date.now() - t1
    await aborter2
    eq(r.error, '已中止', '内置非流式路径同样快速中止')
    ok(elapsed2 < 800, '内置路径远早于慢响应（实测 ' + elapsed2 + 'ms）')
    ok(await waitFor(() => serverProbe.fallbackAborted, 500), '内置路径回退请求同样被真实中止')
  }

  console.log('\n[14] 修复 A：AbortSignal.any 不可用 → 回退 abort 走手写转发同样生效')
  {
    const originalAny = AbortSignal.any
    AbortSignal.any = undefined
    try {
      serverProbe.fallbackReached = false
      serverProbe.fallbackAborted = false
      const ctrl = new AbortController()
      const aborter = (async () => {
        await waitFor(() => serverProbe.fallbackReached, 3000)
        ctrl.abort()
      })()
      const t0 = Date.now()
      const out = await callSubModelStream(subOpts('slow-fallback', { signal: ctrl.signal }))
      const elapsed = Date.now() - t0
      await aborter
      eq(out.error, '已中止', 'any 不可用时外部中止仍生效（手写事件转发）')
      ok(elapsed < 800, '快速返回（实测 ' + elapsed + 'ms）')
      ok(await waitFor(() => serverProbe.fallbackAborted, 500), '回退请求被真实中止')
    } finally {
      AbortSignal.any = originalAny
    }
  }

  console.log('\n[15] T7：extraBody 透传（tools/tool_choice/temperature）+ tool_calls 增量收集（向后兼容）')
  {
    // ① 无 extraBody / 无 tool_calls：返回值不带 toolCalls 字段（向后兼容）
    const plain = await streamChat(chatOpts('normal'))
    eq(plain.content, '你好', '常规调用内容不变')
    eq('toolCalls' in plain, false, '无工具调用时不返回 toolCalls 字段（向后兼容）')

    // ② extraBody 并入请求体（tools/tool_choice/temperature 透传；model/messages/stream 由本层统一）
    const before = requestLog.length
    const withTools = await streamChat(chatOpts('tools', {
      extraBody: {
        tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: {} } } }],
        tool_choice: 'auto',
        temperature: 0.4,
        // 恶意覆盖：model/messages/stream 以本层为准
        model: 'hijack',
        messages: [{ role: 'user', content: 'hijack' }],
        stream: false
      }
    }))
    const sent = requestLog.slice(before)
    eq(sent.length, 1, '单次请求（未触发回退）')
    eq(sent[0].body.model, 'mock-model', 'model 以本层为准（extraBody 同名被覆盖）')
    eq(sent[0].body.messages, [{ role: 'user', content: 'hi' }], 'messages 以本层为准')
    eq(sent[0].body.stream, true, 'stream 以本层为准')
    eq(sent[0].body.temperature, 0.4, 'temperature 透传')
    eq(sent[0].body.tool_choice, 'auto', 'tool_choice 透传')
    eq(sent[0].body.tools?.[0]?.function?.name, 'Read', 'tools 透传')
    eq(sent[0].body.stream_options, { include_usage: true }, 'stream_options 仍在')

    // ③ tool_calls 增量收集：按 index 归并（id/name 取首非空、arguments 逐帧拼接），顺序按 index 升序
    eq(withTools.content, '我来', '文本与工具调用并存')
    eq(withTools.toolCalls, [
      { id: 'call_1', name: 'Read', arguments: '{"path":"a.txt"}' },
      { id: 'call_2', name: 'Bash', arguments: '{"cmd":"ls"}' }
    ], 'tool_calls 增量按 index 累积（跨帧 arguments 拼接）')
    eq(withTools.usage, { prompt: 10, completion: 5 }, 'usage 照常提取')

    // ④ 非流式回退（200 直回 JSON、content:null + tool_calls）同样收集工具调用
    const viaSalvage = await streamChat(chatOpts('tools-json'))
    eq(viaSalvage.error, undefined, '直回 JSON 抢救成功（无错误）')
    eq(viaSalvage.content, '', 'content 缺省为空串')
    eq(viaSalvage.toolCalls, [{ id: 'call_9', name: 'Glob', arguments: '{"pattern":"*.ts"}' }], '抢救路径收集 tool_calls')
  }

  console.log('\n──────────────────────────────')
  console.log(`通过 ${pass} / 失败 ${fail}`)
  server.close()
  process.exit(fail === 0 ? 0 : 1)
})()
