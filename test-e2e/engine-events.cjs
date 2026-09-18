// 冒烟测试：src/main/moa/moaEngine.ts 的事件语义（T3）
// （子模型 running 累计事件 / 聚合分块 + 终态 / fallback 聚合重置 / signal 逐路透传 /
//  中止短路（不发起聚合）/ resolveSubModels 导出）
// 用法：node test-e2e/engine-events.cjs
// 加载方式：esbuild bundle moaEngine.ts（同 stream-call.cjs 思路），三个外部模块用 esbuild plugin 换 stub：
//   - '../providers/providerManager'（getAllProviders → 测试注入的厂商表，不依赖 DB/Electron）
//   - './subModelCaller'（callSubModelStream → 脚本化假流式调用；countSuccessfulSubModels 同真实实现）
//   - './streamChat'（聚合流式调用 → 脚本化）
//   stub 与用例经 globalThis.__engineEventsTest 通信（bundle 与测试同进程）。
// 返回码：全部通过 0，有失败 1
const path = require('path')

// ── 测试控制面（stub 读取；用例写入脚本、读调用记录） ──

const ctl = {
  providers: [],
  subScripts: new Map(), // modelId → { deltas: [累计全文...], stepDelayMs?, fail?, error?, usage? }
  aggScripts: new Map(), // modelId → { deltas: [累计全文...], stepDelayMs?, error?, usage? }
  subCalls: [], // callSubModelStream 调用记录 { modelId, providerId, signal, hasOnDelta }
  aggCalls: [], // streamChat 调用记录 { modelId, signal, hasOnDelta }
  /** 假子模型流式调用（永不 throw）：返回形态与真实 callSubModelStream 一致；abort 即中断并保留已收文本 */
  async callSubModelStream(opts) {
    ctl.subCalls.push({
      modelId: opts.modelId,
      providerId: opts.providerId,
      signal: opts.signal,
      hasOnDelta: typeof opts.onDelta === 'function'
    })
    const script = ctl.subScripts.get(opts.modelId) || { deltas: [] }
    const aborted = () => Boolean(opts.signal && opts.signal.aborted)
    let acc = ''
    const interrupted = () => ({
      modelId: opts.modelId,
      providerId: opts.providerId || opts.providerBaseUrl,
      content: acc,
      status: 'error',
      error: '已中止',
      durationMs: 1
    })
    for (const full of script.deltas) {
      if (aborted()) return interrupted()
      acc = full
      if (opts.onDelta) opts.onDelta(acc)
      if (script.stepDelayMs) await sleep(script.stepDelayMs)
      if (aborted()) return interrupted()
    }
    if (script.fail) {
      return {
        modelId: opts.modelId,
        providerId: opts.providerId || opts.providerBaseUrl,
        content: acc,
        status: 'error',
        error: script.error || '子模型失败',
        durationMs: 1
      }
    }
    const output = { modelId: opts.modelId, providerId: opts.providerId || opts.providerBaseUrl, content: acc, status: 'success', durationMs: 1 }
    if (script.usage) output.tokenUsage = script.usage
    return output
  },
  /** 假聚合流式调用：返回形态与真实 streamChat 一致（content/usage/error） */
  async streamChat(opts) {
    ctl.aggCalls.push({ modelId: opts.modelId, signal: opts.signal, hasOnDelta: typeof opts.onDelta === 'function' })
    const script = ctl.aggScripts.get(opts.modelId) || {}
    const aborted = () => Boolean(opts.signal && opts.signal.aborted)
    let acc = ''
    for (const full of script.deltas || []) {
      if (aborted()) return { content: acc, error: '已中止' }
      acc = full
      if (opts.onDelta) opts.onDelta(acc)
      if (script.stepDelayMs) await sleep(script.stepDelayMs)
      if (aborted()) return { content: acc, error: '已中止' }
    }
    if (script.error) return { content: acc, error: script.error }
    return script.usage ? { content: acc, usage: script.usage } : { content: acc }
  }
}
globalThis.__engineEventsTest = ctl

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** 轮询等待条件成立（超时返回最终值） */
const waitFor = async (fn, ms) => {
  const t0 = Date.now()
  while (!fn() && Date.now() - t0 < ms) await sleep(5)
  return fn()
}

