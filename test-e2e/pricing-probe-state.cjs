// 纯 Node 测试：src/renderer/src/store/probeStore.ts（定价探查运行状态同步）
// 背景：后台自动刷新由 main 进程发起，渲染进程只能靠状态事件感知；
//       事件漏接/不接会导致「后台在刷新但 UI 看不到」或「按钮被 main 拒绝」。
// 覆盖：① 结果文案映射（ok / skipped / 失败）
//      ② auto 开始事件 → busy/runningIds 同步；完成事件 → 复位 + 结果文案 + 重新拉取设置
//      ③ manual 完成事件 → 仅复位，不改写手动路径自己的结果文案
//      ④ 挂载查询兜底：订阅建立前已开始的运行态；未运行时不得覆盖本地已触发的刷新
// 用法：node test-e2e/pricing-probe-state.cjs
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
const tick = () => new Promise((r) => setTimeout(r, 0))

// ── window.moaAPI stub：记录调用次数并暴露事件发射口 ──

function makeWindowStub(statusResponse) {
  const calls = { getSettings: 0, getProbeStatus: 0 }
  let stateCb = null
  let progressCb = null
  const stub = {
    calls,
    statusResponse,
    emitState: (s) => stateCb && stateCb(s),
    emitProgress: (p) => progressCb && progressCb(p),
    moaAPI: {
      getSettings: async () => {
        calls.getSettings++
        return { success: true, data: {} }
      },
      getProbeStatus: async () => {
        calls.getProbeStatus++
        return stub.statusResponse
      },
      onProbeState: (cb) => {
        stateCb = cb
        return () => {
          stateCb = null
        }
      },
      onProbeProgress: (cb) => {
        progressCb = cb
        return () => {
          progressCb = null
        }
      }
    }
  }
  return stub
}

// ── 模块加载（esbuild bundle probeStore.ts，注入 stub window） ──

async function loadModule(win) {
  let esbuild
  try {
    esbuild = require('esbuild')
  } catch {
    throw new Error('缺少 esbuild（随 vite 安装）：请在项目根目录执行 npm i 后再跑本脚本')
  }
  const result = await esbuild.build({
    entryPoints: [path.resolve(__dirname, '../src/renderer/src/store/probeStore.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'silent'
  })
  const js = result.outputFiles[0].text
  const mod = { exports: {} }
  new Function('exports', 'module', 'require', 'window', js)(mod.exports, mod, require, win)
  return mod.exports
}

const IDLE = { success: true, data: { running: false, sourceIds: [], trigger: 'auto' } }

async function main() {
  // ── [1] 结果文案映射 ──
  console.log('[1] probeResultsToMessages 文案')
  {
    const { probeResultsToMessages } = await loadModule(makeWindowStub(IDLE))
    eq(
      probeResultsToMessages([
        { sourceId: 'a', ok: true, entryCount: 12 },
        { sourceId: 'b', ok: true, skipped: true, entryCount: 3 },
        { sourceId: 'c', ok: false, error: 'HTTP 403' }
      ]),
      { a: '已更新 12 条定价', b: '页面无变化（沿用 3 条）', c: '失败：HTTP 403' },
      'ok / skipped / 失败 三类文案'
    )
  }

  // ── [2] 后台自动刷新：开始/完成事件 → UI 状态同步 ──
  console.log('[2] auto 开始/完成事件 → UI 状态同步')
  {
    const win = makeWindowStub(IDLE)
    const { useProbeStore, initProbeStateSubscription } = await loadModule(win)
    const off = initProbeStateSubscription()

    win.emitState({ running: true, sourceIds: ['auto:p1', 'auto:p2'], trigger: 'auto' })
    let st = useProbeStore.getState()
    eq(st.busy, true, '开始事件 → busy=true（不再显示为可刷新）')
    eq([...st.runningIds].sort(), ['auto:p1', 'auto:p2'], '开始事件 → runningIds=本轮源')

    win.emitProgress({ sourceId: 'auto:p1', sourceName: 'P1', index: 1, total: 2, stage: 'fetching' })
    eq(useProbeStore.getState().progress?.sourceId, 'auto:p1', '进度事件 → progress 写入 store')

    const before = win.calls.getSettings
    win.emitState({
      running: false,
      sourceIds: [],
      trigger: 'auto',
      results: [{ sourceId: 'auto:p1', ok: true, entryCount: 4 }]
    })
    await tick()
    st = useProbeStore.getState()
    eq(st.busy, false, '完成事件 → busy=false')
    eq(st.runningIds.size, 0, '完成事件 → runningIds 清空')
    eq(st.progress, null, '完成事件 → progress 清空')
    eq(st.messages, { 'auto:p1': '已更新 4 条定价' }, '完成事件 → 结果文案写入 messages')
    eq(win.calls.getSettings, before + 1, '完成事件 → 重新拉取设置（定价数据刷新）')
    off()
  }

  // ── [3] 手动探查完成事件：只复位，不覆盖手动路径的结果文案 ──
  console.log('[3] manual 完成事件 → 仅复位')
  {
    const win = makeWindowStub(IDLE)
    const { useProbeStore, initProbeStateSubscription } = await loadModule(win)
    const off = initProbeStateSubscription()
    const st0 = useProbeStore.getState()
    st0.setBusy(true)
    st0.setRunningIds(new Set(['s1']))
    st0.setMessages({ s1: '手动结果' })
    const before = win.calls.getSettings
    win.emitState({ running: false, sourceIds: [], trigger: 'manual' })
    await tick()
    const st = useProbeStore.getState()
    eq(st.busy, false, '复位 busy')
    eq(st.messages, { s1: '手动结果' }, '不改写手动路径的 messages')
    eq(win.calls.getSettings, before, '不重复拉取设置（手动路径 runProbe 自行处理）')
    off()
  }

  // ── [4] 挂载查询：覆盖订阅建立前已开始的自动刷新 ──
  console.log('[4] 挂载查询 → 订阅前已开始的自动刷新')
  {
    const win = makeWindowStub({
      success: true,
      data: { running: true, sourceIds: ['auto:p9'], trigger: 'auto' }
    })
    const { useProbeStore, initProbeStateSubscription } = await loadModule(win)
    initProbeStateSubscription()
    await tick()
    const st = useProbeStore.getState()
    eq(st.busy, true, '查询到运行中 → busy=true')
    eq([...st.runningIds], ['auto:p9'], '查询到运行中 → runningIds=对应源')
  }

  // ── [5] 挂载查询：未运行时不覆盖本地已触发的刷新 ──
  console.log('[5] 挂载查询 → 未运行时不覆盖本地刷新')
  {
    const win = makeWindowStub(IDLE)
    const { useProbeStore, initProbeStateSubscription } = await loadModule(win)
    const st0 = useProbeStore.getState()
    st0.setBusy(true) // 模拟用户刚点击刷新（本地已置位，main 状态快照尚未包含）
    st0.setRunningIds(new Set(['s1']))
    initProbeStateSubscription()
    await tick()
    const st = useProbeStore.getState()
    eq(st.busy, true, '查询返回未运行 → 保留本地 busy=true')
    eq([...st.runningIds], ['s1'], '查询返回未运行 → 保留本地 runningIds')
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
