// 冒烟测试：主席团专家团 —— 主进程生成器 src/main/moa/expertTeamGenerator.ts + 渲染端席位映射 src/renderer/src/utils/expertTeam.ts（T4）
// 覆盖：① parseExpertPlan 宽容解析（标准对象 / markdown 代码块 / 前后杂文 / 纯数组 / 方括号 reason / 脏项丢弃 / 超长截断 / 垃圾输入）
//      ② resolveGeneratorModel 三级解析（主模型 → 首个可用子模型 → 首个可用厂商首模型）
//      ③ generateExpertTeam 入口（空需求 / 无可用生成模型 / 流式失败 / 成功路径 / 解析失败 / reason 缺省）
//      ④ initialDrafts 草案初始化（沿用现有席位 / 复用首个席位模型 / 池空回退空串）
//      ⑤ buildImportPlan 导入计划（新 uuid / order 重排 / role 清空 / 席位扩充缩减 / skipped）
// 用法：node test-e2e/expert-team.cjs
// 加载方式：esbuild bundle 两个被测模块（独立构建）：
//   - expertTeamGenerator.ts：stub electron / appSettings / providerManager / moaConfig / fetchProxy / streamChat 六个外部模块
//     （'../pricing/probe' 不 stub，用真实现——被测解析逻辑依赖其 extractJsonObject / extractJsonArray）；
//   - expertTeam.ts（渲染端）：零 stub（仅 type import），直接 bundle。
//   stub 与用例经 globalThis.__expertTeamTest 通信（bundle 与测试同进程）。
// 返回码：全部通过 0，有失败 1
const path = require('path')

// ── 测试控制面（stub 读取；用例写入配置、读调用记录） ──