// ── 模块加载（esbuild bundle + 三模块 stub） ──

async function loadEngine() {
  let esbuild
  try {
    esbuild = require('esbuild')
  } catch {
    throw new Error('缺少 esbuild（随 vite 安装）：请在项目根目录执行 npm i 后再跑本脚本')
  }
  const result = await esbuild.build({
    entryPoints: [path.resolve(__dirname, '../src/main/moa/moaEngine.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'silent',
    plugins: [
      {
        name: 'stub-engine-deps',
        setup(build) {
          build.onResolve({ filter: /(^|\/)providerManager$/ }, () => ({ path: 'providerManager', namespace: 'engine-stub' }))
          build.onResolve({ filter: /(^|\/)subModelCaller$/ }, () => ({ path: 'subModelCaller', namespace: 'engine-stub' }))
          build.onResolve({ filter: /(^|\/)streamChat$/ }, () => ({ path: 'streamChat', namespace: 'engine-stub' }))
          build.onLoad({ filter: /.*/, namespace: 'engine-stub' }, (args) => {
            const stubs = {
              providerManager: 'export function getAllProviders() { return globalThis.__engineEventsTest.providers }\n',
              subModelCaller:
                'export function callSubModelStream(opts) { return globalThis.__engineEventsTest.callSubModelStream(opts) }\n' +
                'export function countSuccessfulSubModels(list) { return (list || []).filter((r) => r.status === "success").length }\n',
              streamChat: 'export async function streamChat(opts) { return globalThis.__engineEventsTest.streamChat(opts) }\n'
            }
            return { contents: stubs[args.path], loader: 'js' }
          })
        }
      }
    ]
  })
  const js = result.outputFiles[0].text
  const mod = { exports: {} }
  new Function('exports', 'module', 'require', js)(mod.exports, mod, require)
  return mod.exports
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

let engine = null

/** 每个用例前重置脚本与调用记录（providers 常驻） */
function reset() {
  ctl.subScripts.clear()
  ctl.aggScripts.clear()
  ctl.subCalls.length = 0
  ctl.aggCalls.length = 0
}

/** 子模型配置小工具（order 仅类型需要，stub 不校验） */
let orderSeq = 0
const subOf = (modelId, providerId, extra) => Object.assign({ modelId, providerId, order: orderSeq++ }, extra || {})

/** 收集器：记录引擎发射的全部事件（sub 载荷整份保留，便于断言字段形态） */
function collector() {
  const events = []
  return {
    events,
    opts: {
      emitSubOutput: (output, index) => events.push({ type: 'sub', index, output: Object.assign({}, output) }),
      emitAggregationStart: () => events.push({ type: 'aggStart' }),
      emitAggregationChunk: (text, done) => events.push({ type: 'aggChunk', text, done })
    }
  }
}

const aggChunksOf = (events) => events.filter((e) => e.type === 'aggChunk').map((e) => e.text + '/' + e.done)
const subSeqOf = (events, index) =>
  events.filter((e) => e.type === 'sub' && e.index === index).map((e) => e.output.status + ':' + e.output.content)

const AGG_CONFIG = { primaryProviderId: 'p1', primaryModelId: 'agg-primary', fallbackProviderId: 'p2', fallbackModelId: 'agg-fallback' }

// ── 用例 ──

;(async () => {
  engine = await loadEngine()
  ctl.providers = [
    { id: 'p1', name: '厂商1', baseUrl: 'http://stub/p1', apiKey: 'k1', enabled: true },
    { id: 'p2', name: '厂商2', baseUrl: 'http://stub/p2', apiKey: 'k2', enabled: true }
  ]

  console.log('\n[1] 正常聚合：sub running 累计 ×多次 → 终态 → aggStart → agg 分块 ×多次 → done 终态')
  {
    reset()
    ctl.subScripts.set('sub-a', { deltas: ['甲', '甲乙'] })
    ctl.subScripts.set('sub-b', { deltas: ['丙'] })
    ctl.aggScripts.set('agg-primary', { deltas: ['融', '融合', '融合稿'], usage: { prompt: 12, completion: 3 } })
    const { events, opts } = collector()
    const ctrl = new AbortController() // 本用例不中止：验证「未中止时 signal 原样透传」
    const res = await engine.executeMoAWithEvents(
      Object.assign(
        {
          messages: [{ role: 'user', content: '问题' }],
          subModels: [subOf('sub-a', 'p1', { role: 'critic' }), subOf('sub-b', 'p2')],
          aggregator: AGG_CONFIG,
          mode: 'aggregate',
          signal: ctrl.signal
        },
        opts
      )
    )

    eq(subSeqOf(events, 0), ['running:甲', 'running:甲乙', 'success:甲乙'], 'index 0：running 累计 ×2 → 终态 success')
    eq(subSeqOf(events, 1), ['running:丙', 'success:丙'], 'index 1：running 累计 ×1 → 终态 success')
    const sub0 = events.filter((e) => e.type === 'sub' && e.index === 0)
    eq('durationMs' in sub0[0].output, false, 'running 事件只带累计文本（无 durationMs 终态字段）')
    eq(sub0[2].output.error, undefined, '终态成功无 error 字段')
    eq(sub0[0].output.role, 'critic', 'running 事件带角色（与终态一致）')

    const idxAggStart = events.findIndex((e) => e.type === 'aggStart')
    ok(idxAggStart > 0 && events.slice(0, idxAggStart).every((e) => e.type === 'sub'), 'aggStart 之前只有子模型事件（' + idxAggStart + ' 条）')
    eq(
      events.slice(idxAggStart).map((e) => e.type),
      ['aggStart', 'aggChunk', 'aggChunk', 'aggChunk', 'aggChunk'],
      'aggStart 之后是聚合分块事件'
    )
    eq(aggChunksOf(events), ['融/false', '融合/false', '融合稿/false', '融合稿/true'], 'agg 累计分块 ×3（done:false）→ 终态（累计全文, done:true）')

    eq(res.success, true, '本轮 success')
    eq(res.content, '融合稿', 'content = 聚合终态文本')
    eq(res.aggregatorModelId, 'agg-primary', 'aggregatorModelId = primary')
    eq(res.aggregatorUsage, { prompt: 12, completion: 3 }, 'usage 落账（来自终态帧）')
    eq(res.partialFailure, false, '无部分失败')

    eq(ctl.subCalls.length, 2, '两次子模型调用')
    ok(ctl.subCalls.every((c) => c.signal === ctrl.signal && c.hasOnDelta), '子模型调用均携带 req.signal + onDelta（逐路透传）')
    eq(ctl.aggCalls.length, 1, '一次聚合调用（primary）')
    ok(ctl.aggCalls[0].signal === ctrl.signal && ctl.aggCalls[0].hasOnDelta, '聚合调用携带 req.signal + onDelta')
  }

  console.log('\n[2] fallback 聚合重置：primary 失败 → 先 emitAggregationChunk("", false) 清空 → fallback 流')
  {
    reset()
    ctl.subScripts.set('sub-a', { deltas: ['甲'] })
    ctl.aggScripts.set('agg-primary', { deltas: ['主1', '主2'], error: '主聚合流中断' })
    ctl.aggScripts.set('agg-fallback', { deltas: ['替1', '替2替'], usage: { prompt: 5, completion: 4 } })
    const { events, opts } = collector()
    const res = await engine.executeMoAWithEvents(
      Object.assign(
        {
          messages: [{ role: 'user', content: '问题' }],
          subModels: [subOf('sub-a', 'p1')],
          aggregator: AGG_CONFIG,
          mode: 'aggregate'
        },
        opts
      )
    )

    eq(
      aggChunksOf(events),
      ['主1/false', '主2/false', '/false', '替1/false', '替2替/false', '替2替/true'],
      'primary 部分文本 → 空文本重置 → fallback 分块 → 终态'
    )
    eq(res.success, true, 'fallback 生效 → success')
    eq(res.content, '替2替', 'content = fallback 终态文本')
    eq(res.aggregatorModelId, 'agg-fallback', 'aggregatorModelId = fallback')
    eq(res.aggregatorProviderId, 'p2', 'aggregatorProviderId = fallback 厂商')
    eq(ctl.aggCalls.map((c) => c.modelId), ['agg-primary', 'agg-fallback'], '两次聚合调用：primary → fallback')
    eq(res.partialFailure, false, '无部分失败（子模型均成功）')
  }

  console.log('\n[3] 中止（子模型阶段）：不发起聚合 + success:false + 部分文本保留；与「全部失败」文案区分')
  {
    reset()
    ctl.subScripts.set('sub-a', { deltas: ['甲', '甲乙'], stepDelayMs: 30 })
    ctl.subScripts.set('sub-b', { deltas: ['乙1', '乙1乙2'], stepDelayMs: 20 })
    ctl.aggScripts.set('agg-primary', { deltas: ['不该出现'] })
    const { events, opts } = collector()
    const ctrl = new AbortController()
    // 首个 running 事件到达后立即中止（模拟客户端断开的时机）
    const promise = engine.executeMoAWithEvents(
      Object.assign(
        {
          messages: [{ role: 'user', content: '问题' }],
          subModels: [subOf('sub-a', 'p1'), subOf('sub-b', 'p2')],
          aggregator: AGG_CONFIG,
          mode: 'aggregate',
          signal: ctrl.signal
        },
        opts
      )
    )
    const watchdog = (async () => {
      await waitFor(() => events.some((e) => e.type === 'sub' && e.output.status === 'running'), 1000)
      ctrl.abort()
    })()
    const res = await promise
    await watchdog

    eq(res.success, false, 'abort 后 success:false')
    eq(res.error, '已中止', 'error = 已中止（非「所有子模型均失败」文案）')
    eq(res.content, '', 'content 为空')
    ok(events.some((e) => e.type === 'sub' && e.output.status === 'running'), '中止前已有 running 累计事件到达')
    eq(events.filter((e) => e.type === 'aggStart').length, 0, '未发起聚合（无 aggStart）')
    eq(events.filter((e) => e.type === 'aggChunk').length, 0, '无聚合分块事件')
    eq(ctl.aggCalls.length, 0, '聚合调用零次（不再产生费用）')
    eq(
      res.subOutputs.map((o) => o.status + ':' + o.content + ':' + o.error),
      ['error:甲:已中止', 'error:乙1:已中止'],
      '部分 subOutputs 保留已收文本 + 已中止'
    )

    // 对照：无 abort 时全部子模型失败 → 文案是「所有子模型均失败」（两条路径不混淆）
    reset()
    ctl.subScripts.set('sub-a', { deltas: ['甲'], fail: true, error: '网络错误' })
    ctl.subScripts.set('sub-b', { deltas: [], fail: true, error: '网络错误' })
    const ctlCase = collector()
    const res2 = await engine.executeMoAWithEvents(
      Object.assign(
        {
          messages: [{ role: 'user', content: '问题' }],
          subModels: [subOf('sub-a', 'p1'), subOf('sub-b', 'p2')],
          aggregator: AGG_CONFIG,
          mode: 'aggregate'
        },
        ctlCase.opts
      )
    )
    eq(res2.error, '所有子模型均失败。请检查厂商连接和 API Key。', '未中止的全部失败仍走原文案（路径区分）')
    eq(ctl.aggCalls.length, 0, '全部失败同样不发起聚合')
  }

  console.log('\n[4] direct 模式：仅 index 0 有调用与事件，无聚合')
  {
    reset()
    ctl.subScripts.set('sub-a', { deltas: ['直1', '直通'] })
    ctl.subScripts.set('sub-b', { deltas: ['不该出现'] })
    ctl.aggScripts.set('agg-primary', { deltas: ['不该出现'] })
    const { events, opts } = collector()
    const res = await engine.executeMoAWithEvents(
      Object.assign(
        {
          messages: [{ role: 'user', content: '问题' }],
          subModels: [subOf('sub-a', 'p1'), subOf('sub-b', 'p2')],
          aggregator: AGG_CONFIG,
          mode: 'direct'
        },
        opts
      )
    )

    eq(ctl.subCalls.length, 1, '只发起 1 次子模型调用（其余不调用，不白付费用）')
    eq(ctl.subCalls[0].modelId, 'sub-a', '调用的是 index 0 子模型')
    eq(subSeqOf(events, 0), ['running:直1', 'running:直通', 'success:直通'], 'index 0：running 累计 → 终态')
    eq(events.filter((e) => e.type === 'sub' && e.index !== 0).length, 0, 'index 1 无任何子模型事件')
    eq(events.filter((e) => e.type === 'aggStart' || e.type === 'aggChunk').length, 0, 'direct 无聚合事件')
    eq(ctl.aggCalls.length, 0, '聚合零调用')
    eq(res.type, 'direct', 'type = direct')
    eq(res.success, true, 'direct success')
    eq(res.content, '直通', 'content = index 0 终态文本')
    eq(res.subOutputs.length, 1, 'subOutputs 只有 index 0')
  }

  console.log('\n[5] resolveSubModels 导出（网关 T4 生成 roundStart 清单用）')
  {
    eq(typeof engine.resolveSubModels, 'function', '可 import 到 resolveSubModels')
    const resolved = engine.resolveSubModels(
      [
        { modelId: 'm1', providerId: 'p1', order: 0 },
        { modelId: 'm2', providerId: '不存在', order: 1 },
        { modelId: 'm3', providerId: 'p1', order: 2, systemPrompt: '自定义提示词' },
        { modelId: 'm4', providerId: 'p2', order: 3, role: 'critic' }
      ],
      '全局默认提示词'
    )
    eq(resolved.length, 3, '可用的解析出 3 条（未知厂商被过滤）')
    eq(resolved.map((r) => r.modelId), ['m1', 'm3', 'm4'], '保持配置顺序')
    eq(resolved[0].providerBaseUrl, 'http://stub/p1', 'providerBaseUrl 来自厂商表')
    eq(resolved[0].systemPrompt, '全局默认提示词', '无自定义/角色 → 用全局默认')
    eq(resolved[1].systemPrompt, '自定义提示词', '自定义 systemPrompt 优先')
    ok(typeof resolved[2].systemPrompt === 'string' && resolved[2].systemPrompt.length > 0 && resolved[2].systemPrompt !== '全局默认提示词', '角色模板 systemPrompt 生效（critic）')
    eq(resolved[0].role, '', '未配角色 → 空角色')
  }

  console.log('\n[6] 聚合进行中 abort：primary 流中途中止 → 不发起 fallback（守卫）+ 无重置帧')
  {
    reset()
    ctl.subScripts.set('sub-a', { deltas: ['甲'] })
    ctl.aggScripts.set('agg-primary', { deltas: ['主1', '主2', '主3'], stepDelayMs: 5 })
    ctl.aggScripts.set('agg-fallback', { deltas: ['不该出现'], error: '不该发起 fallback' })
    const { events, opts } = collector()
    const ctrl = new AbortController()
    // 真实时序：聚合流逐帧回调，收到第 2 帧（'主2'）后同步 abort（模拟客户端断开）；
    // stub 在该帧回调后的中断检查处观察到已中止 → 中断聚合流（保留已收文本 + error 已中止）
    opts.emitAggregationChunk = (text, done) => {
      events.push({ type: 'aggChunk', text, done })
      if (text === '主2') ctrl.abort()
    }
    const res = await engine.executeMoAWithEvents(
      Object.assign(
        {
          messages: [{ role: 'user', content: '问题' }],
          subModels: [subOf('sub-a', 'p1')],
          aggregator: AGG_CONFIG,
          mode: 'aggregate',
          signal: ctrl.signal
        },
        opts
      )
    )

    ok(events.some((e) => e.type === 'aggStart'), '中止前已进入聚合阶段（aggStart 已在流中发出）')
    eq(aggChunksOf(events), ['主1/false', '主2/false', '/true'], '事件序列：已收聚合帧 ×2 → 空终态帧（无 fallback 分块）')
    eq(events.filter((e) => e.type === 'aggChunk' && e.text === '' && e.done === false).length, 0, '无 fallback 重置帧（emitAggregationChunk("", false) 零次）')
    eq(ctl.aggCalls.map((c) => c.modelId), ['agg-primary'], '聚合调用仅 primary（abort 后不发起 fallback，零额外费用）')
    eq(res.success, false, '中止 → success:false')
    eq(res.error, '聚合失败：已中止。子模型输出可在对比视图中查看。', 'error 走聚合降级文案（原因 = 已中止）')
    eq(res.content, '', 'content 为空（聚合未产出可用终态）')
    eq(res.subOutputs.map((o) => o.status + ':' + o.content), ['success:甲'], '子模型输出保留（已收文本不丢）')
  }

  console.log('\n[7] fallback 进行中 abort：fallback 流中途中止 → 降级返回 success:false')
  {
    reset()
    ctl.subScripts.set('sub-a', { deltas: ['甲'] })
    ctl.aggScripts.set('agg-primary', { deltas: ['主1'], error: '主聚合失败' })
    ctl.aggScripts.set('agg-fallback', { deltas: ['替1', '替2', '替3'], stepDelayMs: 5 })
    const { events, opts } = collector()
    const ctrl = new AbortController()
    // fallback 流第 2 帧（'替2'）后同步 abort：中止点在守卫检查（primary 失败时）之后，故 fallback 已合法发起
    opts.emitAggregationChunk = (text, done) => {
      events.push({ type: 'aggChunk', text, done })
      if (text === '替2') ctrl.abort()
    }
    const res = await engine.executeMoAWithEvents(
      Object.assign(
        {
          messages: [{ role: 'user', content: '问题' }],
          subModels: [subOf('sub-a', 'p1')],
          aggregator: AGG_CONFIG,
          mode: 'aggregate',
          signal: ctrl.signal
        },
        opts
      )
    )

    eq(aggChunksOf(events), ['主1/false', '/false', '替1/false', '替2/false', '/true'], '事件序列：primary 部分文本 → 重置帧 → fallback 已收帧 → 空终态帧（第三帧不再到达）')
    eq(ctl.aggCalls.map((c) => c.modelId), ['agg-primary', 'agg-fallback'], 'primary 失败时尚未中止 → fallback 正常发起（守卫不误伤）')
    eq(res.success, false, 'fallback 中途中止 → success:false')
    // 注：降级文案沿用 aggResult（primary）的失败原因，fallback 的中止原因不透传——现行实现行为，据此写死
    eq(res.error, '聚合失败：主聚合失败。子模型输出可在对比视图中查看。', 'error 走聚合降级文案（当前实现取 primary 失败原因）')
    eq(res.content, '', 'content 为空（不返回被中止的 fallback 半成品）')
    eq(res.aggregatorModelId, undefined, 'fallback 未成功 → 不标注聚合模型身份')
    eq(res.subOutputs.map((o) => o.status + ':' + o.content), ['success:甲'], '子模型输出保留（已收文本不丢）')
  }

  console.log('\n──────────────────────────────')
  console.log(`通过 ${pass} / 失败 ${fail}`)
  process.exit(fail === 0 ? 0 : 1)
})()
