// 纯 Node 测试：src/renderer/src/store/gatewayStore.ts 的单槽位监视器状态机（T5）
// 覆盖：① roundStart 替换旧轮 + pending 占位生成（按 index 排序）
//      ② subUpdate 累计覆盖 + 乱序 index 排序插入 + 占位角色保留
//      ③ aggStart / aggChunk（累计覆盖 + done 终态收口）
//      ④ roundDone（正常完成 / aborted 中止）
//      ⑤ 迟到 roundId 忽略（含无当前轮时）
//      ⑥ dismiss / restore
//      ⑦ 完整一轮状态终值
//      ⑧ initGatewaySubscriptions 接线（5 事件进入 store + roundStart 回调 + 统一解绑）
// 用法：node test-e2e/gateway-store.cjs
// 加载方式：esbuild bundle gatewayStore.ts（zustand 纯 JS，Node 可直接运行；
//   模块顶层零 window 引用；[8] 注入假 window.moaAPI 后调用 initGatewaySubscriptions）
// 返回码：全部通过 0，有失败 1
const path = require('path')

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

// ── 模块加载（esbuild bundle gatewayStore.ts；zustand 一并打包） ──

async function loadStore() {
  let esbuild
  try {
    esbuild = require('esbuild')
  } catch {
    throw new Error('缺少 esbuild（随 vite 安装）：请在项目根目录执行 npm i 后再跑本脚本')
  }
  const result = await esbuild.build({
    entryPoints: [path.resolve(__dirname, '../src/renderer/src/store/gatewayStore.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'silent'
  })
  const js = result.outputFiles[0].text
  const mod = { exports: {} }
  new Function('exports', 'module', 'require', js)(mod.exports, mod, require)
  return mod.exports
}

// ── 状态快照（稳定投影，便于整轮终值比对；时间戳只断言类型） ──

function roundSnap(store) {
  const r = store.getState().round
  if (!r) return null
  return {
    roundId: r.roundId,
    mode: r.mode,
    running: r.running,
    success: r.success,
    aborted: r.aborted,
    error: r.error,
    aggText: r.aggText,
    aggRunning: r.aggRunning,
    subModels: r.subModels,
    subOutputs: r.subOutputs.map((o) => ({
      index: o.index,
      modelId: o.modelId,
      providerId: o.providerId,
      content: o.content,
      status: o.status,
      error: o.error,
      durationMs: o.durationMs,
      tokenUsage: o.tokenUsage,
      role: o.role
    })),
    startedAt: typeof r.startedAt,
    hasDoneAt: r.doneAt !== undefined
  }
}

// ── 用例 ──

;(async () => {
  const mod = await loadStore()
  const store = mod.useGatewayStore
  if (!store) {
    console.log('  ✗ 无法加载 useGatewayStore（esbuild bundle 失败）')
    process.exit(1)
  }
  const S = () => store.getState()

  console.log('\n[0] 初始槽位为空 + 无当前轮时事件一律忽略')
  {
    eq(roundSnap(store), null, '初始 round 为 null')
    eq(S().dismissed, false, '初始 dismissed=false')
    S().handleSubUpdate({ roundId: 'r-x', index: 0, modelId: 'm', providerId: 'p', content: 'x', status: 'running' })
    S().handleAggStart({ roundId: 'r-x' })
    S().handleAggChunk({ roundId: 'r-x', text: 'x', done: false })
    S().handleRoundDone({ roundId: 'r-x', success: true, durationMs: 1 })
    eq(roundSnap(store), null, '无当前轮 → 四类事件全部被丢弃（round 仍为 null）')
  }

  console.log('\n[1] roundStart：新轮次直接替换旧轮 + pending 占位（按 index 排序）+ dismissed 复位')
  {
    S().dismiss()
    eq(S().dismissed, true, '前置：dismissed=true（模拟用户已返回会话轮次）')
    S().handleRoundStart({
      roundId: 'r1',
      mode: 'aggregate',
      subModels: [
        { index: 2, modelId: 'm-c', role: 'critic' },
        { index: 0, modelId: 'm-a', role: '' },
        { index: 1, modelId: 'm-b', role: '' }
      ],
      aggregator: { modelId: 'agg-1' }
    })
    const r = S().round
    eq(r.roundId, 'r1', 'roundId 落位')
    eq(r.mode, 'aggregate', 'mode 落位')
    eq(r.running, true, 'running=true（轮次开始）')
    eq(r.aggRunning, false, 'aggRunning=false（聚合未开始）')
    eq(r.aggText, '', 'aggText 置空')
    eq(r.subOutputs.map((o) => o.index), [0, 1, 2], '占位按清单 index 排序（乱序清单 → 0,1,2）')
    eq(r.subOutputs.map((o) => o.status), ['pending', 'pending', 'pending'], '占位状态均为 pending')
    eq(r.subOutputs.map((o) => o.modelId), ['m-a', 'm-b', 'm-c'], '占位 modelId 来自清单')
    eq(r.subOutputs[2].role, 'critic', '占位保留角色（role=critic）')
    eq(r.subOutputs[0].providerId, '', '占位 providerId 为空（清单不含厂商）')
    eq(S().dismissed, false, '新轮次重置 dismissed')

    S().handleRoundStart({ roundId: 'r2', mode: 'direct', subModels: [{ index: 0, modelId: 'm-d', role: '' }] })
    eq(S().round.roundId, 'r2', '新 roundStart 直接替换旧轮（单槽位，无历史）')
    eq(S().round.mode, 'direct', 'mode 为 direct')
    eq(S().round.subOutputs.length, 1, '占位随新轮清单重建（旧轮子模型面板不残留）')
  }

  console.log('\n[2] subUpdate：累计覆盖 + 乱序 index 排序插入 + 占位角色保留')
  {
    S().handleRoundStart({
      roundId: 'r3',
      mode: 'aggregate',
      subModels: [
        { index: 0, modelId: 'm-a', role: 'critic' },
        { index: 1, modelId: 'm-b', role: '' }
      ]
    })
    S().handleSubUpdate({ roundId: 'r3', index: 0, modelId: 'm-a', providerId: 'p1', content: '第一段', status: 'running' })
    eq(S().round.subOutputs[0].content, '第一段', 'running 更新覆盖累计文本')
    eq(S().round.subOutputs[0].status, 'running', 'status=running')
    eq(S().round.subOutputs[0].role, 'critic', 'payload 未带 role → 占位角色保留')
    S().handleSubUpdate({ roundId: 'r3', index: 0, modelId: 'm-a', providerId: 'p1', content: '第一段+第二段', status: 'running' })
    eq(S().round.subOutputs[0].content, '第一段+第二段', '再次 running：累计文本整体覆盖')
    S().handleSubUpdate({
      roundId: 'r3', index: 0, modelId: 'm-a', providerId: 'p1',
      content: '第一段+第二段', status: 'success', durationMs: 1234, tokenUsage: { prompt: 10, completion: 20 }
    })
    const done0 = S().round.subOutputs[0]
    eq(done0.status, 'success', '终态 success')
    eq(done0.durationMs, 1234, 'durationMs 落位')
    eq(done0.tokenUsage, { prompt: 10, completion: 20 }, 'tokenUsage 落位')

    // 乱序插入：index 5 先到、index 2 后到（均不在 roundStart 清单）
    S().handleSubUpdate({ roundId: 'r3', index: 5, modelId: 'm-e', providerId: 'p2', content: '尾', status: 'running' })
    S().handleSubUpdate({ roundId: 'r3', index: 2, modelId: 'm-c', providerId: 'p3', content: '中', status: 'running' })
    eq(S().round.subOutputs.map((o) => o.index), [0, 1, 2, 5], '未知 index 插入后仍按 index 升序（2 插在 1 与 5 之间）')
    eq(S().round.subOutputs.length, 4, '插入不重复（两次新增 → 4 个面板）')
    eq(S().round.subModels.length, 2, 'roundStart 清单不被 subUpdate 改写')
  }

  console.log('\n[3] aggStart / aggChunk：累计覆盖 + done 终态收口')
  {
    S().handleRoundStart({ roundId: 'r4', mode: 'aggregate', subModels: [{ index: 0, modelId: 'm-a', role: '' }] })
    S().handleAggStart({ roundId: 'r4' })
    eq(S().round.aggRunning, true, 'aggStart → aggRunning=true')
    S().handleAggChunk({ roundId: 'r4', text: '融', done: false })
    eq(S().round.aggText, '融', 'aggChunk 累计文本覆盖')
    eq(S().round.aggRunning, true, 'done=false → 仍运行中')
    S().handleAggChunk({ roundId: 'r4', text: '融合稿', done: false })
    eq(S().round.aggText, '融合稿', '再次覆盖（text 为累计全量）')
    S().handleAggChunk({ roundId: 'r4', text: '融合稿', done: true })
    eq(S().round.aggText, '融合稿', '终态文本保留')
    eq(S().round.aggRunning, false, 'done=true → aggRunning=false')
  }

  console.log('\n[4] roundDone：正常完成 / aborted 中止（直播停在中断处，已收文本保留）')
  {
    S().handleRoundDone({ roundId: 'r4', success: true, durationMs: 5000 })
    const r4 = S().round
    eq(r4.running, false, 'running=false')
    eq(r4.success, true, 'success 落位')
    eq(r4.aborted, false, 'aborted 归一为 false（payload 未带）')
    eq(typeof r4.doneAt, 'number', 'doneAt 落位')
    eq(r4.aggRunning, false, 'aggRunning 收口为 false')

    S().handleRoundStart({
      roundId: 'r5',
      mode: 'aggregate',
      subModels: [{ index: 0, modelId: 'm-a', role: '' }, { index: 1, modelId: 'm-b', role: '' }]
    })
    S().handleSubUpdate({ roundId: 'r5', index: 0, modelId: 'm-a', providerId: 'p1', content: '半段文本', status: 'running' })
    S().handleRoundDone({ roundId: 'r5', success: false, error: '已中止', aborted: true, durationMs: 800 })
    const r5 = S().round
    eq(r5.running, false, '中止 → running=false')
    eq(r5.success, false, '中止 → success=false')
    eq(r5.aborted, true, 'aborted=true')
    eq(r5.error, '已中止', 'error 保留引擎文案')
    eq(r5.subOutputs[0].content, '半段文本', '直播停在中断处：已收文本保留')
    eq(r5.subOutputs[1].status, 'pending', '未开始的子模型保持 pending')
  }

  console.log('\n[5] 迟到事件：roundId 不匹配当前轮一律忽略')
  {
    S().handleRoundStart({ roundId: 'r6', mode: 'compare', subModels: [{ index: 0, modelId: 'm-a', role: '' }] })
    const before = JSON.stringify(roundSnap(store))
    const beforeDismissed = S().dismissed
    S().handleSubUpdate({ roundId: 'r5', index: 0, modelId: 'm-旧', providerId: 'p9', content: '旧轮文本', status: 'running' })
    S().handleAggStart({ roundId: 'r5' })
    S().handleAggChunk({ roundId: 'r5', text: '旧轮聚合', done: true })
    S().handleRoundDone({ roundId: 'r5', success: false, aborted: true, durationMs: 1 })
    eq(JSON.stringify(roundSnap(store)), before, '旧轮四类事件全部被丢弃（当前轮状态逐字段不变）')
    eq(S().dismissed, beforeDismissed, 'dismissed 不受迟到事件影响')
    eq(S().round.roundId, 'r6', '当前轮仍为 r6')
    eq(S().round.aggText, '', '迟到 aggChunk 未污染当前轮 aggText')
  }

  console.log('\n[6] dismiss / restore：视图回切标记')
  {
    eq(S().dismissed, false, '前置：dismissed=false')
    S().dismiss()
    eq(S().dismissed, true, 'dismiss() → true（会话视图显示回切标记）')
    eq(S().round.roundId, 'r6', 'dismiss 不影响轮次数据（轮次继续进行）')
    S().handleRoundDone({ roundId: 'r6', success: true, durationMs: 2 })
    eq(S().dismissed, true, '轮次结束不自动复位 dismissed')
    S().restore()
    eq(S().dismissed, false, 'restore() → false（切回代理监视视图）')
    S().dismiss()
    S().handleRoundStart({ roundId: 'r7', mode: 'direct', subModels: [{ index: 0, modelId: 'm-z', role: '' }] })
    eq(S().dismissed, false, '新轮次 roundStart 重置 dismissed（再次接管画面）')
  }

  console.log('\n[7] 完整一轮：事件全序列后的状态终值')
  {
    S().handleRoundStart({
      roundId: 'r8',
      mode: 'aggregate',
      subModels: [
        { index: 0, modelId: 'sub-a', role: 'critic' },
        { index: 1, modelId: 'sub-b', role: '' }
      ],
      aggregator: { modelId: 'agg-1' }
    })
    S().handleSubUpdate({ roundId: 'r8', index: 0, modelId: 'sub-a', providerId: 'p1', content: '甲', status: 'running', role: 'critic' })
    S().handleSubUpdate({ roundId: 'r8', index: 1, modelId: 'sub-b', providerId: 'p1', content: '乙', status: 'running' })
    S().handleSubUpdate({
      roundId: 'r8', index: 0, modelId: 'sub-a', providerId: 'p1',
      content: '甲乙', status: 'success', durationMs: 900, tokenUsage: { prompt: 3, completion: 2 }, role: 'critic'
    })
    S().handleSubUpdate({ roundId: 'r8', index: 1, modelId: 'sub-b', providerId: 'p1', content: '乙', status: 'success', durationMs: 700 })
    S().handleAggStart({ roundId: 'r8' })
    S().handleAggChunk({ roundId: 'r8', text: '融', done: false })
    S().handleAggChunk({ roundId: 'r8', text: '融合稿', done: true })
    S().handleRoundDone({ roundId: 'r8', success: true, durationMs: 1500 })

    eq(
      roundSnap(store),
      {
        roundId: 'r8',
        mode: 'aggregate',
        running: false,
        success: true,
        aborted: false,
        error: undefined,
        aggText: '融合稿',
        aggRunning: false,
        subModels: [
          { index: 0, modelId: 'sub-a', role: 'critic' },
          { index: 1, modelId: 'sub-b', role: '' }
        ],
        subOutputs: [
          {
            index: 0, modelId: 'sub-a', providerId: 'p1', content: '甲乙', status: 'success',
            error: undefined, durationMs: 900, tokenUsage: { prompt: 3, completion: 2 }, role: 'critic'
          },
          {
            index: 1, modelId: 'sub-b', providerId: 'p1', content: '乙', status: 'success',
            error: undefined, durationMs: 700, tokenUsage: undefined, role: ''
          }
        ],
        startedAt: 'number',
        hasDoneAt: true
      },
      '完整一轮终值：两个子模型 success 终态 + 聚合终态 + 轮次完成标记'
    )
    eq(S().round.error, undefined, '成功轮次无 error 值')
  }

  console.log('\n[8] 订阅注册（initGatewaySubscriptions）：5 事件接线 + roundStart 回调 + 统一解绑')
  {
    // 假 moaAPI（与 preload 暴露的 5 个 onGatewayXxx 形态一致；解绑即从订阅表移除回调）
    const handlers = {}
    const unsubbed = []
    const api = {}
    for (const [method, key] of [
      ['onGatewayRoundStart', 'roundStart'],
      ['onGatewaySubUpdate', 'subUpdate'],
      ['onGatewayAggStart', 'aggStart'],
      ['onGatewayAggChunk', 'aggChunk'],
      ['onGatewayRoundDone', 'roundDone']
    ]) {
      api[method] = (cb) => {
        handlers[key] = cb
        return () => { delete handlers[key]; unsubbed.push(key) }
      }
    }
    globalThis.window = { moaAPI: api }
    const switches = []
    const unsub = mod.initGatewaySubscriptions(() => switches.push('monitor'))

    handlers.roundStart({ roundId: 'r9', mode: 'aggregate', subModels: [{ index: 0, modelId: 'm-a', role: '' }] })
    eq(S().round.roundId, 'r9', 'roundStart 事件进入 store（槽位接管）')
    eq(switches, ['monitor'], 'roundStart 回调触发（App 据此自动切监控视图）')
    handlers.subUpdate({ roundId: 'r9', index: 0, modelId: 'm-a', providerId: 'p1', content: '流式', status: 'running' })
    eq(S().round.subOutputs[0].content, '流式', 'subUpdate 事件进入 store')
    handlers.aggStart({ roundId: 'r9' })
    handlers.aggChunk({ roundId: 'r9', text: '聚合', done: false })
    eq([S().round.aggRunning, S().round.aggText], [true, '聚合'], 'aggStart / aggChunk 事件进入 store')
    handlers.roundDone({ roundId: 'r9', success: true, durationMs: 10 })
    eq([S().round.running, S().round.success], [false, true], 'roundDone 事件进入 store')

    unsub()
    eq(unsubbed.slice().sort(), ['aggChunk', 'aggStart', 'roundDone', 'roundStart', 'subUpdate'].sort(), '统一解绑：5 个订阅全部退订')
    eq(handlers.subUpdate, undefined, '解绑后回调已从订阅表移除（迟到事件不会进入 store）')
    delete globalThis.window
  }

  console.log('\n──────────────────────────────')
  console.log(`通过 ${pass} / 失败 ${fail}`)
  process.exit(fail === 0 ? 0 : 1)
})()
