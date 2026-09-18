// 纯 Node 测试：src/renderer/src/lib/cloudMonitorCache.ts（云监控页面数据快照缓存）
// 覆盖：① get/patch/clear 快照读写语义（局部更新不丢其它字段、登出清空、清空后重建）
//      ② shouldFetchOnMount：无快照 / 新鲜 / 过期 / 自动刷新关闭（最小去重窗）/ TTL 边界
// 用法：node test-e2e/cloud-monitor-cache.cjs
// 加载方式：esbuild bundle cloudMonitorCache.ts（仅 type import，无运行时依赖）
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

// ── 模块加载（esbuild bundle cloudMonitorCache.ts） ──

async function loadModule() {
  let esbuild
  try {
    esbuild = require('esbuild')
  } catch {
    throw new Error('缺少 esbuild（随 vite 安装）：请在项目根目录执行 npm i 后再跑本脚本')
  }
  const result = await esbuild.build({
    entryPoints: [path.resolve(__dirname, '../src/renderer/src/lib/cloudMonitorCache.ts')],
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

// 固定时钟基准：不依赖真实时间
const T = 1_700_000_000_000
const MIN = 60_000

async function main() {
  const { getCloudSnapshot, patchCloudSnapshot, clearCloudSnapshot, shouldFetchOnMount } = await loadModule()

  // ── [1] 快照读写语义 ──
  console.log('[1] get/patch/clear 快照读写')
  const SID = 'cc-test'
  eq(getCloudSnapshot(SID), undefined, '未写入 → undefined')

  const usage = { fetchedAt: T, sourcesAvailable: {} }
  patchCloudSnapshot(SID, { usage })
  let snap = getCloudSnapshot(SID)
  eq(snap.usage, usage, '首次 patch 写入 usage')
  eq(snap.cumulative, null, '未提及字段补为 null')
  eq(snap.detailMode, null, '未提及字段补为 null（detailMode）')

  const cum = { models: [], records: 3 }
  patchCloudSnapshot(SID, { cumulative: cum })
  snap = getCloudSnapshot(SID)
  eq(snap.cumulative, cum, '二次 patch 写入 cumulative')
  eq(snap.usage, usage, '二次 patch 保留既有 usage（局部更新）')

  patchCloudSnapshot(SID, { detailMode: 'cumulative' })
  snap = getCloudSnapshot(SID)
  eq(snap.detailMode, 'cumulative', '三次 patch 写入 detailMode')
  eq(snap.cumulative, cum, '三次 patch 保留既有 cumulative')

  eq(getCloudSnapshot('other'), undefined, '不同 sourceId 互不影响')

  clearCloudSnapshot(SID)
  eq(getCloudSnapshot(SID), undefined, 'clear 后 → undefined')
  patchCloudSnapshot(SID, { detailMode: 'monthly' })
  snap = getCloudSnapshot(SID)
  eq(snap.detailMode, 'monthly', 'clear 后重建：新字段就位')
  eq(snap.usage, null, 'clear 后重建：旧 usage 不残留')
  clearCloudSnapshot(SID)

  // ── [2] shouldFetchOnMount：重进页面是否打远端 ──
  console.log('[2] shouldFetchOnMount：无快照 / 新鲜 / 过期 / 关闭自动刷新')

  eq(shouldFetchOnMount(null, 10, T), true, '无快照 → 拉取')

  const fresh = (ageMs) => ({ fetchedAt: T - ageMs })

  // 自动刷新 10 分钟：TTL = 10 分钟
  eq(shouldFetchOnMount(fresh(0), 10, T), false, '刚拉过（age=0）→ 跳过')
  eq(shouldFetchOnMount(fresh(9 * MIN + 59_000), 10, T), false, 'age=9m59s < 10m → 跳过')
  eq(shouldFetchOnMount(fresh(10 * MIN), 10, T), true, 'age=10m（TTL 边界）→ 拉取')
  eq(shouldFetchOnMount(fresh(10 * MIN + 1), 10, T), true, 'age=10m1s > 10m → 拉取')
  eq(shouldFetchOnMount(fresh(60 * MIN), 10, T), true, 'age=1h → 拉取')

  // 自动刷新关闭（0）：最小去重窗 5 分钟
  eq(shouldFetchOnMount(fresh(0), 0, T), false, '关闭自动刷新：age=0 → 跳过')
  eq(shouldFetchOnMount(fresh(4 * MIN + 59_000), 0, T), false, '关闭自动刷新：age=4m59s → 跳过')
  eq(shouldFetchOnMount(fresh(5 * MIN), 0, T), true, '关闭自动刷新：age=5m（去重窗边界）→ 拉取')
  eq(shouldFetchOnMount(fresh(30 * MIN), 0, T), true, '关闭自动刷新：age=30m → 拉取')

  // 场景闭环：拉取成功写快照 → 立刻重进跳过 → 时间推移后重进拉取
  const SID2 = 'cc-loop'
  eq(shouldFetchOnMount(getCloudSnapshot(SID2)?.usage ?? null, 15, T), true, '闭环：首进无快照 → 拉取')
  patchCloudSnapshot(SID2, { usage: { fetchedAt: T, sourcesAvailable: {} } })
  eq(shouldFetchOnMount(getCloudSnapshot(SID2).usage, 15, T), false, '闭环：写入快照后立即重进 → 跳过')
  eq(shouldFetchOnMount(getCloudSnapshot(SID2).usage, 15, T + 15 * MIN), true, '闭环：15 分钟后重进 → 拉取')
  clearCloudSnapshot(SID2)
  eq(shouldFetchOnMount(getCloudSnapshot(SID2)?.usage ?? null, 15, T), true, '闭环：登出清空后重进 → 拉取')

  // ── 汇总 ──
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
