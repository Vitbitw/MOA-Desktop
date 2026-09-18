// 行为测试：src/main/moa/sseReader.ts（SSE 流读取 + OpenAI chunk 解析）
// 用法：node test-e2e/sse-parser.cjs [path-to-sseReader.ts]
// 加载方式：esbuild 把 TS 现场转成 CJS 后执行（同 monitor-behavior.cjs 思路）
// 返回码：全部通过 0，有失败 1
const fs = require('fs')
const path = require('path')

const file = process.argv[2] || path.resolve(__dirname, '../src/main/moa/sseReader.ts')

function loadTsModule(tsFile) {
  const src = fs.readFileSync(tsFile, 'utf8')
  let esbuild
  try {
    esbuild = require('esbuild')
  } catch {
    throw new Error('缺少 esbuild（随 vite 安装）：请在项目根目录执行 npm i 后再跑本脚本')
  }
  const js = esbuild.transformSync(src, { loader: 'ts', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  new Function('exports', 'module', 'require', js)(mod.exports, mod, require)
  return mod.exports
}

const { readSseStream, parseOpenAIChunk } = loadTsModule(file)

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

const encoder = new TextEncoder()
const b = (s) => encoder.encode(s)
function joinBytes() {
  const parts = Array.prototype.slice.call(arguments)
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
/** 按需 enqueue 的字节流，模拟网络分块到达 */
function byteStream(chunks) {
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++])
      else controller.close()
    }
  })
}
/** 收集事件为 { data, event } 列表（event 未出现时为 undefined，JSON 比较时自动省略） */
async function collect(chunks) {
  const events = []
  await readSseStream(byteStream(chunks), (data, event) => events.push({ data, event }))
  return events
}
const collectText = (text) => collect([b(text)])
const dataOf = (events) => events.map((e) => e.data)

