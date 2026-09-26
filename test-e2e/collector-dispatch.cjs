// 纯 Node 测试：src/main/monitoring/collector.ts 的调度语义（按账号隔离）
// 覆盖：
//   ① 启动首采（空状态）：全部已启用源的账号各采一次
//   ② **核心回归**：页面刷新占位（markUsageCollected）只抑制本账号——
//      修复前 timer 层用「任一账号新鲜」做全局预跳过（latestCollectedAt 取 max），
//      导致主号刚刷新过的窗口内，其余已过期账号整轮轮不到采集
//   ③ 同一间隔内所有账号都不重复拉取
//   ④ 全员过期 + 新增账号：下一轮全部可采（含从未采集过的新号）
//   ⑤ 自动刷新关闭（0）：不采集
// 用法：node test-e2e/collector-dispatch.cjs
// 做法：esbuild transform collector.ts → CJS，stub require 注入假设置 / 凭据 / refresh；
//       覆写全局 setTimeout/setInterval 捕获首采与周期回调（不真等 15s/60s），
//       覆写 Date.now 控制时间线（逐账号新鲜度判定基于它）。
const fs = require('fs')
const path = require('path')
const esbuild = require('esbuild')

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

// ── 定时器捕获：startUsageCollector 注册的两个回调不真跑 ──
const timers = { firstRun: null, interval: null }
global.setTimeout = (fn, ms) => {
  if (typeof fn === 'function' && ms === 15_000) timers.firstRun = fn
  return 0 // 句柄无意义：本测试手动触发回调
}
global.setInterval = (fn, ms) => {
  if (typeof fn === 'function' && ms === 60_000) timers.interval = fn
  return 0
}

// ── 时间线控制：collector 的逐账号新鲜度判定全部基于 Date.now ──
let fakeNow = 1_700_000_000_000
Date.now = () => fakeNow

// ── stub 状态与调用记录 ──
const calls = { cc: [], mm: [], runs: [] }
const settingsState = {
  monitoring: {
    autoRefreshMinutes: 10,
    sources: [
      { id: 'cc', type: 'commandcode', name: 'CC', url: 'https://cc.example', enabled: true },
      { id: 'mm', type: 'mimo', name: 'MiMo', url: 'https://mm.example', enabled: true }
    ],
    accounts: [
      { id: 'cc-main', sourceId: 'cc', label: '主号', billing: 'plan' },
      { id: 'cc-payg', sourceId: 'cc', label: '按量号', billing: 'usage' },
      { id: 'mm-main', sourceId: 'mm', label: '', billing: 'plan' }
    ]
  }
}

const stubs = {
  'config/appSettings': { readAppSettings: () => settingsState },
  'store/key-store': { getUsageCredential: (key) => `TOKEN:${key}` },
  commandCode: {
    usageTokenKey: (accountId) => accountId,
    refreshCommandCodeUsage: async (accountId) => {
      calls.cc.push(accountId)
      return { ok: true, data: { fetchedAt: fakeNow } }
    }
  },
  mimo: {
    refreshMimoUsage: async (accountId) => {
      calls.mm.push(accountId)
      return { ok: true, persisted: 0, data: { fetchedAt: fakeNow } }
    }
  },
  usageAccumulator: {
    getCumulativeUsage: () => ({ records: 0 }),
    recordCollectorRun: (id, run) => calls.runs.push({ id, ok: run.ok })
  },
  snapshotStore: { saveUsageSnapshot: () => {} }
}

/** 加载 collector.ts：esbuild transform + new Function 注入 stub require（needle 子串匹配） */
function loadCollector() {
  const abs = path.resolve(__dirname, '../src/main/monitoring/collector.ts')
  const js = esbuild.transformSync(fs.readFileSync(abs, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  const fakeRequire = (id) => {
    const s = String(id)
    for (const needle of Object.keys(stubs)) {
      if (s.includes(needle)) return stubs[needle]
    }
    throw new Error('unexpected require: ' + s)
  }
  new Function('exports', 'module', 'require', '__dirname', js)(mod.exports, mod, fakeRequire, path.dirname(abs))
  return mod.exports
}

/** 让 collectOnce 的 async 链（stub 无真实 IO，全为 microtask）推进完成 */
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r))
}

async function main() {
  const collector = loadCollector()
  collector.startUsageCollector()
  ok(!!timers.firstRun && !!timers.interval, '启动注册首采与周期定时器')

  // ① 启动首采（空状态）：全部账号各采一次
  console.log('[1] 启动首采：全部账号各采一次')
  timers.firstRun()
  await flush()
  eq(calls.cc, ['cc-main', 'cc-payg'], 'CC 源两账号均被采集（配置顺序）')
  eq(calls.mm, ['mm-main'], 'MiMo 源账号被采集')

  // ② 核心回归：主号页面刷新占位 → 其余已过期账号不得被吞
  console.log('[2] 页面刷新占位只抑制本账号（核心回归：修复前整轮被吞）')
  fakeNow += 30_000 // 30s 后主号被占位（模拟页面手动/自动刷新）
  collector.markUsageCollected('cc-main')
  fakeNow += 10 * 60_000 - 30_000 // 距初始首采恰好 10 分钟：其余账号过期、主号仍新鲜（9.5 分钟）
  const beforeCC = calls.cc.length
  const beforeMM = calls.mm.length
  timers.interval()
  await flush()
  eq(calls.cc.slice(beforeCC), ['cc-payg'], '按量号照常采集（旧实现：latest=max 判新鲜 → 整轮被跳过）')
  eq(calls.mm.slice(beforeMM), ['mm-main'], '其它源账号照常采集')
  ok(!calls.cc.slice(beforeCC).includes('cc-main'), '被占位的主号间隔内不重复拉取')

  // ③ 间隔内不重复拉取
  console.log('[3] 同一间隔内不重复拉取')
  fakeNow += 1_000
  const n3 = calls.cc.length + calls.mm.length
  timers.interval()
  await flush()
  eq(calls.cc.length + calls.mm.length, n3, '全部账号均新鲜 → 本轮零采集')

  // ④ 全员过期 + 新增账号：下一轮全部可采
  console.log('[4] 全员过期 + 从未采集的新账号：下一轮全部可采')
  settingsState.monitoring.accounts.push({ id: 'cc-new', sourceId: 'cc', label: '新号', billing: 'usage' })
  fakeNow += 10 * 60_000
  const beforeCC4 = calls.cc.length
  timers.interval()
  await flush()
  eq(calls.cc.slice(beforeCC4), ['cc-main', 'cc-payg', 'cc-new'], '过期账号与新增账号全部采集（新号 last=0 直接命中）')

  // ⑤ 自动刷新关闭（0）：不采集
  console.log('[5] 自动刷新关闭（0）时不采集')
  settingsState.monitoring.autoRefreshMinutes = 0
  const n5 = calls.cc.length + calls.mm.length
  timers.interval()
  await flush()
  eq(calls.cc.length + calls.mm.length, n5, '关闭状态零采集')

  console.log('')
  console.log(`${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
