// OpenCode Go 接入回归：① 监控源补种（升级路径）② index.ts 监控 IPC 分派结构断言
// 用法：npm run test:opencode-integration   （或 node test-e2e/opencode-integration.cjs [源码根]）
//
// 背景（封堵评审 7992443 的两个断言缺口，均为第一类问题「变异存活」）：
//   S1 变异 c / c2 存活：删掉 / 挪后 ensureMonitorSources 调用，23 套件全量回归全绿——
//      补种是已有用户升级后看到 opencode 源的**唯一路径**（raw.monitoring.sources 存在时
//      整体覆盖默认值）；c2（补种挪到账号补建之后）会造成「源出现、账号缺失、面板永不渲染」
//      的静默失效。本脚本 stub db/database 驱动真实 mergeSettings，断言补种 + 账号补建 +
//      幂等 + 禁用不复活 + 读侧不落库。
//   S2 变异 g 存活：让 opencode 也走 markUsageCollected 无任何套件能发现。本脚本对 index.ts
//      监控 IPC 段做结构断言（仿 vendor-billing [14] 的挂接自证先例）：LOGIN 拒绝分支 /
//      REFRESH 挂接 refreshOpenCodeUsage / markUsageCollected 占位仅 cc/mimo。

const path = require('path')
const fs = require('fs')
const esbuild = require('esbuild')

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..')
const OUT = path.join(ROOT, '.hermes', 'defense-test', 'opencode-integration.cjs')

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

