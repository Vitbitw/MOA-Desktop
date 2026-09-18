// 纯 Node 测试：src/renderer/src/lib/usageWindow.ts 的云端额度窗口纯函数（5h/7d 到点自动刷新）
// 覆盖：① fmtRemaining：倒计时文案（已过点/秒级/分钟/小时/天 + 向上取整边界）
//      ② isStaleAfterReset：数据快照是否早于窗口重置时刻（含相等边界与缺省字段）
//      ③ expiredWindows：待补拉窗口筛选（混合输入 / 顺序保持 / 空集）
//      ④ 补拉闭环模拟：过点+旧快照 → 检出 → 快照更新后 → 不再检出
// 用法：node test-e2e/usage-window.cjs
// 加载方式：esbuild bundle usageWindow.ts（仅 type import，无运行时依赖）
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

// ── 模块加载（esbuild bundle usageWindow.ts） ──

async function loadModule() {
  let esbuild
  try {
    esbuild = require('esbuild')
  } catch {
    throw new Error('缺少 esbuild（随 vite 安装）：请在项目根目录执行 npm i 后再跑本脚本')
  }
  const result = await esbuild.build({
    entryPoints: [path.resolve(__dirname, '../src/renderer/src/lib/usageWindow.ts')],
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

// 固定时钟基准：所有用例以 T 为 nowMs 精确计算，不依赖真实时间
const T = 1_700_000_000_000
const T_SEC = T / 1000

async function main() {
  const { fmtRemaining, isStaleAfterReset, expiredWindows } = await loadModule()

  // ── [1] fmtRemaining：倒计时文案 ──
  console.log('[1] fmtRemaining：倒计时文案（nowMs 注入固定时钟）')
  eq(fmtRemaining(T_SEC - 1, T), '窗口已重置', '已过点 1ms → 窗口已重置')
  eq(fmtRemaining(T_SEC, T), '窗口已重置', '恰好在点（remainMs=0）→ 窗口已重置')
  eq(fmtRemaining(T_SEC + 59, T), '59 秒后重置', '剩余 59s → 秒级文案')
  eq(fmtRemaining(T_SEC + 60, T), '1分钟后重置', '剩余 60s → 分钟文案（不再显示秒）')
  eq(fmtRemaining(T_SEC + 61, T), '2分钟后重置', '剩余 61s → 向上取整为 2 分钟')
  eq(fmtRemaining(T_SEC + 90, T), '2分钟后重置', '剩余 1.5 分钟 → 向上取整为 2 分钟')
  eq(fmtRemaining(T_SEC + 300, T), '5分钟后重置', '剩余 5 分钟')
  eq(fmtRemaining(T_SEC + 1500, T), '25分钟后重置', '剩余 25 分钟')
  eq(fmtRemaining(T_SEC + 5400, T), '1小时30分钟后重置', '剩余 1.5 小时')
  eq(fmtRemaining(T_SEC + 3600, T), '1小时0分钟后重置', '剩余整 1 小时（锁定 0 分钟占位行为）')
  eq(fmtRemaining(T_SEC + 86400, T), '1天0小时后重置', '剩余整 24 小时（锁定 0 小时占位行为）')
  eq(fmtRemaining(T_SEC + 93600, T), '1天2小时后重置', '剩余 26 小时')
  eq(fmtRemaining(T_SEC + 172800, T), '2天0小时后重置', '剩余整 48 小时')
  {
    // 缺省 nowMs：用真实 Date.now() 的冒烟（文案含"后重置"且不为已重置）
    const text = fmtRemaining(Math.floor(Date.now() / 1000) + 300)
    ok(text.endsWith('后重置') && !text.includes('已重置'), '缺省 nowMs（Date.now）可用：' + text)
  }

  // ── [2] isStaleAfterReset：快照是否早于重置时刻 ──
  console.log('[2] isStaleAfterReset：窗口重置后旧快照判定')
  eq(isStaleAfterReset(undefined, T, undefined), false, '无 info → false')
  eq(isStaleAfterReset({}, T, T - 1000), false, 'resetAt 缺省 → false')
  eq(isStaleAfterReset({ resetAt: T_SEC + 10 }, T, T - 100000), false, '重置时刻在未来 → false（与快照无关）')
  eq(isStaleAfterReset({ resetAt: T_SEC }, T, undefined), true, '已过点 + 快照时间未知 → true（宁视为旧）')
  eq(isStaleAfterReset({ resetAt: T_SEC }, T, T - 1000), true, '已过点 + 快照早于重置 → true')
  eq(isStaleAfterReset({ resetAt: T_SEC }, T, T), false, '已过点 + 快照恰为重置时刻 → false（>= 不算旧）')
  eq(isStaleAfterReset({ resetAt: T_SEC }, T, T + 1000), false, '已过点 + 快照晚于重置 → false（服务端已给新窗口）')
  eq(isStaleAfterReset({ resetAt: T_SEC, usedPercent: 80 }, T, T - 1), true, '带 usedPercent 的完整对象同样判定')

  // ── [3] expiredWindows：待补拉窗口筛选 ──
  console.log('[3] expiredWindows：待补拉筛选')
  eq(expiredWindows([], T, T), [], '空输入 → 空输出')
  eq(expiredWindows([undefined, undefined], T, T), [], '全 undefined → 空输出')
  {
    const stale = { resetAt: T_SEC }
    const fresh = { resetAt: T_SEC + 3600 }
    const out = expiredWindows([fresh, stale, undefined], T, T - 5000)
    eq(out.length, 1, '混合输入 → 只挑出 stale 窗口')
    ok(out[0] === stale, '挑出的是同一个对象引用（顺序保持）')
  }
  {
    // 全 stale：两个窗口都已过点，且快照时间均早于各自重置时刻（fetchedAt 需 < 每个 resetAtMs）
    const a = { resetAt: T_SEC }
    const b = { resetAt: T_SEC - 600 }
    const out = expiredWindows([a, b], T, T - 900_000)
    eq(out.length, 2, '全 stale → 全部挑出')
    ok(out[0] === a && out[1] === b, '多次检出保持输入顺序')
    // 对照：快照晚于 b 的重置时刻（服务端已翻新 b）→ 只有 a 检出
    eq(expiredWindows([a, b], T, T - 300_000), [a], '快照已晚于 b 重置 → 仅 a 检出')
  }
  eq(expiredWindows([{ resetAt: T_SEC + 60 }], T, T), [], '重置在即（未过点）→ 不检出')

  // ── [4] 补拉闭环模拟（CommandCodePanel 的核心判定链路） ──
  console.log('[4] 补拉闭环：过点+旧快照 → 检出 → 快照更新后停止')
  const fiveHour = { resetAt: T_SEC, usedPercent: 95 }
  const beforeReset = T - 60_000 // 重置前的旧快照
  eq(expiredWindows([fiveHour], T - 1000, beforeReset), [], '第 1 步：未过点 → 不检出（倒计时正常走）')
  {
    const pending = expiredWindows([fiveHour], T + 1000, beforeReset)
    eq(pending.length, 1, '第 2 步：过点 + 快照早于重置 → 检出待补拉')
  }
  eq(expiredWindows([fiveHour], T + 2000, T + 1000), [], '第 3 步：补拉后快照更新 → 不再检出（防无休止轮询）')
  {
    // 服务端持续返回旧窗口（resetAt 未滚动）时：快照已新 → 不检出（配合组件 3 次上限双保险）
    eq(expiredWindows([fiveHour], T + 300_000, T + 1000), [], '第 4 步：服务端未翻新窗口但快照已新 → 不检出')
  }

  // ── 汇总 ──
  console.log('')
  console.log('──────────────────────────────')
  console.log(`通过 ${pass} / 失败 ${fail}`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('脚本异常：', err)
  process.exit(1)
})
