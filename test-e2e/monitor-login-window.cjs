// 登录窗行为：会话失效后「重新登录」必须真正打开登录窗（Command Code / MiMo / DeepSeek 三源）
// 用法：npm run test:login-window
//
// 背景（真实报障）：Command Code 登录失效后点「重新登录」呼不出登录窗。
// 根因两层，缺一都会让重登走不完：
//   1) 开窗前的短路复用 —— 分区 cookie jar 里还有旧 session cookie（服务端已失效/被吊销，
//      但 cookie 本身没过期）就直接 resolve success、不建窗口 → 刷新依旧 401 → 错误条回来，
//      用户观感是「点了没反应」（MiMo 的 cookie 约 24h 到期后会被浏览器移除，所以日常不触发）。
//   2) 只删短路也不够 —— 旧凭证仍在分区里，窗口一开轮询 1.5s 内就命中它 → 窗口闪一下即关、
//      依旧返回 success，照样走不到重新登录。
// 所以正确行为是：开窗前清掉该源登录分区的旧凭证，让窗口里必然是登录页、
// 轮询只可能捕获本次新登录产生的凭证。
//
// 本脚本用 stub Electron（session.fromPartition / BrowserWindow）驱动**真实**的三个 login 函数，断言：
//   1) 分区残留旧凭证时仍创建登录窗（旧代码此处短路 → 红）
//   2) 开窗前清空了该分区旧凭证（旧代码从不清理 → 红）
//   3) 窗口内完成登录 → 关窗宽限期捕获成功 → key-store 里是本次新凭证（保证没改坏正常登录链路）
const fs = require('fs')
const path = require('path')
const esbuild = require('esbuild')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, '.hermes', 'defense-test', 'monitor-login-window.cjs')

// ─── Electron stub（进程内单例，测试代码经 globalThis.__moaStub 读写同一份状态）───
const ELECTRON_STUB = `
const st = (globalThis.__moaStub = globalThis.__moaStub || { partitions: new Map(), windows: [], clearCalls: [] })
function part(name) {
  if (!st.partitions.has(name)) st.partitions.set(name, { name, cookies: [], localstorageToken: '' })
  return st.partitions.get(name)
}
class WebContents {
  constructor(p) { this.p = p; this.handlers = {} }
  on(ev, cb) { (this.handlers[ev] = this.handlers[ev] || []).push(cb) }
  emit(ev) { (this.handlers[ev] || []).forEach((cb) => cb()) }
  // DeepSeek 从页面 localStorage 读 userToken：返回 stub 分区里"页面当前"解析出的 token
  async executeJavaScript() { return this.p.localstorageToken || '' }
}
class BrowserWindow {
  constructor(opts) {
    this.opts = opts
    this.part = opts.webPreferences.session.__part
    this.handlers = {}
    this.destroyed = false
    this.webContents = new WebContents(this.part)
    st.windows.push(this)
  }
  on(ev, cb) { (this.handlers[ev] = this.handlers[ev] || []).push(cb) }
  emit(ev) { (this.handlers[ev] || []).forEach((cb) => cb()) }
  focus() {}
  isDestroyed() { return this.destroyed }
  loadURL(url) { this.url = url; return Promise.resolve() }
  close() { if (this.destroyed) return; this.destroyed = true; this.emit('closed') }
}
const ipcHandlers = new Map()
const os = require('os')
const fsMod = require('fs')
const userData = fsMod.mkdtempSync(require('path').join(os.tmpdir(), 'moa-login-win-test-'))
module.exports = {
  app: { getPath: () => userData, getVersion: () => '0.0.0-test' },
  ipcMain: {
    handle: (c, fn) => { ipcHandlers.set(c, fn) },
    on: () => undefined, once: () => undefined, removeListener: () => undefined, removeAllListeners: () => undefined
  },
  // key-store 走 safeStorage 加密链路；测试环境声明不可用 → 回退明文存取，行为等价可断言
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s) => Buffer.from(String(s), 'utf8'),
    decryptString: (b) => Buffer.from(b).toString('utf8')
  },
  BrowserWindow,
  session: {
    fromPartition(name) {
      const p = part(name)
      if (!p.__ses) {
        p.__ses = {
          __part: p,
          cookies: {
            get: async (filter) => {
              const all = p.cookies.slice()
              return filter && filter.name ? all.filter((c) => c.name === filter.name) : all
            }
          },
          clearStorageData: async (opts) => {
            st.clearCalls.push({ partition: name, opts: opts || null })
            // 真实 API：storages 未指定 = 清全部类型
            const list = opts && opts.storages ? opts.storages : null
            const hit = (t) => !list || list.indexOf(t) !== -1
            if (hit('cookies')) p.cookies = []
            if (hit('localstorage')) p.localstorageToken = ''
          }
        }
      }
      return p.__ses
    }
  }
}
`