;(async () => {
  console.log('\n[1] 单事件单块与基础多事件流')
  {
    eq(dataOf(await collectText('data: hello\n\n')), ['hello'], '单事件单块')
    eq(dataOf(await collectText('data: a\n\ndata: b\n\n')), ['a', 'b'], '多事件按序交付')
    eq((await collectText('data: a\n\n'))[0], { data: 'a' }, '无 event 行 → 第二参为 undefined')
    eq(
      dataOf(await collectText('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')),
      ['{"choices":[{"delta":{"content":"hi"}}]}'],
      'JSON 原样透传（不在此层解析）'
    )
  }

  console.log('\n[2] 事件被切成两个 chunk（JSON 中间断开）')
  {
    const json = '{"choices":[{"delta":{"content":"你好"}}]}'
    const s = 'data: ' + json + '\n\n' + 'data: [DONE]\n\n'
    const raw = b(s)
    const ref = dataOf(await collectText(s))
    eq(ref, [json, '[DONE]'], '单块喂入：2 个事件')
    const cut = 6 + Math.floor(json.length / 2) // 'data: ' 之后进入 JSON 一半处
    eq(dataOf(await collect([raw.slice(0, cut), raw.slice(cut)])), ref, '切点落在 JSON 正中间')
    let bad = 0
    let firstBad = null
    for (let i = 1; i < raw.length; i++) {
      const got = dataOf(await collect([raw.slice(0, i), raw.slice(i)]))
      if (JSON.stringify(got) !== JSON.stringify(ref)) {
        bad++
        if (firstBad === null) firstBad = { at: i, got }
      }
    }
    ok(bad === 0, '穷举 ' + (raw.length - 1) + ' 个 2 段切点结果一致', firstBad)
    eq(
      dataOf(await collect([raw.slice(0, 3), raw.slice(3, 12), raw.slice(12)])),
      ref,
      '3 段切包（含中文 / 事件分隔中间）结果一致'
    )
  }

  console.log('\n[3] 多字节 UTF-8（中文）字节跨块')
  {
    const sample = 'data: 你好，世界\n\ndata: [DONE]\n\n'
    const raw = b(sample)
    const ref = ['你好，世界', '[DONE]']
    let bad = 0
    let firstBad = null
    for (let i = 1; i < raw.length; i++) {
      const got = dataOf(await collect([raw.slice(0, i), raw.slice(i)]))
      if (JSON.stringify(got) !== JSON.stringify(ref)) {
        bad++
        if (firstBad === null) firstBad = { at: i, got }
      }
    }
    ok(bad === 0, '穷举 ' + (raw.length - 1) + ' 个字节切点（含中文 3 字节被拦腰切断）均完整解码', firstBad)
    const got = dataOf(await collect([raw.slice(0, 9), raw.slice(9)]))
    ok(!got.join('').includes('\uFFFD'), '无替换字符（\\uFFFD）')

    const emoji = b('🌊 波浪')
    eq(
      dataOf(await collect([joinBytes(b('data: '), emoji.slice(0, 2)), joinBytes(emoji.slice(2), b('\n\n'))])),
      ['🌊 波浪'],
      '4 字节字符（emoji）被切断仍完整解码'
    )
  }

  console.log('\n[4] \\r\\n\\r\\n 事件分隔')
  {
    eq(dataOf(await collectText('data: a\r\n\r\ndata: b\r\n\r\n')), ['a', 'b'], '纯 CRLF 流切两个事件')
    eq(dataOf(await collectText('data: a\n\ndata: b\r\n\r\n')), ['a', 'b'], '混用 \\n / \\r\\n 也可切分')
    eq(dataOf(await collectText('data: a\n\r\ndata: b\r\n\n')), ['a', 'b'], '空行两侧行终止符混用')
    eq(dataOf(await collectText('data: a\rdata: b\r\r')), ['a\nb'], '孤立 \\r 也按行终止符处理')
    eq(dataOf(await collect([b('data: m\r'), b('\n\r\ndata: n\r\n\r\n')])), ['m', 'n'], 'chunk1 以孤立 \\r 结尾（\\r\\n 被切开）')
    eq(dataOf(await collect([b('data: p\r\n\r'), b('\ndata: q\r\n\r\n')])), ['p', 'q'], '切点落在 \\r\\n\\r\\n 正中间')
  }

  console.log('\n[5] 多行 data: 字段拼接')
  {
    eq(dataOf(await collectText('data: line1\ndata: line2\ndata: line3\n\n')), ['line1\nline2\nline3'], '三行 data 以 \\n 拼接为单个事件')
    eq(dataOf(await collectText('data: 第一行\r\ndata: 第二行\r\n\r\n')), ['第一行\n第二行'], 'CRLF 分隔的多行 data 同样拼接')
    eq(dataOf(await collect([b('data: p1\ndata: p2\n'), b('\ndata: next\n\n')])), ['p1\np2', 'next'], '多行 data 被切块不影响拼接')
    eq(dataOf(await collectText('data: with: colon\n\n')), ['with: colon'], '值内冒号保留（只剥第一个）')
    eq(dataOf(await collectText('data: one-space\n\n')), ['one-space'], '只去掉冒号后的一个前导空格')
    eq(dataOf(await collectText('data:  two-spaces\n\n')), [' two-spaces'], '第二个空格保留')
  }

  console.log('\n[6] event: 行提取')
  {
    const s = 'event: message_start\ndata: {"a":1}\n\n' + 'data: plain\n\n' + 'event: message_delta\ndata: {"b":2}\n\n'
    eq(
      await collectText(s),
      [{ data: '{"a":1}', event: 'message_start' }, { data: 'plain' }, { data: '{"b":2}', event: 'message_delta' }],
      '事件类型传给第二参，且不跨事件串台'
    )
    eq((await collectText('event: ping\n\n'))[0], undefined, '仅 event 无 data → 不派发')
    eq(await collectText(': comment\nevent: ping\n\n'), [], '注释行不产生事件')
    eq((await collectText('event: a\nevent: b\ndata: x\n\n'))[0], { data: 'x', event: 'b' }, '同事件多个 event 行以最后一个为准')
    eq((await collectText('event: x\ndata: y'))[0], { data: 'y', event: 'x' }, '缺结尾空行，event 仍随 data 交付')
    eq(await collectText('id: 42\nretry: 100\nevent: e\ndata: d\n\n'), [{ data: 'd', event: 'e' }], 'id:/retry: 字段忽略')
  }

  console.log('\n[7] [DONE] 原样透传')
  {
    const stream =
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n' +
      'data: [DONE]\n\n'
    const events = dataOf(await collectText(stream))
    eq(events, ['{"choices":[{"delta":{"content":"你"}}]}', '{"choices":[{"delta":{"content":"好"}}]}', '[DONE]'], '3 条事件按序交付，[DONE] 原样')
    eq(dataOf(await collectText('data: [DONE]')), ['[DONE]'], '无尾换行的 [DONE] 也交付（残余 buffer 收尾）')
    eq(parseOpenAIChunk('[DONE]'), null, 'parseOpenAIChunk 对 [DONE] 返回 null')
  }

  console.log('\n[8] 流结束的残余 buffer 收尾')
  {
    eq(dataOf(await collectText('data: no-blank-line\n')), ['no-blank-line'], '有换行、缺结尾空行 → 照常派发')
    eq(dataOf(await collectText('data: no-terminator')), ['no-terminator'], '整段无行终止符 → 残余视为最后一行')
    eq(dataOf(await collectText('data: complete\n\ndata: tail-part')), ['complete', 'tail-part'], '前一事件完整 + 尾部残余事件')
    eq(dataOf(await collectText('data:')), [], '尾部空 data 不派发')
    eq(dataOf(await collectText('data:\n\n')), [], '空 data 事件（非尾部）也不派发（SSE 规范）')
    eq(dataOf(await collect([b('data: a\n\n'), b('data: b')])), ['a', 'b'], '残余行跨块拼接后派发')
    eq(dataOf(await collectText('data: a\n\n: keep-alive')), ['a'], '尾部注释行忽略')
    eq(dataOf(await collectText('id: 9\nretry: 50\n')), [], '尾部未知字段忽略')
    eq(dataOf(await collectText('')), [], '空流不派发任何事件')
  }

  console.log('\n[9] 流中途报错：已交付的保留，异常照抛')
  {
    let s1Step = 0
    const s1 = new ReadableStream({
      pull(controller) {
        if (s1Step++ === 0) controller.enqueue(b('data: first\n\n'))
        else controller.error(new Error('boom'))
      }
    })
    const seen1 = []
    let err1 = null
    try {
      await readSseStream(s1, (d) => seen1.push(d))
    } catch (e) {
      err1 = e
    }
    eq(seen1, ['first'], '报错前已完整的事件已回调')
    ok(err1 && err1.message === 'boom', 'Promise 以流错误 reject（' + (err1 && err1.message) + '）')

    let s2Step = 0
    const s2 = new ReadableStream({
      pull(controller) {
        if (s2Step++ === 0) controller.enqueue(b('data: tail\n'))
        else controller.error(new Error('cut'))
      }
    })
    const seen2 = []
    let err2 = null
    try {
      await readSseStream(s2, (d) => seen2.push(d))
    } catch (e) {
      err2 = e
    }
    eq(seen2, ['tail'], '报错时已完整的尾部事件仍补发')
    ok(err2 && err2.message === 'cut', 'reject 原因透传')
  }

  console.log('\n[10] parseOpenAIChunk：delta / finish_reason / tool_calls / usage / 非法输入')
  {
    // 正常 delta
    eq(parseOpenAIChunk('{"choices":[{"delta":{"content":"你好"}}]}'), { content: '你好' }, 'choices[0].delta.content → content')
    eq(
      parseOpenAIChunk('{"id":"x","choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}'),
      { content: 'a' },
      '过程帧（finish_reason:null）只取 content'
    )
    eq(parseOpenAIChunk('{"choices":[{"delta":{"content":""}}]}'), { content: '' }, '空字符串 content 原样返回')

    // finish_reason
    eq(parseOpenAIChunk('{"choices":[{"delta":{},"finish_reason":"stop"}]}'), { finishReason: 'stop' }, 'finish_reason → finishReason')
    eq(
      parseOpenAIChunk('{"choices":[{"delta":{"content":"x"},"finish_reason":"length"}]}'),
      { content: 'x', finishReason: 'length' },
      'content + finish_reason 同时给出'
    )
    eq(parseOpenAIChunk('{"choices":[{"delta":{},"finish_reason":null}]}'), null, '仅 finish_reason:null → 无有效字段 → null')

    // tool_calls 增量（标准 OpenAI：name/arguments 嵌在 function 内）
    eq(
      parseOpenAIChunk('{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}'),
      { toolCallDelta: { index: 0, id: 'call_1', name: 'read_file', arguments: '' } },
      'tool_calls 首帧：index/id/name/arguments 保留'
    )
    eq(
      parseOpenAIChunk('{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"p\\":1}"}}]}}]}'),
      { toolCallDelta: { index: 0, arguments: '{"p":1}' } },
      'tool_calls 参数增量帧（无 id/name）'
    )
    eq(
      parseOpenAIChunk('{"choices":[{"delta":{"tool_calls":[{"index":1,"name":"flat","arguments":"{}"}]}}]}'),
      { toolCallDelta: { index: 1, name: 'flat', arguments: '{}' } },
      '平铺形态（部分兼容厂商）同样识别'
    )
    eq(
      parseOpenAIChunk('{"choices":[{"delta":{"tool_calls":[{"id":"c2"}]}}]}'),
      { toolCallDelta: { index: 0, id: 'c2' } },
      'index 缺失按 0 兜底'
    )
    eq(parseOpenAIChunk('{"choices":[{"delta":{"tool_calls":[]}}]}'), null, '空 tool_calls → null')
    eq(parseOpenAIChunk('{"choices":[{"delta":{"tool_calls":[{"index":0},{"index":1}]}}]}'), { toolCallDelta: { index: 0 } }, '多条目只取第一条')

    // usage 终结块
    eq(
      parseOpenAIChunk('{"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34}}'),
      { usage: { prompt: 12, completion: 34 } },
      '空 choices + usage → usage 终结块'
    )
    eq(
      parseOpenAIChunk('{"choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0}}'),
      { usage: { prompt: 0, completion: 0 } },
      'usage 真实 0 不丢'
    )
    eq(parseOpenAIChunk('{"choices":[],"usage":{"prompt_tokens":7}}'), { usage: { prompt: 7, completion: 0 } }, 'usage 缺字段按 0 兜底')
    eq(
      parseOpenAIChunk('{"choices":[],"usage":{"prompt_tokens":"9","completion_tokens":null}}'),
      { usage: { prompt: 0, completion: 0 } },
      '非数字 token 数 → 0'
    )

    // 非 JSON 行 / 空对象 / [DONE]
    eq(parseOpenAIChunk('[DONE]'), null, "'[DONE]' → null")
    eq(parseOpenAIChunk('{}'), null, '空对象 → null')
    eq(parseOpenAIChunk('{"choices":[{"delta":{"role":"assistant"}}]}'), null, '仅 role 的首帧 → null')
    eq(parseOpenAIChunk('garbage'), null, '非 JSON 行 → null')
    eq(parseOpenAIChunk(': ping'), null, '注释行 → null')
    eq(parseOpenAIChunk('{"choices":[{"delta":{"content":"x"}}]'), null, '截断 JSON → null（不抛异常）')
    eq(parseOpenAIChunk('{"choices":[]}'), null, '空 choices 无 usage → null')
    eq(parseOpenAIChunk('{"choices":[],"usage":null}'), null, 'usage=null → null')
    eq(parseOpenAIChunk('{"error":{"message":"bad"}}'), null, '错误帧 → null')
    eq(parseOpenAIChunk('null'), null, 'JSON null → null')
    eq(parseOpenAIChunk('"str"'), null, 'JSON 字符串 → null')
    eq(parseOpenAIChunk('[]'), null, 'JSON 数组 → null')
    eq(parseOpenAIChunk(''), null, '空字符串 → null')

    const weird = ['{', '}', '{"choices"', '{"choices":{}}', '{"choices":[[1]]}', '{"choices":[{"delta":1}]}', '{"choices":[{"tool_calls":[]}]}']
    let odd = null
    for (const w of weird) {
      try {
        const r = parseOpenAIChunk(w)
        if (r !== null && typeof r !== 'object') odd = { input: w, result: r }
      } catch (e) {
        odd = { input: w, threw: String(e && e.message) }
      }
    }
    ok(odd === null, '异常结构不抛错（返回 null 或对象）', odd)
  }

  console.log('\n[11] 端到端：readSseStream + parseOpenAIChunk 组合')
  {
    // 最后一帧 [DONE] 故意不带结尾空行，验证残余 buffer 收尾
    const stream = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      'data: {"choices":[{"delta":{"content":"索"}}]}',
      'data: {"choices":[{"delta":{"content":"引"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"p\\":1}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
      'data: [DONE]'
    ].join('\n\n')
    const events = await collectText(stream)
    let text = ''
    let toolName = ''
    let toolArgs = ''
    let finish = null
    let usage = null
    let nullCount = 0
    for (const e of events) {
      if (e.data === '[DONE]') continue
      const chunk = parseOpenAIChunk(e.data)
      if (chunk === null) {
        nullCount++
        continue
      }
      if (chunk.content) text += chunk.content
      if (chunk.toolCallDelta) {
        if (chunk.toolCallDelta.name) toolName += chunk.toolCallDelta.name
        if (chunk.toolCallDelta.arguments) toolArgs += chunk.toolCallDelta.arguments
      }
      if (chunk.finishReason) finish = chunk.finishReason
      if (chunk.usage) usage = chunk.usage
    }
    eq(events.length, 8, '8 条事件全部交付（实际 ' + events.length + '）')
    eq(text, '索引', 'delta 拼接出聚合全文')
    eq(toolName, 'read_file', 'tool_calls 名称提取')
    eq(toolArgs, '{"p":1}', 'tool_calls 参数增量拼接')
    eq(finish, 'tool_calls', 'finish_reason 提取')
    eq(usage, { prompt: 10, completion: 2 }, 'usage 终结块提取')
    eq(nullCount, 1, 'role 首帧（无有效字段）→ null 跳过')
    eq(events[events.length - 1].data, '[DONE]', '[DONE] 是最后一个事件')
  }

  console.log('\n──────────────────────────────')
  console.log(`通过 ${pass} / 失败 ${fail}`)
  process.exit(fail === 0 ? 0 : 1)
})()
