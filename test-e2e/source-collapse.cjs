// 纯 Node 测试：src/renderer/src/lib/sourceCollapse.ts（云监控来源折叠状态）
//              + CloudMonitorView.tsx 折叠接线结构断言
// 覆盖：① lib 读写语义——默认展开 / 折叠落 localStorage / 展开移除记录 / 多源隔离 /
//          跨模块实例恢复 / 损坏 JSON / 非数组 / 数组含非法项 / 无 localStorage / 写入失败降级
//      ② 四个来源面板（CC / OpenCode / MiMo / DeepSeek）的折叠接线：
//          hook 调用、内容包裹、chevron 按钮（漏改任一面板 → 对应断言红）
// 用法：node test-e2e/source-collapse.cjs
// 返回码：全部通过 0，有失败 1
const fs = require('fs')
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

// ── 模块加载（esbuild bundle sourceCollapse.ts；每次调用 = 全新模块实例，模块级缓存重置） ──

async function loadModule() {
  let esbuild
  try {
    esbuild = require('esbuild')
  } catch {
    throw new Error('缺少 esbuild（随 vite 安装）：请在项目根目录执行 npm i 后再跑本脚本')
  }
  const result = await esbuild.build({
    entryPoints: [path.resolve(__dirname, '../src/renderer/src/lib/sourceCollapse.ts')],
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

// ── localStorage stub（node 26 自带 webstorage，必须显式覆盖） ──

const STORAGE_KEY = 'moa-cloud-collapsed-sources'

function makeFakeStorage() {
  const map = new Map()
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v))
    },
    removeItem: (k) => {
      map.delete(k)
    }
  }
}

function installStorage(value) {
  Object.defineProperty(globalThis, 'localStorage', { value, configurable: true, writable: true })
}

/** 预置 storage 内容（模拟上次会话留下的记录） */
function seedStorage(raw) {
  const store = makeFakeStorage()
  if (raw !== undefined) store.map.set(STORAGE_KEY, raw)
  installStorage(store)
  return store
}

async function main() {
  // ── [1] 读写语义 ──
  console.log('[1] 读写语义（默认展开 / 折叠落盘 / 展开移除 / 多源隔离）')
  let store = seedStorage()
  let mod = await loadModule()
  eq(mod.isSourceCollapsed('cc'), false, '未写入 → 展开')
  mod.setSourceCollapsed('cc', true)
  eq(mod.isSourceCollapsed('cc'), true, '折叠后 → 已折叠')
  eq(JSON.parse(store.map.get(STORAGE_KEY)), ['cc'], '折叠落 localStorage（仅列折叠源 id）')
  mod.setSourceCollapsed('mimo', true)
  mod.setSourceCollapsed('cc', false)
  eq(mod.isSourceCollapsed('cc'), false, '展开后 → 未折叠')
  eq(mod.isSourceCollapsed('mimo'), true, '同源展开不影响其它源（多源隔离）')
  eq(JSON.parse(store.map.get(STORAGE_KEY)), ['mimo'], '展开的源从记录中移除')

  // ── [2] 跨模块实例恢复（模拟重进页面 / 应用重启） ──
  console.log('[2] 跨实例恢复与脏数据容错')
  seedStorage(JSON.stringify(['opencode']))
  mod = await loadModule()
  eq(mod.isSourceCollapsed('opencode'), true, '预置记录 → 新实例读到折叠')
  eq(mod.isSourceCollapsed('cc'), false, '未记录的源 → 新实例默认展开')

  seedStorage('{oops')
  mod = await loadModule()
  eq(mod.isSourceCollapsed('cc'), false, '损坏 JSON → 按无记录处理（不抛错）')

  seedStorage('{"a":1}')
  mod = await loadModule()
  eq(mod.isSourceCollapsed('a'), false, '非数组 JSON → 按无记录处理')

  seedStorage(JSON.stringify(['cc', 123, '', null]))
  mod = await loadModule()
  eq(mod.isSourceCollapsed('cc'), true, '数组含非法项 → 合法项照常读取')
  eq(mod.isSourceCollapsed('123'), false, '数组含非法项 → 非字符串项忽略')

  // ── [3] 存储不可用 / 写入失败降级 ──
  console.log('[3] 存储不可用与写入失败降级（会话内仍可折叠）')
  installStorage(undefined)
  mod = await loadModule()
  eq(mod.isSourceCollapsed('cc'), false, '无 localStorage → 默认展开')
  mod.setSourceCollapsed('cc', true)
  eq(mod.isSourceCollapsed('cc'), true, '无 localStorage → 会话内折叠仍生效（内存兜底）')

  const throwing = makeFakeStorage()
  throwing.setItem = () => {
    throw new Error('QuotaExceededError')
  }
  installStorage(throwing)
  mod = await loadModule()
  let threw = false
  try {
    mod.setSourceCollapsed('cc', true)
  } catch {
    threw = true
  }
  ok(!threw, 'setItem 抛错 → 不向调用方抛（不阻断交互）')
  eq(mod.isSourceCollapsed('cc'), true, 'setItem 抛错 → 会话内状态已更新')

  // ── [4] CloudMonitorView 折叠接线结构断言 ──
  console.log('[4] CloudMonitorView.tsx 四个来源面板的折叠接线')
  const src = fs
    .readFileSync(path.resolve(__dirname, '../src/renderer/src/components/CloudMonitorView.tsx'), 'utf8')
    .split('\r')
    .join('')
  ok(src.includes("from '../lib/sourceCollapse'"), 'lib 模块已 import')

  const panels = ['CommandCodePanel', 'OpenCodePanel', 'MimoPanel', 'DeepSeekPanel']
  /** 取模块级函数段（下一个行首 function 为界） */
  function segment(name) {
    const mark = `function ${name}(`
    const i = src.indexOf(mark)
    if (i < 0) throw new Error('未找到面板函数: ' + name)
    const j = src.indexOf('\nfunction ', i + mark.length)
    return src.slice(i, j < 0 ? src.length : j)
  }
  for (const name of panels) {
    const seg = segment(name)
    ok(seg.includes('useSourceCollapsed(source.id)'), `${name}：调用折叠 hook`)
    ok(seg.includes('{!collapsed && ('), `${name}：内容区按折叠条件包裹`)
    ok(
      seg.indexOf('useSourceCollapsed(source.id)') < seg.indexOf('{!collapsed && ('),
      `${name}：hook 声明在折叠包裹之前`
    )
    ok(seg.includes('onClick={toggleCollapsed}'), `${name}：标题行有折叠按钮`)
    ok(seg.includes('ChevronDown') && seg.includes("'-rotate-90'"), `${name}：chevron 折叠态旋转`)
    // 折叠态补文字状态：必须在 h2 内（标题行常驻），且区分登录过期态
    const statusIdx = seg.indexOf('{collapsed && (')
    ok(statusIdx > 0 && statusIdx < seg.indexOf('</h2>'), `${name}：折叠态文字状态在 h2 内（标题行常驻）`)
    ok(seg.includes("errorCode === 'session_expired' ? 'bg-yellow-500'"), `${name}：登录过期时状态点转黄`)
    ok(seg.includes("'登录已过期'") || seg.includes("'API Key 已失效'"), `${name}：折叠态含过期文案`)
  }
  eq(src.split('useSourceCollapsed(source.id)').length - 1, 4, '全文件折叠 hook 调用恰好 4 处')
  eq(src.split('{!collapsed && (').length - 1, 4, '全文件折叠包裹恰好 4 处')
  eq(src.split('{collapsed && (').length - 1, 4, '全文件折叠态文字状态恰好 4 处')

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