// esbuild 的同步 API 不支持 plugins，构建放异步入口（见 main）
async function buildBundle() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  await esbuild.build({
    stdin: {
      contents: [
        "export { loginToCommandCode } from './src/main/monitoring/commandCode'",
        "export { loginToMimo } from './src/main/monitoring/mimo'",
        "export { loginToDeepSeek } from './src/main/monitoring/deepseek'",
        "export { getUsageCredential, saveUsageCredential, removeUsageCredential } from './src/main/store/key-store'"
      ].join('\n'),
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
        name: 'electron-stub',
        setup(build) {
          build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron-stub', namespace: 'stub' }))
          build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: ELECTRON_STUB, loader: 'js' }))
        }
      }
    ]
  })
  return require(OUT)
}

let api = null
// 由 main 在 bundle 构建后注入（来自被测模块，非 npm 包）
let getUsageCredential
let removeUsageCredential
const stub = {
  get partitions() {
    return globalThis.__moaStub.partitions
  },
  get windows() {
    return globalThis.__moaStub.windows
  },
  get clearCalls() {
    return globalThis.__moaStub.clearCalls
  }
}

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function withTimeout(p, ms, label) {
  let timer
  return Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(label + ' 超时 ' + ms + 'ms')), ms) })]).finally(
    () => clearTimeout(timer)
  )
}

/** 三源通用场景：分区预置「服务端已失效但仍在分区里」的旧凭证 → 登录 → 断言开窗/清理/新凭证落库 */
async function runScenario(cfg) {
  console.log('\n' + cfg.label)
  stub.partitions.delete(cfg.partition)
  stub.windows.length = 0
  stub.clearCalls.length = 0
  removeUsageCredential(cfg.credKey)
  cfg.seed()

  // v5：登录凭据按**账号**落库（入参 accountId；默认账号 id = 源 id，故 credKey 即 accountId）
  const p = cfg.login(cfg.source, cfg.credKey, null)
  await sleep(100)

  ok(stub.windows.length === 1, '分区残留旧凭证时仍打开登录窗', { windows: stub.windows.length })
  if (stub.windows.length === 0) {
    // 旧代码在开窗前短路 resolve：不阻塞，直接结束该场景
    await p
    return
  }

  ok(
    stub.clearCalls.some((c) => c.partition === cfg.partition),
    '开窗前清理了登录分区',
    stub.clearCalls
  )
  ok(cfg.partitionCleared(), '分区旧凭证已清空（轮询不会秒捕获旧凭证）')

  // 模拟用户在登录窗内完成登录：写入本次新产生的凭证
  cfg.freshLogin()
  const win = stub.windows[0]
  win.close()

  const res = await withTimeout(p, 5000, cfg.label)
  ok(res && res.success === true, '关窗（或轮询）捕获到凭证 → success', res)

  const cred = getUsageCredential(cfg.credKey)
  ok(cfg.expectCred(cred), 'key-store 存入的是本次新凭证而非旧凭证', cred)
}