const ctl = {
  providers: [], // getAllProviders（stub）
  moaConfig: { subModels: [], aggregator: null }, // getMoaConfig（stub）
  settings: {}, // readAppSettings（stub；本轮用例仅走 probe 的纯函数，不读设置）
  streamChatResult: { content: '' }, // 假 streamChat 的返回值
  streamChatCalls: [], // streamChat 调用记录
  /** 假流式调用：返回形态与真实 streamChat 一致（content/usage/error），永不 throw */
  async streamChat(opts) {
    ctl.streamChatCalls.push(opts)
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
/** 席位配置（id 自增；order 仅类型需要） */
const seat = (providerId, modelId) => ({ id: 'seat-' + ++seatSeq, providerId, modelId, order: seatSeq })
/** 模型池选项（'providerId:modelId'） */
const opt = (value) => ({ value, label: value })
/** 厂商 */
const prov = (id, extra) =>
  Object.assign({ id, name: id, baseUrl: 'http://stub/' + id, apiKey: '', models: [], enabled: true }, extra || {})
/** 模型 */
const mdl = (id, providerId) => ({ id, name: id, providerId: providerId || 'p1' })
/** 专家（GeneratedExpert） */
const exp = (name, prompt) => ({ name, prompt })

/** 重置假 streamChat 状态（providers / moaConfig 由各用例自行设置） */
function resetChat() {
  ctl.streamChatResult = { content: '' }
  ctl.streamChatCalls.length = 0
}

let main = null
let renderer = null

// ── 用例 ──

;(async () => {
  main = await bundle('../src/main/moa/expertTeamGenerator.ts', [stubPlugin])
  renderer = await bundle('../src/renderer/src/utils/expertTeam.ts')

  console.log('══ 模块导出（签名对齐任务卡）══')
  ok(
    ['resolveGeneratorModel', 'buildExpertPlanPrompt', 'parseExpertPlan', 'generateExpertTeam'].every(
      (k) => typeof main[k] === 'function'
    ),
    'expertTeamGenerator 导出 resolveGeneratorModel / buildExpertPlanPrompt / parseExpertPlan / generateExpertTeam'
  )
  ok(
    ['initialDrafts', 'buildImportPlan'].every((k) => typeof renderer[k] === 'function'),
    'expertTeam（渲染端）导出 initialDrafts / buildImportPlan'
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

  caseHeader(8, 'parseExpertPlan：超长截断（name 60→50 / prompt 4100→4000）')
  {
    const content = JSON.stringify({ reason: 'r', experts: [exp('名'.repeat(60), '词'.repeat(4100))] })
    const p = main.parseExpertPlan(content)
    eq(p.experts[0].name.length, 50, '[8] name 60 字 → 截断为 50')
    eq(p.experts[0].prompt.length, 4000, '[8] prompt 4100 字 → 截断为 4000')
    eq(p.experts[0].name, '名'.repeat(50), '[8] name 截断取前 50 字')
    eq(p.experts[0].prompt, '词'.repeat(4000), '[8] prompt 截断取前 4000 字')
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

  caseHeader(18, 'generateExpertTeam：streamChat 返回纯垃圾 → reject「未能解析出有效专家列表」')
  {
    resetChat()
    ctl.providers = [prov('p1', { apiKey: 'key-p1', models: [mdl('p1-m1')] })]
    ctl.moaConfig = { subModels: [], aggregator: null }
    ctl.streamChatResult = { content: '这个问题很有挑战性，我认为需要多角度考虑。' }
    const msg = await rejectMsg(main.generateExpertTeam({ requirement: '设计一个分布式任务调度系统', seats: [] }))
    ok(typeof msg === 'string' && msg.includes('未能解析出有效专家列表'), '[18] 文案含「未能解析出有效专家列表」', msg)
  }

  caseHeader(19, 'generateExpertTeam：成功但 reason 缺失 → plan 无 reason 字段（不写 undefined）')
  {
    resetChat()
    ctl.providers = [prov('p1', { apiKey: 'key-p1', models: [mdl('p1-m1')] })]
    ctl.moaConfig = { subModels: [], aggregator: null }
    ctl.streamChatResult = { content: '{"experts":[{"name":"唯一专家","prompt":"p-唯一"}]}' }
    const plan = await main.generateExpertTeam({ requirement: '设计一个分布式任务调度系统', seats: [] })
    eq(plan.experts.length, 1, '[19] 无 reason 不影响专家解析')
    eq('reason' in plan, false, '[19] plan 上不存在 reason 字段')
    eq(Object.keys(plan).sort(), ['experts', 'modelId', 'providerId'], '[19] plan 键 = experts/modelId/providerId')
  }

  // ═══ initialDrafts ═══

  caseHeader(20, 'initialDrafts：existing 2 席 + experts 4 个 → 前 2 席沿用、第 3/4 席复用 existing[0] 模型')
  {
    const existing = [seat('p1', 'm1'), seat('p2', 'm2')]
    const experts = [exp('甲', 'p-甲'), exp('乙', 'p-乙'), exp('丙', 'p-丙'), exp('丁', 'p-丁')]
    const pool = [opt('p1:m1'), opt('p3:m3')]
    const drafts = renderer.initialDrafts(experts, existing, pool)
    eq(drafts.length, 4, '[20] 草案数量 = 专家数量')
    eq(drafts.map((d) => d.modelKey), ['p1:m1', 'p2:m2', 'p1:m1', 'p1:m1'], '[20] 前 2 席沿用现有席位，新增 2 席复用 existing[0] 模型')
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

  caseHeader(23, 'buildImportPlan：M=3 / N=2 → 3 席位，expanded = 第 3 席（复用 existing[0] 模型）')
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
    eq(plan.changes.expanded, [{ modelId: 'm1' }], '[23] expanded = 新增的第 3 席（modelId = existing[0].modelId）')
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

  caseHeader(25, 'buildImportPlan：M=1 / N=2 → shrunk = [{ modelId: existing[1].modelId }]')
  {
    const existing = [seat('p1', 'm1'), seat('p2', 'm2')]
    const pool = [opt('p1:m1'), opt('p2:m2')]
    const plan = renderer.buildImportPlan(existing, pool, [{ name: '甲', prompt: 'pa', modelKey: 'p1:m1' }])
    eq(plan.subModels.length, 1, '[25] 只剩 1 席位')
    eq(plan.changes.shrunk, [{ modelId: 'm2' }], '[25] shrunk = 被移除的第 2 席（modelId = existing[1].modelId）')
    eq(plan.changes.expanded, [], '[25] 无扩充')
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

  eq(caseCount, 28, '用例数 = 28（与任务卡清单一致）')

  console.log('\n──────────────────────────────')
  console.log(`通过 ${pass} / 失败 ${fail}`)
  process.exit(fail === 0 ? 0 : 1)
})()