/** esbuild 打包真实 appSettings.ts（stub db/database → 全局假 DB），返回 { readAppSettings } */
async function buildSettingsModule() {
  await esbuild.build({
    stdin: {
      contents: `export { readAppSettings } from '${ROOT.replace(/\\/g, '/')}/src/main/config/appSettings'`,
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outfile: OUT,
    logLevel: 'silent',
    plugins: [
      {
        name: 'stub-db',
        setup(build) {
          build.onResolve({ filter: /(^|\/)db\/database$/ }, () => ({ path: 'stub:db', namespace: 'stub' }))
          build.onLoad({ filter: /^stub:db$/, namespace: 'stub' }, () => ({
            contents: `module.exports = { getDatabase: () => globalThis.__fakeDb }`,
            loader: 'js'
          }))
        }
      }
    ]
  })
  return require(OUT)
}

/** 假 DB：isInitialized + queryOne 返回 globalThis.__rawRow；exec 记录写入（断言读路径不落库） */
function makeFakeDb() {
  const writes = []
  return {
    isInitialized: true,
    queryOne: () => (globalThis.__rawRow === undefined ? null : { value: JSON.stringify(globalThis.__rawRow) }),
    exec: (sql, params) => {
      writes.push({ sql, params })
    },
    writes
  }
}

/** 升级前用户的标准三源（raw 整体覆盖默认值的形态，不含 opencode） */
const STD_SOURCES = [
  { id: 'commandcode', type: 'commandcode', name: 'Command Code', studioUrl: 'https://x', enabled: true },
  { id: 'mimo', type: 'mimo', name: 'Xiaomi MiMo', studioUrl: 'https://x', enabled: true },
  { id: 'deepseek', type: 'deepseek', name: 'DeepSeek 开放平台', studioUrl: 'https://x', enabled: true }
]
const STD_ACCOUNTS = [
  { id: 'commandcode', sourceId: 'commandcode', label: '', billing: 'plan' },
  { id: 'mimo', sourceId: 'mimo', label: '', billing: 'plan' },
  { id: 'deepseek', sourceId: 'deepseek', label: '', billing: 'usage' }
]

async function main() {
  const mod = await buildSettingsModule()
  globalThis.__fakeDb = makeFakeDb()

  // ── 区段 A：源补种（ensureMonitorSources + ensureMonitorAccounts 顺序语义）──

  console.log('\nA1 全新用户（空库 → 默认值）')
  {
    globalThis.__rawRow = undefined
    const s = mod.readAppSettings()
    const srcs = s.monitoring.sources
    const oc = srcs.find((x) => x.type === 'opencode')
    ok(!!oc && oc.id === 'opencode', '默认 sources 含 opencode 源')
    ok(!!oc && oc.enabled === true && oc.name === 'OpenCode Go' && oc.studioUrl === 'https://opencode.ai/auth', 'opencode 源字段（name/studioUrl/enabled）正确', oc)
    const acc = s.monitoring.accounts.find((x) => x.id === 'opencode')
    ok(!!acc && acc.sourceId === 'opencode' && acc.billing === 'plan', 'opencode 默认账号 billing=plan', acc)
  }

  console.log('\nA2 已有用户升级（raw sources 无 opencode）→ 补种源 + 补建账号')
  {
    globalThis.__rawRow = { monitoring: { sources: STD_SOURCES, accounts: STD_ACCOUNTS, autoRefreshMinutes: 10 } }
    const s = mod.readAppSettings()
    const srcs = s.monitoring.sources
    ok(srcs.length === 4 && srcs.filter((x) => x.type === 'opencode').length === 1, 'sources 补到 4 条且 opencode 仅 1 条', srcs.map((x) => x.id))
    const acc = s.monitoring.accounts.find((x) => x.id === 'opencode')
    // 关键顺序断言：补种必须发生在账号补建之前——顺序颠倒时本断言红（变异 c2 实测）
    ok(!!acc && acc.sourceId === 'opencode' && acc.billing === 'plan', 'opencode 账号补建且 billing=plan（补种先于账号补建）', acc)
  }

  console.log('\nA3 幂等（连续两次读结果一致、无重复）')
  {
    const a = mod.readAppSettings()
    const b = mod.readAppSettings()
    ok(JSON.stringify(a.monitoring) === JSON.stringify(b.monitoring), '两次读取 monitoring 全等（幂等）')
    ok(a.monitoring.sources.filter((x) => x.type === 'opencode').length === 1, 'opencode 源不重复')
    ok(a.monitoring.accounts.filter((x) => x.sourceId === 'opencode').length === 1, 'opencode 账号不重复')
  }

  console.log('\nA4 禁用不复活（按 type 存在性判定，enabled:false 保持原样）')
  {
    globalThis.__rawRow = {
      monitoring: {
        sources: [...STD_SOURCES, { id: 'opencode', type: 'opencode', name: 'OpenCode Go', studioUrl: 'https://opencode.ai/auth', enabled: false }],
        accounts: [...STD_ACCOUNTS, { id: 'opencode', sourceId: 'opencode', label: '', billing: 'plan' }],
        autoRefreshMinutes: 10
      }
    }
    const s = mod.readAppSettings()
    const list = s.monitoring.sources.filter((x) => x.type === 'opencode')
    ok(list.length === 1 && list[0].enabled === false, '禁用态保持 false、无重复追加', list)
  }

  console.log('\nA5 源存在但账号缺失 → 账号补建')
  {
    globalThis.__rawRow = {
      monitoring: {
        sources: [...STD_SOURCES, { id: 'opencode', type: 'opencode', name: 'OpenCode Go', studioUrl: 'https://opencode.ai/auth', enabled: true }],
        accounts: STD_ACCOUNTS,
        autoRefreshMinutes: 10
      }
    }
    const s = mod.readAppSettings()
    ok(s.monitoring.accounts.some((x) => x.id === 'opencode' && x.billing === 'plan'), '缺账号 → 补建（billing=plan）')
  }

  console.log('\nA6 读侧补种不落库（与既有 ensureMonitorAccounts 同语义）')
  {
    globalThis.__rawRow = { monitoring: { sources: STD_SOURCES, accounts: STD_ACCOUNTS, autoRefreshMinutes: 10 } }
    globalThis.__fakeDb.writes.length = 0
    mod.readAppSettings()
    ok(globalThis.__fakeDb.writes.length === 0, '读路径未写库（无迁移触发时 raw 不变）', globalThis.__fakeDb.writes)
  }

  // ── 区段 B：index.ts 监控 IPC 分派结构断言（封堵变异 g：opencode 误加 markUsageCollected）──

  console.log('\nB1 index.ts 监控 IPC 分派（结构断言）')
  {
    const idxSrc = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8').split('\r').join('')

    ok(idxSrc.includes("from './monitoring/opencode'"), 'index.ts 导入 monitoring/opencode')
    ok(
      idxSrc.includes('logoutOpenCode') && idxSrc.includes('getOpenCodeStatus') && idxSrc.includes('refreshOpenCodeUsage'),
      'opencode 三函数（status/logout/refresh）均被引用'
    )

    // LOGIN 段（MONITOR_LOGIN → MONITOR_LOGOUT）：opencode 必须走拒绝分支，不得落到 CC 登录窗
    const loginSeg = idxSrc.slice(idxSrc.indexOf('IPC.MONITOR_LOGIN'), idxSrc.indexOf('IPC.MONITOR_LOGOUT'))
    ok(loginSeg.includes("source.type === 'opencode'"), 'MONITOR_LOGIN 含 opencode 分支')
    ok(loginSeg.includes('无登录窗'), 'opencode 登录分支返回「无登录窗」明确错误（不开 Command Code 登录窗）')

    // REFRESH 段（MONITOR_REFRESH → PRICING_PROBE_RUN）
    const refreshSeg = idxSrc.slice(idxSrc.indexOf('IPC.MONITOR_REFRESH'), idxSrc.indexOf('IPC.PRICING_PROBE_RUN'))
    ok(refreshSeg.includes('refreshOpenCodeUsage('), 'REFRESH 挂接 refreshOpenCodeUsage')
    const occupyLines = refreshSeg.split('\n').filter((l) => l.includes('markUsageCollected('))
    ok(occupyLines.length === 1, 'markUsageCollected 占位仅一处', occupyLines)
    ok(occupyLines.every((l) => !l.includes("'opencode'")), 'opencode 不参与 markUsageCollected 占位（不参与后台采集）', occupyLines)

    // LOGOUT 段（MONITOR_LOGOUT → MONITOR_SET_API_KEY）
    const logoutSeg = idxSrc.slice(idxSrc.indexOf('IPC.MONITOR_LOGOUT'), idxSrc.indexOf('IPC.MONITOR_SET_API_KEY'))
    ok(logoutSeg.includes('logoutOpenCode(accountId)'), 'LOGOUT 追加 logoutOpenCode（只删本账号键）')
  }

  console.log(`\n${pass} 通过，${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
