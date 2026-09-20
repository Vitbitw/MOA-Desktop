// 冒烟测试：主席团专家团 —— 主进程生成器 src/main/moa/expertTeamGenerator.ts + 渲染端席位映射 src/renderer/src/utils/expertTeam.ts + 共享 key 解析 src/shared/modelKey.ts（T4 + T5 补强）
// 覆盖：① parseExpertPlan 宽容解析（标准对象 / markdown 代码块 / 前后杂文 / 纯数组 / 方括号 reason / 脏项丢弃 / 超长截断 / 垃圾输入）
//      ② resolveGeneratorModel 三级解析（主模型 → 首个可用子模型 → 首个可用厂商首模型）
//      ③ generateExpertTeam 入口（空需求 / 无可用生成模型 / 流式失败 / 成功路径 / 解析失败 / reason 缺省）；返回 {kind:'plan'} 判别
//      ④ initialDrafts 草案初始化（沿用现有席位 / 复用首个席位模型 / 池空回退空串）
//      ⑤ buildImportPlan 导入计划（新 uuid / order 重排 / role 清空 / 席位扩充缩减 / skipped / 变化摘要展示名=专家名〔空名回退模型名〕）
//      ⑥ 评审补强（T5）：buildExpertPlanPrompt 全文片段断言（SF-3；v11：档位/追问段）/ 含冒号 modelId 无损（SF-1）/ 字符串内 } 的 reason 提取（N-1）/ 码点安全截断（N-2）
//      ⑦ switchSeatModel 席位模型切换（保留 id/order/role/systemPrompt/expertName / 含冒号 modelId / 非法 key → null）
//      ⑧ 生成失败自动重试（5xx/网络类重试一次；401 等不可重试错误直接抛）
//      ⑨ v11 生成档位与追问（T3）：parseExpertTeamReply 判别解析（ask 命中/问空回退 plan/容错截断/ask 优先）/
//         buildExpertPlanPrompt 三档互斥文案·追问历史渲染（轮号/成对/未补充/跳空轮）·force 强制段 /
//         generateExpertTeam 追问链路（clarify 返回 / force 透传与兜底 / ≥MAX_CLARIFY_ROUNDS 本地强制 / history 清洗）
// 用法：node test-e2e/expert-team.cjs
// 加载方式：esbuild bundle 三个被测模块（独立构建）：
//   - expertTeamGenerator.ts：stub electron / appSettings / providerManager / moaConfig / fetchProxy / streamChat 六个外部模块
//     （'../pricing/probe' 不 stub，用真实现——被测解析逻辑依赖其 extractJsonObject / extractJsonArray）；
//   - expertTeam.ts（渲染端）：零 stub（仅 type import），直接 bundle；
//   - modelKey.ts（共享）：无依赖，直接 bundle（splitModelKey 直测）。
//   stub 与用例经 globalThis.__expertTeamTest 通信（bundle 与测试同进程）。
// 返回码：全部通过 0，有失败 1
const path = require('path')

// ── 测试控制面（stub 读取；用例写入配置、读调用记录） ──

const ctl = {
  providers: [], // getAllProviders（stub）
  moaConfig: { subModels: [], aggregator: null }, // getMoaConfig（stub）
  settings: {}, // readAppSettings（stub；本轮用例仅走 probe 的纯函数，不读设置）
  streamChatResult: { content: '' }, // 假 streamChat 的返回值
  streamChatQueue: null, // 可选：按序返回的队列（只剩一项时保持返回它）；用于「重试」类用例
  streamChatCalls: [], // streamChat 调用记录
  /** 假流式调用：返回形态与真实 streamChat 一致（content/usage/error），永不 throw */
  async streamChat(opts) {
    ctl.streamChatCalls.push(opts)
    if (Array.isArray(ctl.streamChatQueue) && ctl.streamChatQueue.length > 0) {
      return ctl.streamChatQueue.length > 1 ? ctl.streamChatQueue.shift() : ctl.streamChatQueue[0]
    }
    return ctl.streamChatResult
  }
}
globalThis.__expertTeamTest = ctl

// ── 模块加载（esbuild bundle；主进程模块换 6 个 stub，渲染端模块零 stub） ──

async function bundle(entry, plugins) {
  let esbuild
  try {
    esbuild = require('esbuild')
  } catch {
    throw new Error('缺少 esbuild（随 vite 安装）：请在项目根目录执行 npm i 后再跑本脚本')
  }
  const result = await esbuild.build({
    entryPoints: [path.resolve(__dirname, entry)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'silent',
    plugins: plugins || []
  })
  const js = result.outputFiles[0].text
  const mod = { exports: {} }
  new Function('exports', 'module', 'require', js)(mod.exports, mod, require)
  return mod.exports
}

/** expertTeamGenerator.ts 的外部模块 stub（probe.ts 的顶部 import 也由其覆盖） */
const stubPlugin = {
  name: 'stub-expert-deps',
  setup(build) {
    build.onResolve({ filter: /(^|\/)providerManager$/ }, () => ({ path: 'providerManager', namespace: 'expert-stub' }))
    build.onResolve({ filter: /(^|\/)moaConfig$/ }, () => ({ path: 'moaConfig', namespace: 'expert-stub' }))
    build.onResolve({ filter: /(^|\/)streamChat$/ }, () => ({ path: 'streamChat', namespace: 'expert-stub' }))
    build.onResolve({ filter: /(^|\/)fetchProxy$/ }, () => ({ path: 'fetchProxy', namespace: 'expert-stub' }))
    build.onResolve({ filter: /(^|\/)appSettings$/ }, () => ({ path: 'appSettings', namespace: 'expert-stub' }))
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'expert-stub' }))
    build.onLoad({ filter: /.*/, namespace: 'expert-stub' }, (args) => {
      const stubs = {
        electron: 'export class BrowserWindow {}\n',
        appSettings:
          'export const readAppSettings = () => globalThis.__expertTeamTest.settings\n' +
          'export const updateRawAppSettings = () => {}\n',
        providerManager:
          'export function getAllProviders() { return globalThis.__expertTeamTest.providers }\n' +
          'export async function fetchAndCacheModels() {}\n',
        moaConfig: 'export function getMoaConfig() { return globalThis.__expertTeamTest.moaConfig }\n',
        fetchProxy: "export async function fetchProxy() { throw new Error('fetchProxy 不应被调用（测试仅使用 probe 的纯函数）') }\n",
        streamChat: 'export async function streamChat(opts) { return globalThis.__expertTeamTest.streamChat(opts) }\n'
      }
      return { contents: stubs[args.path], loader: 'js' }
    })
  }
}

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

let caseCount = 0
function caseHeader(n, title) {
  caseCount++
  console.log(`\n[${n}] ${title}`)
}

/** 期待 reject：返回错误文案（若意外 resolve 返回 null） */
async function rejectMsg(promise) {
  try {
    await promise
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

// ── 夹具小工具 ──

let seatSeq = 0
/** 席位配置（id 自增；order 仅类型需要；extra 可补 expertName 等字段） */
const seat = (providerId, modelId, extra) =>
  Object.assign({ id: 'seat-' + ++seatSeq, providerId, modelId, order: seatSeq }, extra || {})
/** 模型池选项（'providerId:modelId'） */
const opt = (value) => ({ value, label: value })
/** 厂商 */
const prov = (id, extra) =>
  Object.assign({ id, name: id, baseUrl: 'http://stub/' + id, apiKey: '', models: [], enabled: true }, extra || {})
/** 模型 */
const mdl = (id, providerId) => ({ id, name: id, providerId: providerId || 'p1' })
/** 专家（GeneratedExpert） */
const exp = (name, prompt) => ({ name, prompt })

/** 是否含孤立代理项（UTF-16 高/低代理不成对；N-2 用例） */
function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1)
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) return true
  }
  return false
}

/** 重置假 streamChat 状态（providers / moaConfig 由各用例自行设置） */
function resetChat() {
  ctl.streamChatResult = { content: '' }
  ctl.streamChatQueue = null
  ctl.streamChatCalls.length = 0
}

let main = null
let renderer = null
let shared = null

// ── 用例 ──

