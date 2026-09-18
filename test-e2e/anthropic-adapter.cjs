// 行为测试：src/main/gateway/anthropicAdapter.ts（Anthropic Messages ↔ OpenAI 双向转换 + Anthropic SSE 事件生成）
// 用法：node test-e2e/anthropic-adapter.cjs [path-to-anthropicAdapter.ts]
// 加载方式：esbuild transformSync 现场转 CJS（适配器零依赖、无相对 import，可直接 transform）
// 返回码：全部通过 0，有失败 1
const fs = require('fs')
const path = require('path')

const file = process.argv[2] || path.resolve(__dirname, '../src/main/gateway/anthropicAdapter.ts')

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

const adapter = loadTsModule(file)
const { anthropicToOpenAI, openAIToAnthropic, anthropicStreamEvents, createAnthropicStreamState, formatAnthropicSse, anthropicStopReason, parseToolInput } = adapter

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
/** 取转换后消息中最后一个该 role 的消息（顺序断言辅助） */
const rolesOf = (messages) => messages.map((m) => m.role)

;(async () => {
  console.log('\n[1] anthropicToOpenAI：system / 文本 / 多块拼接')
  {
    const r1 = anthropicToOpenAI({
      model: 'claude-sonnet-4',
      max_tokens: 1024,
      stream: true,
      system: '你是助手',
      messages: [{ role: 'user', content: '你好' }]
    })
    eq(r1.messages[0], { role: 'system', content: '你是助手' }, 'system 字符串 → 首条 system 消息')
    eq(r1.messages[1], { role: 'user', content: '你好' }, '纯文本 user 消息原样')
    eq(rolesOf(r1.messages), ['system', 'user'], '消息顺序 system → user')

    const r2 = anthropicToOpenAI({
      system: [
        { type: 'text', text: '第一段' },
        { type: 'text', text: '第二段', cache_control: { type: 'ephemeral' } }
      ],
      messages: []
    })
    eq(r2.messages, [{ role: 'system', content: '第一段\n\n第二段' }], 'system blocks 拼接（忽略 cache_control）')

    const r3 = anthropicToOpenAI({
      messages: [{ role: 'user', content: [{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }] }]
    })
    eq(r3.messages, [{ role: 'user', content: '甲\n\n乙' }], '单条消息多个 text 块拼接为字符串')

    const r4 = anthropicToOpenAI({ messages: [{ role: 'user', content: '' }, { role: 'assistant', content: 'x' }] })
    eq(rolesOf(r4.messages), ['assistant'], '空字符串 content 消息丢弃')

    eq(anthropicToOpenAI(null), { messages: [], extraBody: {} }, '非对象 body → 空转换结果（不抛错）')
    eq(anthropicToOpenAI({ messages: 'garbage' }).messages, [], '非法 messages → 空数组（不抛错）')
    eq(anthropicToOpenAI({ system: '' }).messages, [], '空 system 不产出 system 消息')
  }

  console.log('\n[2] anthropicToOpenAI：image / tool_use / tool_result / 混合内容拆分')
  {
    const r = anthropicToOpenAI({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA=' } },
            { type: 'text', text: '看图' }
          ]
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '我来读文件' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.txt' } }
          ]
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: '文件内容' },
            { type: 'text', text: '继续' }
          ]
        }
      ]
    })
    eq(r.messages[0], {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA=' } },
        { type: 'text', text: '看图' }
      ]
    }, 'base64 image → image_url（data URI，含图片时用内容块数组）')
    eq(r.messages[1], {
      role: 'assistant',
      content: '我来读文件',
      tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'Read', arguments: '{"path":"a.txt"}' } }]
    }, 'tool_use 并入 assistant 消息 tool_calls（与文本同条）')
    eq(r.messages[2], { role: 'tool', tool_call_id: 'toolu_1', content: '文件内容' }, 'tool_result → role:tool 消息')
    eq(r.messages[3], { role: 'user', content: '继续' }, 'tool_result 后的文本块独立成 user 消息（顺序保持）')
    eq(rolesOf(r.messages), ['user', 'assistant', 'tool', 'user'], '混合内容消息按原顺序拆分')

    const imgUrl = anthropicToOpenAI({
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] }]
    })
    eq(imgUrl.messages[0].content, [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }], 'url image → image_url 原样')

    const blob = anthropicToOpenAI({
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '行1' }, { type: 'image', source: { type: 'url', url: 'u' } }] }] }]
    })
    eq(blob.messages[0].content, '行1\n\n{"type":"image","source":{"type":"url","url":"u"}}', 'tool_result blocks 内容：text 拼接 + 非文本块 JSON 保留')

    const noId = anthropicToOpenAI({ messages: [{ role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] }] })
    eq(noId.messages[0].tool_calls[0].id, 'call_Bash', 'tool_use 缺 id → 按 name 兜底生成')

    const badTool = anthropicToOpenAI({ messages: [{ role: 'assistant', content: [{ type: 'tool_use', input: {} }] }] })
    eq(badTool.messages, [], 'tool_use 缺 name → 丢弃该块')
  }

  console.log('\n[3] anthropicToOpenAI：tools / tool_choice / 采样参数 / max_tokens / 忽略字段')
  {
    const r = anthropicToOpenAI({
      temperature: 0.3,
      top_p: 0.9,
      stop_sequences: ['</stop>'],
      max_tokens: 8192,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      metadata: { user_id: 'u1' },
      tools: [
        { name: 'Read', description: '读文件', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
        { name: 'NoSchema' }
      ],
      tool_choice: { type: 'auto', disable_parallel_tool_use: false },
      messages: []
    })
    eq(r.extraBody.tools, [
      { type: 'function', function: { name: 'Read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
      { type: 'function', function: { name: 'NoSchema', parameters: { type: 'object', properties: {} } } }
    ], 'tools → OpenAI tools（input_schema → parameters；缺失补空 schema）')
    eq(r.extraBody.tool_choice, 'auto', 'tool_choice {type:auto} → auto')
    eq(r.extraBody.temperature, 0.3, 'temperature 透传')
    eq(r.extraBody.top_p, 0.9, 'top_p 透传')
    eq(r.extraBody.stop, ['</stop>'], 'stop_sequences → stop')
    eq(r.maxTokens, 8192, 'max_tokens 保留记录')
    eq(r.extraBody.max_tokens, undefined, 'max_tokens 不并入请求体（避免超出上游上限被 400）')
    ok(!('thinking' in r.extraBody) && !('metadata' in r.extraBody), 'thinking / metadata 忽略不报错')

    eq(anthropicToOpenAI({ tool_choice: { type: 'any' } }).extraBody.tool_choice, 'required', 'tool_choice any → required')
    eq(anthropicToOpenAI({ tool_choice: { type: 'none' } }).extraBody.tool_choice, 'none', 'tool_choice none → none')
    eq(anthropicToOpenAI({ tool_choice: { type: 'tool', name: 'Read' } }).extraBody.tool_choice,
      { type: 'function', function: { name: 'Read' } }, 'tool_choice {type:tool,name} → {type:function,...}')
    eq(anthropicToOpenAI({ tool_choice: { type: 'bogus' } }).extraBody.tool_choice, undefined, '未知 tool_choice 丢弃（不报错）')
    eq(anthropicToOpenAI({ tools: [] }).extraBody.tools, undefined, '空 tools 不写入 extraBody')
  }

  console.log('\n[4] openAIToAnthropic：文本 / tool_use / stop_reason / usage')
  {
    const text = openAIToAnthropic(
      { content: '最终答案', usage: { prompt: 12, completion: 34 } },
      { id: 'msg_test_1' }
    )
    eq(text.id, 'msg_test_1', 'id 可显式传入')
    eq(text.type, 'message', "type = 'message'")
    eq(text.role, 'assistant', "role = 'assistant'")
    eq(text.model, 'moa-aggregated', "model 缺省 'moa-aggregated'")
    eq(text.content, [{ type: 'text', text: '最终答案' }], '文本 → text 块')
    eq(text.stop_reason, 'end_turn', 'stop_reason = end_turn')
    eq(text.stop_sequence, null, 'stop_sequence = null')
    eq(text.usage, { input_tokens: 12, output_tokens: 34 }, 'usage 映射 input/output_tokens')

    const tools = openAIToAnthropic({
      content: '',
      toolCalls: [{ id: 'call_1', name: 'Read', arguments: '{"path":"a.txt"}' }],
      finishReason: 'tool_calls',
      usage: { prompt: 5, completion: 6 }
    })
    eq(tools.content, [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a.txt' } }], 'tool_calls → tool_use 块（arguments 解析为 input）')
    eq(tools.stop_reason, 'tool_use', '有工具 → stop_reason tool_use')
    ok(/^msg_/.test(tools.id), '缺省 id 以 msg_ 开头（' + tools.id + '）')

    const mixed = openAIToAnthropic({
      content: '说明',
      toolCalls: [{ id: 'call_2', name: 'Bash', arguments: '{"cmd":"ls"}' }]
    })
    eq(mixed.content, [
      { type: 'text', text: '说明' },
      { type: 'tool_use', id: 'call_2', name: 'Bash', input: { cmd: 'ls' } }
    ], '文本 + tool_use 块并存（text 在前）')

    eq(openAIToAnthropic({ content: 'x', finishReason: 'length' }).stop_reason, 'max_tokens', "finish_reason length → max_tokens")
    eq(openAIToAnthropic({ content: 'x', finishReason: 'stop' }).stop_reason, 'end_turn', "finish_reason stop → end_turn")
    eq(openAIToAnthropic({ content: '' }).content, [], '空文本且无工具 → content []')
    eq(openAIToAnthropic({ content: '' }).usage, { input_tokens: 0, output_tokens: 0 }, 'usage 缺省 0/0')
    eq(openAIToAnthropic({ content: '', toolCalls: [{ id: '', name: 'X', arguments: 'no-json' }] }).content,
      [{ type: 'tool_use', id: 'toolu_0', name: 'X', input: {} }], 'arguments 非法 JSON → input {}（不抛错）')
  }

  console.log('\n[5] anthropicStreamEvents：完整事件序列（文本真流 + 收尾）')
  {
    const events = anthropicStreamEvents({
      id: 'msg_s1',
      textDeltas: ['今天', '天气', '不错'],
      usage: { prompt: 9, completion: 21 },
      stopReason: 'stop'
    })
    eq(events.map((e) => e.event), [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop'
    ], '事件序列：message_start → block_start → delta×3 → block_stop → message_delta → message_stop')
    ok(events.every((e) => e.data.type === e.event), '每条 data.type 与 event 名一致')
    eq(events[0].data.message.id, 'msg_s1', 'message_start 携带 id')
    eq(events[0].data.message.role, 'assistant', 'message_start.role = assistant')
    eq(events[0].data.message.content, [], 'message_start.content = []')
    eq(events[0].data.message.usage, { input_tokens: 0, output_tokens: 0 }, 'message_start.usage 起始 0/0（输入侧后置在 message_delta 一次性给出）')
    eq(events[1].data, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'text 块 index 0 起始')
    eq(events.slice(2, 5).map((e) => e.data.delta), [
      { type: 'text_delta', text: '今天' },
      { type: 'text_delta', text: '天气' },
      { type: 'text_delta', text: '不错' }
    ], '文本增量逐帧传递（拼接 = 全文）')
    eq(events[5].data, { type: 'content_block_stop', index: 0 }, 'text 块收尾')
    eq(events[6].data, {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { input_tokens: 9, output_tokens: 21 }
    }, 'message_delta：stop_reason + usage')
    eq(events[7].data, { type: 'message_stop' }, 'message_stop 收尾')
  }

  console.log('\n[6] anthropicStreamEvents：tool_use 块（input_json_delta 一次性完整 JSON）')
  {
    const events = anthropicStreamEvents({
      id: 'msg_s2',
      textDeltas: ['我来读取'],
      toolCalls: [
        { id: 'call_a', name: 'Read', arguments: '{"path":"a.txt"}' },
        { id: '', name: 'Bash', arguments: '' }
      ],
      usage: { prompt: 3, completion: 4 }
    })
    const startBlocks = events.filter((e) => e.event === 'content_block_start')
    eq(startBlocks.map((e) => e.data.index), [0, 1, 2], 'text 块 0 + 两个 tool_use 块 1/2')
    eq(startBlocks[1].data.content_block, { type: 'tool_use', id: 'call_a', name: 'Read', input: {} }, 'tool_use 块起始（input 空对象）')
    eq(startBlocks[2].data.content_block.id, 'toolu_1', 'tool_use 缺 id → toolu_下标 兜底')
    const jsonDeltas = events.filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'input_json_delta')
    eq(jsonDeltas.map((e) => e.data.delta.partial_json), ['{"path":"a.txt"}', '{}'], 'input_json_delta：完整 JSON 一次性给出（空 arguments → {}）')
    eq(jsonDeltas.map((e) => e.data.index), [1, 2], 'input_json_delta 指向各自块 index')
    eq(events.filter((e) => e.event === 'content_block_stop').map((e) => e.data.index), [0, 1, 2], '每个块逐一 stop')
    const delta = events.find((e) => e.event === 'message_delta')
    eq(delta.data.delta.stop_reason, 'tool_use', '有 toolCalls → stop_reason tool_use')
    eq(events[events.length - 1].event, 'message_stop', 'message_stop 收尾')
    // 顺序：text block_stop 先于 tool_use block_start
    const order = events.map((e) => e.event)
    ok(order.indexOf('content_block_stop') < order.lastIndexOf('content_block_start'), 'text 块收尾在 tool_use 块之前')
  }

  console.log('\n[7] createAnthropicStreamState：增量驱动与整段生成同源 + SSE 帧格式 + 幂等')
  {
    const state = createAnthropicStreamState({ id: 'msg_s3' })
    const incremental = []
    incremental.push(...state.start())
    incremental.push(...state.textDelta('甲'))
    incremental.push(...state.textDelta(''))
    incremental.push(...state.textDelta('乙'))
    incremental.push(...state.end({ usage: { prompt: 1, completion: 2 }, stopReason: 'stop' }))
    incremental.push(...state.end({ usage: { prompt: 1, completion: 2 } }))
    incremental.push(...state.textDelta('丙'))

    const whole = anthropicStreamEvents({ id: 'msg_s3', textDeltas: ['甲', '乙'], usage: { prompt: 1, completion: 2 }, stopReason: 'stop' })
    eq(incremental.map((e) => e.event), whole.map((e) => e.event), '增量路径事件序列 = 整段生成（同源）')
    eq(incremental.length, whole.length, '重复 end / 终态后 textDelta 均为无操作（不重复发事件）')

    const frame = formatAnthropicSse({ event: 'message_stop', data: { type: 'message_stop' } })
    eq(frame, 'event: message_stop\ndata: {"type":"message_stop"}\n\n', 'SSE 帧格式：event 行 + data 行 + 空行')

    const noText = createAnthropicStreamState({ id: 'msg_s4' })
    const evts = noText.end({ toolCalls: [{ id: 'c1', name: 'T', arguments: '{}' }] })
    eq(evts.map((e) => e.event), [
      'message_start', 'content_block_start', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'message_delta', 'message_stop'
    ], '无文本：仍补全起始序列（空 text 块）后给出 tool_use 块')
  }

  console.log('\n[8] 工具函数：stop_reason 映射与 parseToolInput')
  {
    eq(anthropicStopReason(true, 'stop'), 'tool_use', '有工具优先 tool_use')
    eq(anthropicStopReason(false, 'length'), 'max_tokens', 'length → max_tokens')
    eq(anthropicStopReason(false, 'max_tokens'), 'max_tokens', 'max_tokens → max_tokens')
    eq(anthropicStopReason(false, 'stop'), 'end_turn', 'stop → end_turn')
    eq(anthropicStopReason(false, null), 'end_turn', 'null → end_turn')
    eq(parseToolInput('{"a":1}'), { a: 1 }, 'parseToolInput 正常解析')
    eq(parseToolInput(''), {}, 'parseToolInput 空串 → {}')
    eq(parseToolInput('{bad'), {}, 'parseToolInput 非法 JSON → {}')
    eq(parseToolInput('[1,2]'), {}, 'parseToolInput 非对象 → {}')
  }

  console.log('\n──────────────────────────────')
  console.log(`通过 ${pass} / 失败 ${fail}`)
  process.exit(fail === 0 ? 0 : 1)
})().catch((err) => {
  console.error('测试脚本异常：', err)
  process.exit(1)
})