async function main() {
  api = await buildBundle()
  ;({ getUsageCredential, removeUsageCredential } = api)
  const ccSource = {
    id: 'cc-test',
    type: 'commandcode',
    name: 'Command Code 云端',
    studioUrl: 'https://commandcode.ai/studio',
    enabled: true
  }
  const mimoSource = {
    id: 'mimo-test',
    type: 'mimo',
    name: 'Xiaomi MiMo',
    studioUrl: 'https://platform.xiaomimimo.com',
    enabled: true
  }
  const dsSource = {
    id: 'deepseek-test',
    type: 'deepseek',
    name: 'DeepSeek 开放平台',
    studioUrl: 'https://platform.deepseek.com',
    enabled: true
  }
  // 分区不存在则创建（等价 session.fromPartition 的惰性建分区）
  const part = (name) => {
    if (!stub.partitions.has(name)) stub.partitions.set(name, { name, cookies: [], localstorageToken: '' })
    return stub.partitions.get(name)
  }

  // 1) Command Code：旧 session cookie 还在分区里（服务端已 401）
  await runScenario({
    label: 'Command Code（报障源）',
    login: api.loginToCommandCode,
    source: ccSource,
    partition: 'persist:commandcode',
    credKey: ccSource.id,
    seed: () =>
      part('persist:commandcode').cookies.push({
        name: '__Secure-commandcode_prod_.session_token',
        domain: '.commandcode.ai',
        path: '/',
        value: 'stale-cc-token'
      }),
    partitionCleared: () => part('persist:commandcode').cookies.length === 0,
    freshLogin: () =>
      part('persist:commandcode').cookies.push({
        name: '__Secure-commandcode_prod_.session_token',
        domain: '.commandcode.ai',
        path: '/',
        value: 'fresh-cc-token'
      }),
    expectCred: (c) => c === 'fresh-cc-token'
  })

  // 2) MiMo：旧凭证（真实登录为 4 个 cookie：serviceToken/userId/slh/ph）还在分区里（服务端已吊销但 cookie 未到期）
  await runScenario({
    label: 'Xiaomi MiMo',
    login: api.loginToMimo,
    source: mimoSource,
    partition: 'persist:mimo',
    credKey: mimoSource.id,
    seed: () =>
      part('persist:mimo').cookies.push(
        { name: 'api-platform_serviceToken', domain: '.xiaomimimo.com', path: '/', value: 'stale-mimo-token' },
        { name: 'userId', domain: '.xiaomimimo.com', path: '/', value: 'user-1' },
        { name: 'api-platform_slh', domain: '.xiaomimimo.com', path: '/', value: '"stale-slh=="' },
        { name: 'api-platform_ph', domain: '.xiaomimimo.com', path: '/', value: '"stale-ph=="' }
      ),
    partitionCleared: () => part('persist:mimo').cookies.length === 0,
    freshLogin: () =>
      part('persist:mimo').cookies.push(
        { name: 'api-platform_serviceToken', domain: '.xiaomimimo.com', path: '/', value: 'fresh-mimo-token' },
        { name: 'userId', domain: '.xiaomimimo.com', path: '/', value: 'user-1' },
        { name: 'api-platform_slh', domain: '.xiaomimimo.com', path: '/', value: '"fresh-slh=="' },
        { name: 'api-platform_ph', domain: '.xiaomimimo.com', path: '/', value: '"fresh-ph=="' }
      ),
    // ph 是 POST 端点的网关要求（见 mimo-request.cjs 回归），捕获必须带上它
    expectCred: (c) =>
      !!c && c.indexOf('api-platform_serviceToken=fresh-mimo-token') !== -1 && c.indexOf('api-platform_ph="fresh-ph=="') !== -1
  })

  // 3) DeepSeek：旧 userToken 还在分区 localStorage 里（轮询会把它当登录态关窗）
  await runScenario({
    label: 'DeepSeek',
    login: api.loginToDeepSeek,
    source: dsSource,
    partition: 'persist:deepseek',
    credKey: dsSource.id,
    seed: () => {
      part('persist:deepseek').localstorageToken = 'stale-ds-token'
    },
    partitionCleared: () => part('persist:deepseek').localstorageToken === '',
    freshLogin: () => {
      part('persist:deepseek').localstorageToken = 'fresh-ds-token'
    },
    expectCred: (c) => c === 'fresh-ds-token'
  })

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  // 登录窗轮询 timer 仍在跑，需强制退出
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('测试执行异常:', err)
  process.exit(1)
})