;(async () => {
  main = await bundle('../src/main/moa/expertTeamGenerator.ts', [stubPlugin])
  renderer = await bundle('../src/renderer/src/utils/expertTeam.ts')
  shared = await bundle('../src/shared/modelKey.ts')

  console.log('══ 模块导出（签名对齐任务卡）══')
  ok(
    ['resolveGeneratorModel', 'buildExpertPlanPrompt', 'parseExpertPlan', 'parseExpertTeamReply', 'generateExpertTeam'].every(
      (k) => typeof main[k] === 'function'
    ),
    'expertTeamGenerator 导出 resolveGeneratorModel / buildExpertPlanPrompt / parseExpertPlan / parseExpertTeamReply / generateExpertTeam'
  )
  ok(main.MAX_CLARIFY_ROUNDS === 3, 'expertTeamGenerator 导出 MAX_CLARIFY_ROUNDS === 3（追问轮数上限）')
  ok(
    ['initialDrafts', 'buildImportPlan', 'switchSeatModel'].every((k) => typeof renderer[k] === 'function'),
    'expertTeam（渲染端）导出 initialDrafts / buildImportPlan / switchSeatModel'
  )

  // ═══ parseExpertPlan ═══

  caseHeader(1, 'parseExpertPlan：标准对象 → 2 专家 + reason 精确相等')
  {
    const content =
      '{"reason":"覆盖多维","experts":[{"name":"安全工程师","prompt":"你是一位安全工程师，请从安全视角分析。"},{"name":"性能专家","prompt":"你是一位性能专家，请从性能视角分析。"}]}'
    const p = main.parseExpertPlan(content)
    eq(p.experts.length, 2, '[1] 解析出 2 位专家')
    eq(p.reason, '覆盖多维', '[1] reason 精确相等')
    eq(p.experts[1], exp('性能专家', '你是一位性能专家，请从性能视角分析。'), '[1] 专家字段逐字保真')
  }

  caseHeader(2, 'parseExpertPlan：markdown 代码块包裹 → 同样解析成功')
  {
    const content =
      '```json\n{"reason":"多维覆盖","experts":[{"name":"架构师","prompt":"p-架构"},{"name":"质疑者","prompt":"p-质疑"}]}\n```'
    const p = main.parseExpertPlan(content)
    eq(p.experts.map((e) => e.name), ['架构师', '质疑者'], '[2] 代码块内 JSON 解析成功')
    eq(p.reason, '多维覆盖', '[2] reason 一并取出')
  }

  caseHeader(3, 'parseExpertPlan：前置说明 + 尾随文字 → 解析成功')
  {
    const content =
      '好的，这是为你规划的专家团队：\n{"reason":"简单任务","experts":[{"name":"产品经理","prompt":"p-产品"}]}\n以上是推荐结果，希望对你有帮助。'
    const p = main.parseExpertPlan(content)
    eq(p.experts.length, 1, '[3] 夹在自然语言中的 JSON 解析成功')
    eq(p.experts[0].name, '产品经理', '[3] 专家名正确')
  }

  caseHeader(4, 'parseExpertPlan：纯数组形态（无包裹对象）→ 专家提取成功、reason === undefined')
  {
    const content = '[{"name":"甲","prompt":"p-甲"},{"name":"乙","prompt":"p-乙"}]'
    const p = main.parseExpertPlan(content)
    eq(p.experts.map((e) => e.name), ['甲', '乙'], '[4] 裸数组提取 2 专家')
    eq(p.reason, undefined, '[4] 无包裹对象 → reason === undefined（JSON 序列化吞掉 undefined）')
    eq('reason' in p, false, '[4] plan 上不存在 reason 字段')
  }

  caseHeader(5, 'parseExpertPlan：reason 内含方括号 → 原样保留、专家不受影响')
  {
    const content = '{"reason":"推荐[5]位专家以覆盖多维[含安全/性能]","experts":[{"name":"安全工程师","prompt":"p-安全"},{"name":"性能专家","prompt":"p-性能"}]}'
    const p = main.parseExpertPlan(content)
    eq(p.reason, '推荐[5]位专家以覆盖多维[含安全/性能]', '[5] 方括号不影响花括号平衡扫描，reason 原样保留')
    eq(p.experts.map((e) => e.name), ['安全工程师', '性能专家'], '[5] 专家列表不受影响')

    // N-1 补强：字符串内含 } 时平衡扫描须跳过字符串上下文（不得误判对象提前闭合）
    const content2 = '{"reason":"需 } 收尾说明","experts":[{"name":"甲","prompt":"p-甲"}]}'
    const p2 = main.parseExpertPlan(content2)
    eq(p2.reason, '需 } 收尾说明', '[5] reason 含 }（字符串内）→ 对象扫描不误截断，reason 完整保留')
    eq(p2.experts.map((e) => e.name), ['甲'], '[5] 字符串内 } 不影响专家提取')
  }

  caseHeader(6, 'parseExpertPlan：缺字段项被丢弃（空 name / 空 prompt / 缺字段 / 非字符串）')
  {
    const content =
      '{"reason":"脏项测试","experts":[' +
      '{"name":"合法一","prompt":"p1"},' +
      '{"name":"   ","prompt":"p2"},' +
      '{"name":"合法二","prompt":"p2"},' +
      '{"name":"空提示词","prompt":""},' +
      '{"name":"缺提示词"},' +
      '{"prompt":"缺名称"},' +
      '{"name":123,"prompt":"p3"},' +
      'null,' +
      '"我是字符串"' +
      ']}'
    const p = main.parseExpertPlan(content)
    eq(p.experts.map((e) => e.name), ['合法一', '合法二'], '[6] 只剩合法项（空白/缺失/非字符串项全部丢弃）')
    eq(p.experts.length, 2, '[6] 丢弃后数量 = 2')
  }

  caseHeader(7, 'parseExpertPlan：全非法项 → experts.length === 0')
  {
    const content = '{"reason":"全非法","experts":[{"name":"","prompt":"p"},{"name":"x","prompt":"  "},{"prompt":"p"},{"name":7,"prompt":[1]}]}'
    const p = main.parseExpertPlan(content)
    eq(p.experts.length, 0, '[7] 全非法 → 0 专家')
    eq(p.reason, '全非法', '[7] reason 仍从包裹对象取出（与专家列表解耦）')
  }

  caseHeader(8, 'parseExpertPlan：超长截断（name 60→50 / prompt 4100→4000）+ 码点安全（emoji 不切裂）')
  {
    const content = JSON.stringify({ reason: 'r', experts: [exp('名'.repeat(60), '词'.repeat(4100))] })
    const p = main.parseExpertPlan(content)
    eq(p.experts[0].name.length, 50, '[8] name 60 字 → 截断为 50')
    eq(p.experts[0].prompt.length, 4000, '[8] prompt 4100 字 → 截断为 4000')
    eq(p.experts[0].name, '名'.repeat(50), '[8] name 截断取前 50 字')
    eq(p.experts[0].prompt, '词'.repeat(4000), '[8] prompt 截断取前 4000 字')

    // N-2 补强：按 UTF-16 码元截断会切裂 emoji 代理对（'a' + 50🚀 = 101 码元），修复后按码点截 50
    const emojiPlan = main.parseExpertPlan(JSON.stringify({ experts: [exp('a' + '🚀'.repeat(50), 'p-emoji')] }))
    eq([...emojiPlan.experts[0].name].length, 50, '[8] emoji 超长 name → 按码点截 50（代理对完整）')
    ok(!hasLoneSurrogate(emojiPlan.experts[0].name), '[8] 截断结果无孤立代理项')
  }

  caseHeader(9, 'parseExpertPlan：空内容 / 纯垃圾文本 / 截断 JSON → 0 专家（不抛错）')
  {
    eq(main.parseExpertPlan('').experts.length, 0, '[9] 空内容 → 0 专家')
    eq(main.parseExpertPlan('抱歉，我无法完成这个请求。').experts.length, 0, '[9] 纯垃圾文本 → 0 专家')
    eq(main.parseExpertPlan('{"experts": [{"name": "半截", "prompt"').experts.length, 0, '[9] 被截断的 JSON → 0 专家（不抛错）')
  }

  // ═══ resolveGeneratorModel ═══

  caseHeader(10, 'resolveGeneratorModel：全空 → null')
  {
    ctl.providers = []
    ctl.moaConfig = { subModels: [], aggregator: null }
    eq(main.resolveGeneratorModel(), null, '[10] 无厂商、无子模型、无主模型 → null')
  }

  caseHeader(11, 'resolveGeneratorModel：aggregator 主模型命中（provider enabled + apiKey）')
  {
    ctl.providers = [
      prov('p1', { apiKey: 'key-p1', models: [mdl('p1-m1')] }),
      prov('p2', { apiKey: 'key-p2', models: [mdl('p2-m1', 'p2')] })
    ]
    ctl.moaConfig = { subModels: [Object.assign(seat('p2', 'sub-m'), { order: 0 })], aggregator: { primaryProviderId: 'p1', primaryModelId: 'agg-1' } }
    const got = main.resolveGeneratorModel()
    eq(got.providerId, 'p1', '[11] 返回 aggregator 的 providerId')
    eq(got.modelId, 'agg-1', '[11] 返回 aggregator 的 primaryModelId')
    eq(got.baseUrl, 'http://stub/p1', '[11] baseUrl 取自厂商表')
  }

  caseHeader(12, 'resolveGeneratorModel：aggregator 的 provider 被禁用 → 回退 subModels[0] 对应 provider')
  {
    ctl.providers = [prov('p1', { enabled: false, apiKey: 'key-p1' }), prov('p2', { apiKey: 'key-p2' })]
    ctl.moaConfig = {
      subModels: [Object.assign(seat('p2', 'sub-m'), { order: 0 })],
      aggregator: { primaryProviderId: 'p1', primaryModelId: 'agg-1' }
    }
    const got = main.resolveGeneratorModel()
    eq(got.providerId, 'p2', '[12] 回退到 subModels[0] 的厂商')
    eq(got.modelId, 'sub-m', '[12] 使用 subModels[0].modelId')
  }

  caseHeader(13, 'resolveGeneratorModel：前两级都不可用 → 回退首个 enabled+key 厂商的 models[0]')
  {
    ctl.providers = [
      prov('pa', { enabled: false, apiKey: 'key-pa', models: [mdl('pa-m1', 'pa')] }),
      prov('pb', { enabled: true, apiKey: '', models: [mdl('pb-m1', 'pb')] }),
      prov('pc', { enabled: true, apiKey: 'key-pc', models: [mdl('pc-m1', 'pc'), mdl('pc-m2', 'pc')] })
    ]
    ctl.moaConfig = {
      subModels: [Object.assign(seat('px', 'x-m'), { order: 0 })], // px 不在厂商表 → 二级失败
      aggregator: { primaryProviderId: 'p9', primaryModelId: 'agg-1' } // p9 不存在 → 一级失败
    }
    const got = main.resolveGeneratorModel()
    eq(got.providerId, 'pc', '[13] 跳过禁用厂商与无 Key 厂商，落到首个可用厂商')
    eq(got.modelId, 'pc-m1', '[13] 取其首个模型（models[0]）')
    eq(got.apiKey, 'key-pc', '[13] 携带该厂商 apiKey')
  }

  // ═══ generateExpertTeam ═══

  caseHeader(14, 'generateExpertTeam：requirement 空串 / 空白 → reject「需求描述为空」')
  {
    resetChat()
    ctl.providers = [prov('p1', { apiKey: 'key-p1', models: [mdl('p1-m1')] })]
    ctl.moaConfig = { subModels: [], aggregator: null }
    const msg1 = await rejectMsg(main.generateExpertTeam({ requirement: '', seats: [] }))
    ok(typeof msg1 === 'string' && msg1.includes('需求描述为空'), '[14] 空串 → 文案含「需求描述为空」', msg1)
    const msg2 = await rejectMsg(main.generateExpertTeam({ requirement: '   \n\t ', seats: [] }))
    ok(typeof msg2 === 'string' && msg2.includes('需求描述为空'), '[14] 纯空白 → 文案含「需求描述为空」', msg2)
    eq(ctl.streamChatCalls.length, 0, '[14] 空需求在校验处短路：未调用 streamChat')
  }

  caseHeader(15, 'generateExpertTeam：无可用生成模型 → reject「未配置可用的生成模型」')
  {
    resetChat()
    ctl.providers = []
    ctl.moaConfig = { subModels: [], aggregator: null }
    const msg = await rejectMsg(main.generateExpertTeam({ requirement: '设计一个分布式任务调度系统', seats: [] }))
    ok(typeof msg === 'string' && msg.includes('未配置可用的生成模型'), '[15] 文案含「未配置可用的生成模型」', msg)
    eq(ctl.streamChatCalls.length, 0, '[15] 无模型时不发起调用')
  }

  caseHeader(16, 'generateExpertTeam：streamChat 返回 error → reject「生成失败：HTTP 500」')
  {
    resetChat()
    ctl.providers = [prov('p1', { apiKey: 'key-p1', models: [mdl('p1-m1')] })]
    ctl.moaConfig = { subModels: [], aggregator: null }
    ctl.streamChatResult = { content: '', error: 'HTTP 500: 上游炸了' }
    const msg = await rejectMsg(main.generateExpertTeam({ requirement: '设计一个分布式任务调度系统', seats: [] }))
    ok(typeof msg === 'string' && msg.includes('生成失败：HTTP 500'), '[16] 文案含「生成失败：HTTP 500」', msg)
    eq(msg, '生成失败：HTTP 500: 上游炸了', '[16] error 原文透传（前缀「生成失败：」）')
  }

  caseHeader(17, 'generateExpertTeam：streamChat 返回合法 JSON → resolve 计划 + prompt 含需求原文')
  {
    resetChat()
    ctl.providers = [prov('p1', { apiKey: 'key-p1', models: [mdl('p1-m1')] })]
    ctl.moaConfig = { subModels: [], aggregator: { primaryProviderId: 'p1', primaryModelId: 'agg-1' } }
    ctl.streamChatResult = {
      content: '{"reason":"规模适中","experts":[{"name":"架构师","prompt":"p-架构"},{"name":"测试工程师","prompt":"p-测试"}]}'
    }
    const requirement = '设计一个分布式任务调度系统'
    const plan = await main.generateExpertTeam({ requirement, seats: ['席位A', '席位B'] })
    eq(plan.kind, 'plan', '[17] 返回 kind=plan')
    eq(plan.experts, [exp('架构师', 'p-架构'), exp('测试工程师', 'p-测试')], '[17] experts 按序解析')
    eq(plan.reason, '规模适中', '[17] reason 透传')
    eq(plan.modelId, 'agg-1', '[17] plan.modelId = 生成模型')
    eq(plan.providerId, 'p1', '[17] plan.providerId = 生成模型厂商')
    eq(ctl.streamChatCalls.length, 1, '[17] 恰好一次 streamChat 调用')
    eq(ctl.streamChatCalls[0].modelId, 'agg-1', '[17] 调用使用解析出的生成模型')
    eq(ctl.streamChatCalls[0].providerBaseUrl, 'http://stub/p1', '[17] 调用使用该厂商 baseUrl')
    eq(ctl.streamChatCalls[0].apiKey, 'key-p1', '[17] 调用携带该厂商 apiKey')
    eq(ctl.streamChatCalls[0].messages[0].role, 'user', '[17] 单条 user 消息')
    ok(
      ctl.streamChatCalls[0].messages[0].content.includes(requirement),
      '[17] prompt 含 requirement 原文'
    )
    ok(
      ctl.streamChatCalls[0].messages[0].content.includes('已配置专家席位：2 个'),
      '[17] prompt 含席位数量（seats 透传）'
    )
    eq(ctl.streamChatCalls[0].timeoutMs, 60000, '[17] timeoutMs = DEFAULT_SUB_MODEL_TIMEOUT（60s）')
  }

  caseHeader(18, 'generateExpertTeam：streamChat 返回纯垃圾 → reject「未能解析出生成结果」')
  {
    resetChat()
    ctl.providers = [prov('p1', { apiKey: 'key-p1', models: [mdl('p1-m1')] })]
    ctl.moaConfig = { subModels: [], aggregator: null }
    ctl.streamChatResult = { content: '这个问题很有挑战性，我认为需要多角度考虑。' }
    const msg = await rejectMsg(main.generateExpertTeam({ requirement: '设计一个分布式任务调度系统', seats: [] }))
    ok(typeof msg === 'string' && msg.includes('未能解析出生成结果'), '[18] 文案含「未能解析出生成结果」', msg)
  }

  caseHeader(19, 'generateExpertTeam：成功但 reason 缺失 → plan 无 reason 字段（不写 undefined）')
  {
    resetChat()
    ctl.providers = [prov('p1', { apiKey: 'key-p1', models: [mdl('p1-m1')] })]
    ctl.moaConfig = { subModels: [], aggregator: null }
    ctl.streamChatResult = { content: '{"experts":[{"name":"唯一专家","prompt":"p-唯一"}]}' }
    const plan = await main.generateExpertTeam({ requirement: '设计一个分布式任务调度系统', seats: [] })
    eq(plan.experts.length, 1, '[19] 无 reason 不影响专家解析')
    eq(plan.kind, 'plan', '[19] kind=plan')
    eq('reason' in plan, false, '[19] plan 上不存在 reason 字段')
    eq(Object.keys(plan).sort(), ['experts', 'kind', 'modelId', 'providerId'], '[19] plan 键 = experts/kind/modelId/providerId')
  }

  // ═══ initialDrafts ═══

  caseHeader(20, 'initialDrafts：existing 2 席 + experts 4 个 → 前 2 席沿用、第 3/4 席复用 existing[0] 模型（pool[0] 不同亦有判别力）')
  {
    const existing = [seat('p1', 'm1'), seat('p2', 'm2')]
    const experts = [exp('甲', 'p-甲'), exp('乙', 'p-乙'), exp('丙', 'p-丙'), exp('丁', 'p-丁')]
    const pool = [opt('p3:m3'), opt('p1:m1')] // 池首（p3:m3）≠ existing[0]（p1:m1）：锁死「复用 existing[0]」而非 pool 顺序
    const drafts = renderer.initialDrafts(experts, existing, pool)
    eq(drafts.length, 4, '[20] 草案数量 = 专家数量')
    eq(drafts.map((d) => d.modelKey), ['p1:m1', 'p2:m2', 'p1:m1', 'p1:m1'], '[20] 前 2 席沿用现有席位，新增 2 席复用 existing[0] 模型（池首不同仍不取 pool[0]）')
    eq(drafts.map((d) => d.name), ['甲', '乙', '丙', '丁'], '[20] name 来自专家')
    eq(drafts.map((d) => d.prompt), ['p-甲', 'p-乙', 'p-丙', 'p-丁'], '[20] prompt 来自专家')
  }

  caseHeader(21, 'initialDrafts：existing 空 + pool 非空 → 全部 = pool[0].value')
  {
    const drafts = renderer.initialDrafts([exp('甲', 'p-甲'), exp('乙', 'p-乙')], [], [opt('p7:m7'), opt('p8:m8')])
    eq(drafts.map((d) => d.modelKey), ['p7:m7', 'p7:m7'], '[21] 无现有席位 → 全部回退模型池首个')
  }

  caseHeader(22, 'initialDrafts：existing 空 + pool 空 → 全部空串（导入时跳过）')
  {
    const drafts = renderer.initialDrafts([exp('甲', 'p-甲'), exp('乙', 'p-乙')], [], [])
    eq(drafts.map((d) => d.modelKey), ['', ''], '[22] 无任何可用模型 → modelKey 全为 \'\'')
  }

  // ═══ buildImportPlan ═══

  caseHeader(23, 'buildImportPlan：M=3 / N=2 → 3 席位，expanded = 第 3 席（复用 existing[0] 模型；展示名为专家名）')
  {
    const existing = [seat('p1', 'm1'), seat('p2', 'm2')]
    const pool = [opt('p1:m1'), opt('p2:m2')]
    const drafts = [
      { name: '甲', prompt: 'pa', modelKey: 'p1:m1' },
      { name: '乙', prompt: 'pb', modelKey: 'p2:m2' },
      { name: '丙', prompt: 'pc', modelKey: 'p1:m1' } // 第 3 项复用 existing[0] 模型
    ]
    const plan = renderer.buildImportPlan(existing, pool, drafts)
    eq(plan.subModels.length, 3, '[23] 生成 3 个席位')
    eq(plan.changes.expanded, [{ name: '丙' }], '[23] expanded = 新增的第 3 席（展示名 = 专家名「丙」而非模型名）')
    eq(plan.changes.shrunk, [], '[23] 无缩减')
    eq(plan.skipped, 0, '[23] 无跳过')
  }

  caseHeader(24, 'buildImportPlan：三项 id 互不相同 / role 清空 / order 0..2 / expertName·systemPrompt 来自草案')
  {
    const existing = [seat('p1', 'm1'), seat('p2', 'm2')]
    const pool = [opt('p1:m1'), opt('p2:m2')]
    const drafts = [
      { name: '甲', prompt: 'pa', modelKey: 'p1:m1' },
      { name: '乙', prompt: 'pb', modelKey: 'p2:m2' },
      { name: '丙', prompt: 'pc', modelKey: 'p1:m1' }
    ]
    const plan = renderer.buildImportPlan(existing, pool, drafts)
    const ids = plan.subModels.map((s) => s.id)
    eq(new Set(ids).size, 3, '[24] 3 个 id 去重后仍为 3（互不相同）')
    ok(ids.every((id) => typeof id === 'string' && id.length > 0), '[24] id 均为非空字符串（uuid）')
    ok(
      plan.subModels.every((s) => s.role === ''),
      '[24] role 一律清空（导入的专家席位不带预设角色）'
    )
    eq(plan.subModels.map((s) => s.order), [0, 1, 2], '[24] order 按序 0/1/2')
    eq(plan.subModels.map((s) => s.expertName), ['甲', '乙', '丙'], '[24] expertName 来自草案 name')
    eq(plan.subModels.map((s) => s.systemPrompt), ['pa', 'pb', 'pc'], '[24] systemPrompt 来自草案 prompt')
    eq(plan.subModels.map((s) => s.providerId + ':' + s.modelId), ['p1:m1', 'p2:m2', 'p1:m1'], '[24] modelKey 拆分为 providerId:modelId')
  }

  caseHeader(25, 'buildImportPlan：M=1 / N=2 → shrunk = 被移除席位（展示名：无专家名回退模型名 / 有专家名用专家名）')
  {
    const existing = [seat('p1', 'm1'), seat('p2', 'm2')]
    const pool = [opt('p1:m1'), opt('p2:m2')]
    const plan = renderer.buildImportPlan(existing, pool, [{ name: '甲', prompt: 'pa', modelKey: 'p1:m1' }])
    eq(plan.subModels.length, 1, '[25] 只剩 1 席位')
    eq(plan.changes.shrunk, [{ name: 'm2' }], '[25] shrunk = 被移除的第 2 席（无专家名 → 回退模型名 m2）')
    eq(plan.changes.expanded, [], '[25] 无扩充')

    // 席位展示名 = 专家名（用户诉求：结果行括号内显示席位名而非模型名）
    const named = [seat('p1', 'm1'), seat('p2', 'm2', { expertName: '性能工程师' })]
    const plan2 = renderer.buildImportPlan(named, pool, [{ name: '甲', prompt: 'pa', modelKey: 'p1:m1' }])
    eq(plan2.changes.shrunk, [{ name: '性能工程师' }], '[25] 被移除席位有专家名 → 展示名为「性能工程师」')
  }

  caseHeader(26, 'buildImportPlan：M == N → expanded / shrunk 均空')
  {
    const existing = [seat('p1', 'm1'), seat('p2', 'm2')]
    const pool = [opt('p1:m1'), opt('p2:m2')]
    const plan = renderer.buildImportPlan(existing, pool, [
      { name: '甲', prompt: 'pa', modelKey: 'p1:m1' },
      { name: '乙', prompt: 'pb', modelKey: 'p2:m2' }
    ])
    eq(plan.subModels.length, 2, '[26] 席位数量不变')
    eq(plan.changes.expanded, [], '[26] expanded 空')
    eq(plan.changes.shrunk, [], '[26] shrunk 空')
  }

  caseHeader(27, 'buildImportPlan：草案 modelKey 不在池（p9:m9）→ skipped=1 且不进入 subModels')
  {
    const existing = [seat('p1', 'm1'), seat('p2', 'm2')]
    const pool = [opt('p1:m1'), opt('p2:m2')]
    const plan = renderer.buildImportPlan(existing, pool, [
      { name: '甲', prompt: 'pa', modelKey: 'p1:m1' },
      { name: '乙', prompt: 'pb', modelKey: 'p9:m9' } // 不在模型池
    ])
    eq(plan.skipped, 1, '[27] skipped = 1')
    eq(plan.subModels.length, 1, '[27] 仅合法草案进入 subModels')
    ok(!plan.subModels.some((s) => s.modelId === 'm9'), '[27] 池外模型不进入 subModels')
    eq(plan.subModels[0].expertName, '甲', '[27] 保留的是池内草案')
  }

  caseHeader(28, 'buildImportPlan：草案 modelKey 为空串 → 同样计入 skipped')
  {
    const existing = [seat('p1', 'm1'), seat('p2', 'm2')]
    const pool = [opt('p1:m1'), opt('p2:m2')]
    const plan = renderer.buildImportPlan(existing, pool, [
      { name: '甲', prompt: 'pa', modelKey: '' },
      { name: '乙', prompt: 'pb', modelKey: 'p2:m2' }
    ])
    eq(plan.skipped, 1, '[28] 空 modelKey 计入 skipped')
    eq(plan.subModels.map((s) => s.modelId), ['m2'], '[28] 空 key 草案不进入 subModels')
    eq(plan.subModels[0].expertName, '乙', '[28] 保留的是有模型的草案')
  }

  // ═══ 评审补强（T5）：buildExpertPlanPrompt 全文（SF-3）+ 含冒号 modelId（SF-1） ═══

  caseHeader(29, 'buildExpertPlanPrompt：设计 §5.3 关键片段逐字断言 + seats 空/非空两分支（SF-3）')
  {
    const requirement = '设计一个分布式任务调度系统'
    const withSeats = main.buildExpertPlanPrompt({ requirement, seats: ['席位A', '席位B'] })
    // 关键片段逐字硬编码（≥8 条，取自设计 §5.3；不读取 .hermes 下被 gitignore 的文档，测试资产自包含）
    const fragments = [
      '你是多模型协作（主席团模式）的专家团队规划师',
      '【任务需求】',
      '【当前配置】',
      '【细分程度】',
      '正常：均衡规划，覆盖任务的关键维度，人数适中',
      '专家总数与分工颗粒度由你依据该档位自行决定',
      '【追问规则】',
      '每次最多 3 个问题，宁少勿滥',
      '【专家要求】',
      '【输出要求】',
      '只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释',
      '"action": "ask"',
      '"action": "generate"',
      '200-350 字',
      '宁详勿简',
      '① 身份设定',
      '② 职责描述',
      '③ 工作方法',
      '④ 输出要求',
      '新席位默认复用现有第一个席位的模型',
      '参考本轮上下文，只输出你的意见',
      '示例（仅格式与详略程度示意；内容必须按实际任务生成，勿照抄）',
      '你是一位深耕应用与供应链安全的资深安全工程师'
    ]
    for (const f of fragments) ok(withSeats.includes(f), `[29] prompt 含关键片段「${f}」`)
    ok(withSeats.includes('已配置专家席位：2 个（席位A、席位B）'), '[29] seats 非空 → 含席位清单 join 结果')
    ok(!withSeats.includes('\n【本次要求】\n'), '[29] 非 force → 不含【本次要求】段')
    ok(!withSeats.includes('\n【追问历史】\n'), '[29] 无历史 → 不含【追问历史】段')
    const noSeats = main.buildExpertPlanPrompt({ requirement, seats: [] })
    ok(noSeats.includes('已配置专家席位：0 个（无，将自动创建席位）'), '[29] seats 空 → 含「（无，将自动创建席位）」')
    ok(noSeats.includes(requirement), '[29] seats 空分支同样嵌入需求原文')
  }

  caseHeader(30, 'splitModelKey：按首个冒号切分（含冒号 modelId 无损）+ buildImportPlan round-trip（SF-1）')
  {
    eq(shared.splitModelKey(''), { providerId: '', modelId: '' }, '[30] 空串 → 两段均空串')
    eq(shared.splitModelKey('p1'), { providerId: 'p1', modelId: '' }, '[30] 无冒号 → 整串为 providerId（旧默认值行为）')
    eq(shared.splitModelKey('p1:m1'), { providerId: 'p1', modelId: 'm1' }, '[30] 常规两段切分')
    eq(shared.splitModelKey('ollama:llama3.1:8b'), { providerId: 'ollama', modelId: 'llama3.1:8b' }, '[30] 含冒号 modelId 无损保留')
    eq(shared.splitModelKey(':m1'), { providerId: '', modelId: 'm1' }, '[30] 前导冒号 → providerId 空串')

    // round-trip：含冒号 modelKey 导入后席位 modelId 不失真（评审 SF-1 原始缺陷面）
    const colonKey = 'ollama:llama3.1:8b'
    const plan = renderer.buildImportPlan([], [opt(colonKey)], [{ name: '甲', prompt: 'p-甲', modelKey: colonKey }])
    eq(plan.skipped, 0, '[30] 含冒号 modelKey 在池中 → 不跳过')
    eq(plan.subModels.map((s) => s.providerId + ':' + s.modelId), [colonKey], '[30] 导入后 providerId:modelId 逐字 round-trip')
    eq(plan.subModels[0].modelId, 'llama3.1:8b', '[30] 席位 modelId 保留完整冒号后缀')
  }

  caseHeader(31, 'buildImportPlan：专家名写入前 trim（空名 → 字段省略；expanded 展示名 trim / 空名回退模型名）')
  {
    const plan = renderer.buildImportPlan([], [opt('p1:m1')], [{ name: '  安全工程师  ', prompt: 'p-甲', modelKey: 'p1:m1' }])
    eq(plan.subModels[0].expertName, '安全工程师', '[31] 首尾空白已 trim')
    eq(plan.changes.expanded, [{ name: '安全工程师' }], '[31] expanded 展示名 trim 后为「安全工程师」')
    const empty = renderer.buildImportPlan([], [opt('p2:m2')], [{ name: '   ', prompt: 'p-乙', modelKey: 'p2:m2' }])
    ok(empty.subModels[0].expertName === undefined, '[31] 全空白专家名 → undefined')
    ok(!('expertName' in JSON.parse(JSON.stringify(empty.subModels[0]))), '[31] 序列化后无 expertName 键（落库干净）')
    eq(empty.changes.expanded, [{ name: 'm2' }], '[31] 全空白专家名 → expanded 展示名回退模型名 m2')
  }

  caseHeader(32, 'switchSeatModel：切换只替换 providerId/modelId（id/order/role/systemPrompt/expertName 保留）+ 含冒号 modelId + 非法 key → null')
  {
    const seatFull = { id: 'seat-x', providerId: 'p1', modelId: 'm1', order: 2, role: 'critic', systemPrompt: '自定义提示词', expertName: '安全工程师' }
    const switched = renderer.switchSeatModel(seatFull, 'p2:m2')
    eq(switched.providerId, 'p2', '[32] providerId 已替换')
    eq(switched.modelId, 'm2', '[32] modelId 已替换')
    eq(switched.id, 'seat-x', '[32] 席位 id 保留（同模型多席位不串位）')
    eq(switched.order, 2, '[32] order 保留')
    eq(switched.role, 'critic', '[32] role 保留（删除重加会丢）')
    eq(switched.systemPrompt, '自定义提示词', '[32] systemPrompt 保留')
    eq(switched.expertName, '安全工程师', '[32] expertName 保留')
    ok(switched !== seatFull, '[32] 返回新对象（不改原席位引用）')
    eq(seatFull.modelId, 'm1', '[32] 原席位对象不被修改')

    const colon = renderer.switchSeatModel(seatFull, 'ollama:llama3.1:8b')
    eq(colon.providerId + ':' + colon.modelId, 'ollama:llama3.1:8b', '[32] 含冒号 modelId 切换后逐字 round-trip')

    eq(renderer.switchSeatModel(seatFull, 'p9'), null, '[32] 无冒号 key（modelId 空）→ null')
    eq(renderer.switchSeatModel(seatFull, ':m1'), null, '[32] providerId 空 → null')
    eq(renderer.switchSeatModel(seatFull, 'p1:'), null, '[32] modelId 空 → null')
    eq(renderer.switchSeatModel(seatFull, ''), null, '[32] 空串 → null')
  }

  caseHeader(33, 'generateExpertTeam：上游瞬时故障（5xx/网络类）自动重试一次；不可重试错误直接抛')
  {
    // ① 第一次 500、第二次成功 → 自动重试成功（复现过「首次 500、手动重试即成功」的场景）
    resetChat()
    ctl.providers = [prov('p1', { apiKey: 'key-p1', models: [mdl('p1-m1')] })]
    ctl.moaConfig = { subModels: [], aggregator: null }
    ctl.streamChatQueue = [
      { content: '', error: 'HTTP 500: 上游炸了' },
      { content: '{"experts":[{"name":"重试专家","prompt":"重试后成功"}]}' }
    ]
    const plan = await main.generateExpertTeam({ requirement: '设计一个分布式任务调度系统', seats: [] })
    eq(plan.kind, 'plan', '[33] kind=plan')
    eq(plan.experts.length, 1, '[33] 5xx 自动重试一次后成功解析')
    eq(ctl.streamChatCalls.length, 2, '[33] 可重试错误 → streamChat 共调用 2 次')

    // ② 两次都失败 → 抛第二次错误原文（重试恰好 1 次）；文案用 streamChat 的真实超时形态（中文「首块响应超时」）
    resetChat()
    ctl.streamChatQueue = [
      { content: '', error: '首块响应超时（60000ms）' },
      { content: '', error: '流中断：fetch failed' }
    ]
    const msg2 = await rejectMsg(main.generateExpertTeam({ requirement: '设计一个分布式任务调度系统', seats: [] }))
    eq(ctl.streamChatCalls.length, 2, '[33] 重试恰好 1 次（共 2 次调用）')
    ok(typeof msg2 === 'string' && msg2.includes('fetch failed'), '[33] 抛第二次失败原文', msg2)

    // ③ 不可重试错误（401 鉴权）→ 不重试、立即抛
    resetChat()
    ctl.streamChatResult = { content: '', error: 'HTTP 401: Unauthorized' }
    const msg3 = await rejectMsg(main.generateExpertTeam({ requirement: '设计一个分布式任务调度系统', seats: [] }))
    eq(ctl.streamChatCalls.length, 1, '[33] 不可重试错误（401）不重试')
    ok(typeof msg3 === 'string' && msg3.includes('HTTP 401'), '[33] 原错误透传', msg3)
  }

  // ═══ v11-T3：parseExpertTeamReply 判别解析 ═══

  caseHeader(34, 'parseExpertTeamReply：ask 命中 → clarify（questions 精确 / reason 透传 / 无 experts 字段 / trim）')
  {
    const content = '{"action":"ask","reason":"需求信息不足","questions":["q1","q2"]}'
    const r = main.parseExpertTeamReply(content)
    eq(r.kind, 'clarify', '[34] kind=clarify')
    eq(r.questions, ['q1', 'q2'], '[34] questions 精确相等（按序、1-3 个）')
    eq(r.reason, '需求信息不足', '[34] reason 透传')
    eq('experts' in r, false, '[34] clarify 结果不含 experts 字段')
    eq(Object.keys(r).sort(), ['kind', 'questions', 'reason'], '[34] clarify 键 = kind/questions/reason')

    const padded = main.parseExpertTeamReply(
      JSON.stringify({ action: 'ask', reason: 'r', questions: ['  前后空白  ', '\tq2\n'] })
    )
    eq(padded.questions, ['前后空白', 'q2'], '[34] questions 项首尾空白被 trim')
  }

  caseHeader(35, 'parseExpertTeamReply：ask 容错与边界（截前 3 / 非法项丢弃 / 截断 200 / 问空回退 plan / 垃圾 → null）')
  {
    // >3 个问题 → 取前 3
    const four = main.parseExpertTeamReply(JSON.stringify({ action: 'ask', questions: ['q1', 'q2', 'q3', 'q4'] }))
    eq(four.questions, ['q1', 'q2', 'q3'], '[35] 4 个问题 → 取前 3')

    // 空串 / 纯空白 / 非字符串 → 丢弃，合法项保留
    const mixed = main.parseExpertTeamReply(
      JSON.stringify({ action: 'ask', questions: ['', '   ', 123, '有效一', null, '  有效二  '] })
    )
    eq(mixed.questions, ['有效一', '有效二'], '[35] 非法项丢弃、合法项 trim 后按序保留')

    // 单项 250 字 → 截断 200（码点安全）
    const clipped = main.parseExpertTeamReply(JSON.stringify({ action: 'ask', questions: ['问'.repeat(250)] }))
    eq(clipped.questions[0].length, 200, '[35] 250 字问题 → 截断为 200')
    eq(clipped.questions[0], '问'.repeat(200), '[35] 截断取前 200 字')
    eq([...clipped.questions[0]].length, 200, '[35] 截断后码点数 = 200')
    const emoji = main.parseExpertTeamReply(JSON.stringify({ action: 'ask', questions: ['🚀'.repeat(250)] }))
    eq([...emoji.questions[0]].length, 200, '[35] emoji 超长问题 → 按码点截 200（代理对完整）')
    eq(emoji.questions[0], '🚀'.repeat(200), '[35] emoji 截断取前 200 个码点')
    ok(!hasLoneSurrogate(emoji.questions[0]), '[35] 截断结果无孤立代理项')

    // action:'ask' 但问题列表无效 + 对象含 experts → 回退 plan（格式漂移容错）
    const drift = main.parseExpertTeamReply(
      JSON.stringify({ action: 'ask', reason: '漂移', questions: [], experts: [exp('甲', 'p-甲')] })
    )
    eq(drift.kind, 'plan', '[35] action=ask 但 questions 空 + 有 experts → 回退 kind=plan')
    eq(drift.experts, [exp('甲', 'p-甲')], '[35] 回退后 experts 正常解析')
    eq(drift.reason, '漂移', '[35] 回退后 reason 仍透传')

    // questions 有效 + 同时带 experts → ask 优先（规则 1 先于规则 3）
    const both = main.parseExpertTeamReply(
      JSON.stringify({ action: 'ask', questions: ['还需要什么？'], experts: [exp('乙', 'p-乙')] })
    )
    eq(both.kind, 'clarify', '[35] questions 有效 → ask 优先于 experts')

    // action:'generate' → plan + reason 透传
    const gen = main.parseExpertTeamReply(JSON.stringify({ action: 'generate', reason: 'r-生成', experts: [exp('丙', 'p-丙')] }))
    eq(gen.kind, 'plan', '[35] action=generate → kind=plan')
    eq(gen.reason, 'r-生成', '[35] generate 分支 reason 透传')

    // 纯垃圾 / 空串 / ask 问题全非法且无 experts → null
    eq(main.parseExpertTeamReply(''), null, '[35] 空串 → null')
    eq(main.parseExpertTeamReply('抱歉，我无法完成这个请求。'), null, '[35] 纯垃圾文本 → null')
    eq(main.parseExpertTeamReply(JSON.stringify({ action: 'ask', questions: ['', '  ', 123] })), null, '[35] ask 问题全非法且无 experts → null')

    // ask 无 reason → 不写 undefined 字段
    const noReason = main.parseExpertTeamReply(JSON.stringify({ action: 'ask', questions: ['q'] }))
    eq(noReason.kind, 'clarify', '[35] ask 无 reason → 仍返回 clarify')
    eq('reason' in noReason, false, '[35] 缺 reason → 结果上不存在 reason 字段（不写 undefined）')
  }

  caseHeader(36, 'parseExpertTeamReply：plan 分支与 parseExpertPlan 逐项等价（冻结两函数一致性）')
  {
    const legacy = '{"reason":"覆盖多维","experts":[{"name":"安全工程师","prompt":"p-安全"},{"name":"性能专家","prompt":"p-性能"}]}'
    const a = main.parseExpertTeamReply(legacy)
    const b = main.parseExpertPlan(legacy)
    eq(a.kind, 'plan', '[36] 旧格式 {reason, experts} → kind=plan')
    eq(a.experts.length, b.experts.length, '[36] 专家数量与 parseExpertPlan 相等')
    for (let i = 0; i < b.experts.length; i++) eq(a.experts[i], b.experts[i], `[36] 第 ${i + 1} 项专家与 parseExpertPlan 逐项相等`)
    eq(a.reason, b.reason, '[36] reason 与 parseExpertPlan 相等')

    // 脏格式（markdown 代码块 + 空白名/空名/null 脏项）两条路径同样等价
    const messy = '```json\n{"reason":"脏项","experts":[{"name":"  合法  ","prompt":"p1"},{"name":"","prompt":"p2"},null]}\n```'
    const a2 = main.parseExpertTeamReply(messy)
    const b2 = main.parseExpertPlan(messy)
    eq(a2.kind, 'plan', '[36] 代码块 + 脏项 → kind=plan')
    eq(a2.experts, b2.experts, '[36] 脏项场景 experts 与 parseExpertPlan 深相等')
    eq(a2.reason, b2.reason, '[36] 脏项场景 reason 相等')

    // 无 reason：两条路径均不携带 reason 字段
    const plain = '{"experts":[{"name":"甲","prompt":"p-甲"}]}'
    const a3 = main.parseExpertTeamReply(plain)
    const b3 = main.parseExpertPlan(plain)
    eq(a3.experts, b3.experts, '[36] 无 reason 场景 experts 相等')
    eq('reason' in a3, false, '[36] 无 reason → parseExpertTeamReply 结果不含 reason 字段')
    eq('reason' in a3, 'reason' in b3, '[36] reason 字段存在性与 parseExpertPlan 一致')
  }

  // ═══ v11-T3：buildExpertPlanPrompt 档位 / 追问历史 / 强制段 ═══

  caseHeader(37, 'buildExpertPlanPrompt：三档文案互斥（few / more / 缺省与非法 → normal）+ 数字软约束退役')
  {
    const requirement = '设计一个分布式任务调度系统'

    const few = main.buildExpertPlanPrompt({ requirement, seats: [], scale: 'few' })
    ok(few.includes('【细分程度】偏少：团队精干，每位专家覆盖多个相关维度，人数宜少不宜多。'), '[37] few 档含「【细分程度】偏少：…」逐字文案')
    ok(!few.includes('正常：均衡规划'), '[37] few 档不含 normal 文案')
    ok(!few.includes('较多：高度细分'), '[37] few 档不含 more 文案')
    ok(!few.includes('通常 2-6 位'), '[37] few 档不含数字软约束「通常 2-6 位」（已退役）')

    const more = main.buildExpertPlanPrompt({ requirement, seats: [], scale: 'more' })
    ok(
      more.includes('【细分程度】较多：高度细分，每位专家聚焦一个细分方向，覆盖尽量完整的维度，同时避免无意义的冗余与重复。'),
      '[37] more 档含「【细分程度】较多：…」逐字文案'
    )
    ok(!more.includes('偏少：团队精干'), '[37] more 档不含 few 文案')
    ok(!more.includes('正常：均衡规划'), '[37] more 档不含 normal 文案')
    ok(!more.includes('通常 2-6 位'), '[37] more 档不含数字软约束')

    const def = main.buildExpertPlanPrompt({ requirement, seats: [] })
    ok(def.includes('【细分程度】正常：均衡规划，覆盖任务的关键维度，人数适中。'), '[37] 缺省档 → 含 normal 逐字文案')
    ok(!def.includes('通常 2-6 位'), '[37] 缺省档不含数字软约束')
    ok(def.includes('每次最多 3 个问题，宁少勿滥'), '[37] 含追问规则片段「每次最多 3 个问题，宁少勿滥」')

    const weird = main.buildExpertPlanPrompt({ requirement, seats: [], scale: 'weird' })
    ok(weird.includes('【细分程度】正常：均衡规划，覆盖任务的关键维度，人数适中。'), '[37] 非法档位（weird）→ 回退 normal 文案')
    ok(!weird.includes('通常 2-6 位'), '[37] 非法档位不含数字软约束')
  }

  caseHeader(38, 'buildExpertPlanPrompt：追问历史渲染（轮号/成对/未补充/跳空轮）+ force 段按需插入')
  {
    const requirement = '设计一个分布式任务调度系统'
    const history = [
      { questions: ['缺什么信息？'], answers: ['需要支持多人协作'] },
      { questions: ['部署环境？'], answers: [] }
    ]
    const p = main.buildExpertPlanPrompt({ requirement, seats: [], history })
    ok(p.includes('【追问历史】'), '[38] history 非空 → 含【追问历史】')
    ok(p.includes('第 1 轮：'), '[38] 含第 1 轮')
    ok(p.includes('- 问：缺什么信息？'), '[38] 含第 1 轮问题')
    ok(p.includes('- 答：需要支持多人协作'), '[38] 含第 1 轮答案')
    ok(p.includes('第 2 轮：'), '[38] 含第 2 轮')
    ok(p.includes('- 答：（未补充）'), '[38] 空答案 → 「（未补充）」')
    ok(p.indexOf('第 1 轮：') < p.indexOf('第 2 轮：'), '[38] 轮号按序（第 1 轮在 第 2 轮 之前）')
    ok(p.includes('第 1 轮：\n- 问：缺什么信息？\n- 答：需要支持多人协作'), '[38] 第 1 轮 Q/A 成对逐字渲染')
    ok(p.includes('第 2 轮：\n- 问：部署环境？\n- 答：（未补充）'), '[38] 第 2 轮 Q/A 成对逐字渲染（答为空）')

    // 空问题轮被跳过：轮号从 1 起连续
    const skip = main.buildExpertPlanPrompt({
      requirement,
      seats: [],
      history: [
        { questions: [], answers: ['不该出现'] },
        { questions: ['Q2'], answers: ['A2'] }
      ]
    })
    ok(skip.includes('第 1 轮：\n- 问：Q2\n- 答：A2'), '[38] 空问题轮被跳过 → 有效轮前移为第 1 轮')
    ok(!skip.includes('第 2 轮：'), '[38] 仅 1 个有效轮 → 无第 2 轮')
    ok(!skip.includes('不该出现'), '[38] 空问题轮的答案不进入 prompt')

    // force 段（段形式：标记独占一行 + 正文 —— 「【本次要求】」字样在追问规则第 4 条中恒存在，故用段形式判别）
    const forceText = '【本次要求】\n用户已选择直接生成：立即生成专家团队，不得再追问。'
    const forced = main.buildExpertPlanPrompt({ requirement, seats: [], force: true })
    ok(forced.includes(forceText), '[38] force:true → 含【本次要求】逐字强制段')
    const notForced = main.buildExpertPlanPrompt({ requirement, seats: [], force: false })
    ok(!notForced.includes(forceText), '[38] force:false → 不含【本次要求】段')
    const def = main.buildExpertPlanPrompt({ requirement, seats: [] })
    ok(!def.includes(forceText), '[38] force 缺省 → 不含【本次要求】段')
    ok(!def.includes('【追问历史】\n'), '[38] history 缺省 → 不含【追问历史】段')
    ok(def.includes('若【本次要求】写明不得再追问'), '[38] 恒存在的是追问规则第 4 条字样（段形式判别的依据）')

    // 两者同时：段序 = 追问历史 → 本次要求 → 专家要求
    const both = main.buildExpertPlanPrompt({ requirement, seats: [], history, force: true })
    ok(
      both.indexOf('【追问历史】\n') < both.indexOf(forceText) && both.indexOf(forceText) < both.indexOf('【专家要求】'),
      '[38] 段序：追问历史 < 本次要求 < 专家要求'
    )
  }

  // ═══ v11-T3：generateExpertTeam 追问链路 ═══

  caseHeader(39, 'generateExpertTeam：LLM 返回 ask → resolve {kind:clarify}（questions/reason/模型来源/单次调用）')
  {
    resetChat()
    ctl.providers = [prov('p1', { apiKey: 'key-p1', models: [mdl('p1-m1')] })]
    ctl.moaConfig = { subModels: [], aggregator: { primaryProviderId: 'p1', primaryModelId: 'agg-1' } }
    ctl.streamChatResult = { content: '{"action":"ask","reason":"需求不足","questions":["面向什么平台？"]}' }
    const res = await main.generateExpertTeam({ requirement: '做一个通知功能', seats: [] })
    eq(res.kind, 'clarify', '[39] 返回 kind=clarify')
    eq(res.questions, ['面向什么平台？'], '[39] questions 透传（按序）')
    eq(res.reason, '需求不足', '[39] reason 透传')
    eq(res.modelId, 'agg-1', '[39] modelId = 生成模型')
    eq(res.providerId, 'p1', '[39] providerId = 生成模型厂商')
    eq(Object.keys(res).sort(), ['kind', 'modelId', 'providerId', 'questions', 'reason'], '[39] clarify 键 = kind/modelId/providerId/questions/reason')
    eq('experts' in res, false, '[39] clarify 结果不含 experts 字段')
    eq(ctl.streamChatCalls.length, 1, '[39] 恰好一次 streamChat 调用')
  }

  caseHeader(40, 'generateExpertTeam：scale/history 透传进 prompt；forceGenerate 下模型仍追问 → reject（force 透传证据）')
  {
    // ① scale + history 进入 prompt；非 force 不出现【本次要求】段
    resetChat()
    ctl.providers = [prov('p1', { apiKey: 'key-p1', models: [mdl('p1-m1')] })]
    ctl.moaConfig = { subModels: [], aggregator: null }
    ctl.streamChatResult = {
      content: '{"action":"generate","reason":"覆盖平台与协作","experts":[{"name":"平台专家","prompt":"p-平台"}]}'
    }
    const plan = await main.generateExpertTeam({
      requirement: '设计一个分布式任务调度系统',
      seats: [],
      scale: 'more',
      history: [{ questions: ['Q1'], answers: ['A1'] }]
    })
    eq(plan.kind, 'plan', '[40] 正常路径返回 kind=plan')
    const prompt = ctl.streamChatCalls[0].messages[0].content
    ok(prompt.includes('【追问历史】'), '[40] history 透传：prompt 含【追问历史】')
    ok(prompt.includes('- 问：Q1'), '[40] prompt 含历史问题')
    ok(prompt.includes('- 答：A1'), '[40] prompt 含历史答案')
    ok(prompt.includes('【细分程度】较多'), '[40] scale=more 透传：prompt 含「较多」档文案')
    ok(!prompt.includes('【本次要求】\n'), '[40] 未 force → prompt 无【本次要求】段')

    // ② forceGenerate:true + LLM 返回 ask → reject；prompt 含强制段（force 透传证据）
    resetChat()
    ctl.streamChatResult = { content: '{"action":"ask","reason":"再确认","questions":["还需要补充什么？"]}' }
    const msg = await rejectMsg(
      main.generateExpertTeam({ requirement: '设计一个分布式任务调度系统', seats: [], forceGenerate: true })
    )
    ok(
      typeof msg === 'string' && msg.includes('未按要求直接生成专家团'),
      '[40] force 下模型仍追问 → reject 文案含「未按要求直接生成专家团」',
      msg
    )
    const forcedPrompt = ctl.streamChatCalls[0].messages[0].content
    ok(
      forcedPrompt.includes('【本次要求】\n用户已选择直接生成：立即生成专家团队，不得再追问。'),
      '[40] force 透传：prompt 含【本次要求】逐字强制段'
    )
    eq(ctl.streamChatCalls.length, 1, '[40] force 场景仅一次 streamChat 调用（无重试）')
  }

  caseHeader(41, 'generateExpertTeam：轮数上限（≥MAX_CLARIFY_ROUNDS 本地强制）/ 4 轮截前 3 / history 清洗')
  {
    // ① history 3 轮（合法）= MAX_CLARIFY_ROUNDS → 本地强制：模型仍追问则 reject
    resetChat()
    ctl.providers = [prov('p1', { apiKey: 'key-p1', models: [mdl('p1-m1')] })]
    ctl.moaConfig = { subModels: [], aggregator: null }
    ctl.streamChatResult = { content: '{"action":"ask","reason":"还想问","questions":["第三轮之后还想问？"]}' }
    const h3 = [
      { questions: ['问题一'], answers: ['答案一'] },
      { questions: ['问题二'], answers: ['答案二'] },
      { questions: ['问题三'], answers: ['答案三'] }
    ]
    const msg3 = await rejectMsg(
      main.generateExpertTeam({ requirement: '设计一个分布式任务调度系统', seats: [], history: h3 })
    )
    eq(msg3, '生成失败：模型未按要求直接生成专家团，请重试', '[41] history 3 轮达上限 → 本地强制 reject（文案逐字）')
    const p3 = ctl.streamChatCalls[0].messages[0].content
    ok(p3.includes('第 3 轮：'), '[41] 三轮历史全部渲染（第 3 轮在）')
    ok(p3.includes('- 问：问题三'), '[41] 第 3 轮内容进入 prompt')
    ok(p3.includes('【本次要求】\n用户已选择直接生成：立即生成专家团队，不得再追问。'), '[41] 达上限 → prompt 含【本次要求】段（本地强制证据）')
    ok(!p3.includes('第 4 轮：'), '[41] 3 轮历史 → 无第 4 轮')

    // ② history 2 轮 + 返回 ask → 未达上限 → 不强制，正常返回 clarify（锁定边界）
    resetChat()
    ctl.streamChatResult = { content: '{"action":"ask","reason":"继续问","questions":["目标平台？"]}' }
    const h2 = [
      { questions: ['问题一'], answers: ['答案一'] },
      { questions: ['问题二'], answers: ['答案二'] }
    ]
    const res2 = await main.generateExpertTeam({ requirement: '设计一个分布式任务调度系统', seats: [], history: h2 })
    eq(res2.kind, 'clarify', '[41] 2 轮 < 上限 → 不本地强制，返回 kind=clarify')
    eq(res2.questions, ['目标平台？'], '[41] clarify questions 透传')
    const p2 = ctl.streamChatCalls[0].messages[0].content
    ok(!p2.includes('【本次要求】\n'), '[41] 2 轮 → prompt 无【本次要求】段')

    // ③ history 4 轮 → 截前 3 且达上限 → 本地强制
    resetChat()
    ctl.streamChatResult = { content: '{"action":"ask","reason":"还想问","questions":["还问？"]}' }
    const h4 = h3.concat([{ questions: ['问题四'], answers: ['答案四'] }])
    const msg4 = await rejectMsg(
      main.generateExpertTeam({ requirement: '设计一个分布式任务调度系统', seats: [], history: h4 })
    )
    ok(typeof msg4 === 'string' && msg4.includes('未按要求直接生成专家团'), '[41] 4 轮 → 截前 3 后达上限 → 本地强制 reject', msg4)
    const p4 = ctl.streamChatCalls[0].messages[0].content
    ok(p4.includes('第 3 轮：'), '[41] 第 3 轮保留')
    ok(!p4.includes('第 4 轮：'), '[41] 第 4 轮被截断（prompt 不含「第 4 轮：」）')
    ok(!p4.includes('问题四') && !p4.includes('答案四'), '[41] 第 4 轮内容不进入 prompt')

    // ④ 清洗：answers 缺项 → 对齐补「（未补充）」；答案首尾空白 trim
    resetChat()
    ctl.streamChatResult = { content: '{"action":"ask","reason":"r","questions":["再补充？"]}' }
    const cleaned = await main.generateExpertTeam({
      requirement: '设计一个分布式任务调度系统',
      seats: [],
      history: [{ questions: ['a', 'b'], answers: ['x'] }]
    })
    eq(cleaned.kind, 'clarify', '[41] 清洗场景未达上限 → 正常返回 clarify')
    const pc = ctl.streamChatCalls[0].messages[0].content
    ok(
      pc.includes('第 1 轮：\n- 问：a\n- 答：x\n- 问：b\n- 答：（未补充）'),
      '[41] answers 缺项 → 第二问答对齐补「（未补充）」（逐字渲染）'
    )

    resetChat()
    ctl.streamChatResult = { content: '{"action":"ask","reason":"r","questions":["再补充？"]}' }
    await main.generateExpertTeam({
      requirement: '设计一个分布式任务调度系统',
      seats: [],
      history: [{ questions: ['a'], answers: ['  y  '] }]
    })
    const pt = ctl.streamChatCalls[0].messages[0].content
    ok(pt.includes('- 答：y'), '[41] 答案首尾空白被 trim（- 答：y）')
    ok(!pt.includes('- 答：  y'), '[41] prompt 不含未 trim 的原始答案')
  }

  eq(caseCount, 41, '用例数 = 41（v11：档位/追问/上限与清洗）')

  console.log('\n──────────────────────────────')
  console.log(`通过 ${pass} / 失败 ${fail}`)
  process.exit(fail === 0 ? 0 : 1)
})()
