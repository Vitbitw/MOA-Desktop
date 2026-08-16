import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { app, BrowserWindow } from 'electron'
import { IPC_EVENT } from '../../shared/ipc-channels'
import type { DetectedEngine, LocalModel, RuntimeState } from '../../shared/types'
import { getDatabase } from '../db/database'
import { getLocalModelById, setEngineStatus, upsertDetectedEngine } from './localManager'

const RELEASE_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest'

/** 内置运行时目录：userData/runtime。 */
const RUNTIME_DIR = (): string => path.join(app.getPath('userData'), 'runtime')

export interface RuntimeAsset {
  name: string
  url: string
  sizeBytes: number
  backend: 'cpu' | 'vulkan' | 'cuda'
}

let state: RuntimeState = { status: 'not-installed', binaryPath: '' }

/** 启动中标志（RuntimeStatus 无 'starting' 成员，用模块级 boolean 表达）。 */
let starting = false
/** 当前 llama-server 子进程（生命周期锚点）。 */
let child: ReturnType<typeof spawn> | null = null

/** 广播运行时状态到所有窗口（单一 RuntimeState 载荷，附 engineType 便于 UI 分派）。 */
function broadcast(): void {
  const payload = { engineType: 'bundled', ...state }
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(IPC_EVENT.LOCAL_ENGINE_STATUS_CHANGED, payload)
  }
}

/** 当前运行时状态；not-installed 时同步检查二进制是否存在。 */
export function getRuntimeState(): RuntimeState {
  if (state.status === 'not-installed') {
    const bin = bundledBinaryPath()
    if (fs.existsSync(bin)) state = { ...state, status: 'ready', binaryPath: bin }
  }
  return { ...state }
}

/**
 * 二进制路径的唯一真相（5b 下载目标目录必须调用 path.dirname(bundledBinaryPath())，不许另算）。
 * packaged：process.resourcesPath/runtime/<llama-server[.exe]>（对应 package.json extraResources，5b 补）
 * dev：userData/runtime/<llama-server[.exe]>（GitHub 下载兜底落点）
 */
export function bundledBinaryPath(): string {
  const fileName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  if (app.isPackaged) return path.join(process.resourcesPath, 'runtime', fileName)
  return path.join(RUNTIME_DIR(), fileName)
}

/** 获取空闲临时端口：listen(0) 拿端口后先 close 再 resolve（避免监听竞态）。 */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

/** 查询 GitHub 最新 release 的 llama-server 资产（Windows 后端：cpu/vulkan/cuda，按 tag 去重）。 */
export async function listRuntimeAssets(): Promise<RuntimeAsset[]> {
  const resp = await fetch(RELEASE_API, {
    headers: { 'User-Agent': 'moa-desktop' },
    signal: AbortSignal.timeout(15_000)
  })
  if (!resp.ok) throw new Error(`GitHub release 查询失败: HTTP ${resp.status}`)
  const body = (await resp.json()) as {
    tag_name?: string
    assets?: Array<{ name: string; browser_download_url: string; size: number }>
  }
  const tag = body.tag_name || ''
  const backendOf = (n: string): RuntimeAsset['backend'] | null => {
    const l = n.toLowerCase()
    if (l.includes('win-avx2') || l.includes('win-cpu')) return 'cpu'
    if (l.includes('win-vulkan')) return 'vulkan'
    if (l.includes('win-cuda')) return 'cuda'
    return null
  }
  const seen = new Set<string>()
  const assets: RuntimeAsset[] = []
  for (const a of body.assets || []) {
    const backend = backendOf(a.name)
    if (!backend) continue
    const key = `${backend}-${tag}`
    if (seen.has(key)) continue
    seen.add(key)
    assets.push({ name: a.name, url: a.browser_download_url, sizeBytes: a.size, backend })
  }
  return assets
}

/** 下载并解压 llama-server 二进制到 bundledBinaryPath() 所在目录（单一真相，不许另算路径）。 */
export async function ensureRuntime(backend = 'cpu'): Promise<RuntimeState> {
  if (state.status === 'downloading') return state
  const bin = bundledBinaryPath()
  // 仅 size>0 才算 ready：防上次失败遗留 0 字节/半截二进制被误判
  if (fs.existsSync(bin) && fs.statSync(bin).size > 0) {
    state = { ...state, status: 'ready', binaryPath: bin, backend, error: undefined }
    broadcast()
    return state
  }

  state = { ...state, status: 'downloading', progress: 0, backend, error: undefined }
  broadcast()
  try {
    const assets = await listRuntimeAssets()
    const asset = assets.find((a) => a.backend === backend) || assets.find((a) => a.backend === 'cpu')
    if (!asset) {
      // 风险 B 兜底：非 Windows 或资产为空时明确报错，不静默空数组
      throw new Error(process.platform === 'win32'
        ? '未找到匹配平台的 llama-server 资产'
        : '当前平台暂不支持内置运行时自动下载，请手动添加本地引擎')
    }
    const dir = path.dirname(bin)
    fs.mkdirSync(dir, { recursive: true })
    const zipPath = path.join(dir, asset.name)
    const resp = await fetch(asset.url, {
      headers: { 'User-Agent': 'moa-desktop' }, // GitHub CDN 无 UA 可能 403
      signal: AbortSignal.timeout(600_000)
    })
    if (!resp.ok) throw new Error(`下载失败: HTTP ${resp.status}`)
    const total = asset.sizeBytes || Number(resp.headers.get('content-length')) || 0
    const reader = resp.body!.getReader()
    const out = fs.createWriteStream(zipPath)
    let received = 0
    let lastPercent = -1
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      // 背压：写缓冲满时等待 drain，避免大文件内存膨胀
      if (!out.write(Buffer.from(value))) {
        await once(out, 'drain')
      }
      // 下载过程中按百分比变化广播（UI 进度条），避免停在 0%
      if (total > 0) {
        const pct = Math.min(100, Math.round((received / total) * 100))
        if (pct !== lastPercent) {
          lastPercent = pct
          state.progress = pct
          broadcast()
        }
      }
    }
    // events.once 在流触发 error 时也会自动 reject，无需额外 error 监听
    out.end()
    await once(out, 'finish')

    await extractZip(zipPath, dir)
    try { fs.unlinkSync(zipPath) } catch { /* 残留 zip 无害，忽略 */ }

    const found = findExecutableInDir(dir)
    if (!found) throw new Error('压缩包内未找到 llama-server 可执行文件')
    // Windows rename 不覆盖已存在目标（EPERM）：先清陈旧 0 字节/半截 bin 再移动
    try { fs.unlinkSync(bin) } catch { /* 陈旧目标或不存在，忽略 */ }
    fs.renameSync(found, bin)

    state = { ...state, status: 'ready', binaryPath: bin, progress: 100 }
    broadcast()
    return state
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    state = { ...state, status: 'error', error: msg }
    broadcast()
    return state
  }
}

/** 解压 zip：Windows 用 PowerShell Expand-Archive，非 Windows 用 unzip（execFile 为顶层静态 import）。 */
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (process.platform === 'win32') {
      // 路径含撇号（用户名 O'Brien 等）会截断 -Command 字符串：单引号双写转义
      const esc = (p: string) => p.replace(/'/g, "''")
      execFile('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${esc(zipPath)}' -DestinationPath '${esc(destDir)}' -Force`],
        { timeout: 120_000 }, (err) => (err ? reject(err) : resolve()))
    } else {
      execFile('unzip', ['-o', zipPath, '-d', destDir], { timeout: 120_000 }, (err) => (err ? reject(err) : resolve()))
    }
  })
}

/** 在解压目录中递归查找 llama-server 可执行文件（zip 内路径多样：bin/Release/ 或 bin/）。 */
function findExecutableInDir(dir: string): string | null {
  const targets = [
    path.join(dir, 'bin', 'Release', 'llama-server.exe'),
    path.join(dir, 'bin', 'llama-server.exe'),
    path.join(dir, 'bin', 'Release', 'llama-server'),
    path.join(dir, 'bin', 'llama-server')
  ]
  for (const t of targets) if (fs.existsSync(t)) return t
  const walk = (d: string): string | null => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) {
        const hit = walk(full)
        if (hit) return hit
      } else if (entry.name === 'llama-server.exe' || entry.name === 'llama-server') {
        return full
      }
    }
    return null
  }
  return walk(dir)
}

/** bundled 引擎行 id 的单一真相来源（R2：全应用唯一 bundled 实例）。禁止在 start 时存内存变量传给 stop。 */
function getBundledEngineId(): string | null {
  const row = getDatabase().queryOne<{ id: string }>(
    'SELECT id FROM local_engines WHERE engine_type = ?', ['bundled']
  )
  return row?.id ?? null
}

/**
 * 启动内置 llama-server（reject-if-busy）：
 * 1) starting 标志在首个 await 之前同步置 true（防并发启动竞态）
 * 2) findFreePort 拿动态端口（先 close 再 spawn）
 * 3) spawn -m <ggufPath> --host 127.0.0.1 --port <port>
 * 4) 裸根 /health 探测循环（超时 30s）→ 成功后 upsertDetectedEngine 注册 provider（baseUrl 含 /v1）
 * 5) 失败/崩溃 → error 状态 + 广播，不 throw（handler 层不 catch）
 */
export async function startBundledEngine(localModelId: string): Promise<RuntimeState> {
  // reject-if-busy：starting 标志 + running 状态双条件
  if (starting || state.status === 'running') return { ...state }
  const model = getLocalModelById(localModelId)
  if (!model) {
    state = { ...state, status: 'error', error: '本地模型不存在' }
    broadcast()
    return state
  }
  // 必须先置 starting 再 await（JS 单线程下第二次并发调用必被拦）
  starting = true
  try {
    const bin = bundledBinaryPath()
    if (!fs.existsSync(bin)) {
      state = { ...state, status: 'error', error: '内置运行时未安装，请先完成运行时下载' }
      broadcast()
      return state
    }
    const port = await findFreePort()
    state = { ...state, status: 'running', port }
    broadcast()
    // 启动子进程（-m 模型路径为必须参数，否则空载起服务聊不了天）
    child = spawn(bin, ['-m', model.ggufPath, '--host', '127.0.0.1', '--port', String(port)], {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    // 引流 stderr：Windows 命名管道缓冲填满会阻塞子进程写日志 → 假死
    child.stderr?.on('data', () => {})
    // spawn 启动失败（EACCES/ENOENT/损坏二进制）走 'error' 而非 'exit'：无监听器 = uncaught exception = 主进程崩溃
    child.once('error', (err) => {
      child = null
      state = { ...state, status: 'error', error: `llama-server 启动失败: ${err.message}` }
      broadcast()
    })
    // 健康通过 + 注册完成前保持 false：启动期 exit 走「落 error 保留原因」，运行期 exit 才走优雅 stop
    let startedOk = false
    child.once('exit', (code) => {
      child = null
      if (startedOk) {
        // 正常运行期意外退出 → 走优雅 stop（R16：禁 provider + 引擎置 stopped）
        stopBundledEngine().catch(() => {})
      } else if (state.status === 'running') {
        // 启动期退出（坏 GGUF/端口占用等）→ 直接落 error 保留崩溃原因；不调 stop（stop 会覆盖成 ready 丢原因）
        state = { ...state, status: 'error', error: `llama-server 异常退出（code ${code}）` }
        broadcast()
      }
    })
    // 健康探测：裸根 /health（chat API 在 /v1，探测必须用裸根，R15）
    const rootUrl = `http://127.0.0.1:${port}`
    const apiBaseUrl = `${rootUrl}/v1`
    const deadline = Date.now() + 30_000
    let healthy = false
    while (Date.now() < deadline) {
      if (child === null) break // spawn error 已设 error 状态，fail-fast 退出循环
      try {
        const resp = await fetch(`${rootUrl}/health`, { signal: AbortSignal.timeout(1_000) })
        if (resp.ok) { healthy = true; break }
      } catch { /* 未就绪，重试 */ }
      await new Promise((r) => setTimeout(r, 300))
    }
    if (!healthy) {
      // 判空：error/exit 监听已把 child 置 null（进程已死），此时 kill 会 null.kill() 抛 TypeError
      if (child) {
        child.kill()
        child = null
      }
      // 启动期 exit 已落 error（崩溃原因保留），不额外覆盖为超时错误
      if (state.status !== 'error') {
        throw new Error('llama-server 启动超时（30s 内 /health 未就绪）')
      }
      return state
    }
    // 健康通过：此后 exit 才走优雅 stop（startedOk=true 之后无 await，注册段全同步，健康期 exit 不会半途插入）
    startedOk = true
    // 注册 provider：models 的 id 必须用 LocalModel.modelId（推理名，文件名去 .gguf），不是 UUID 主键
    const detected: DetectedEngine = {
      engineType: 'bundled',
      name: '内置 llama.cpp',
      baseUrl: apiBaseUrl,
      port,
      reachable: true,
      models: [{ id: model.modelId, name: model.name, providerId: '' }]
    }
    upsertDetectedEngine(detected)
    // belt-and-suspenders：upsertDetectedEngine 内部已按 reachable 写 status='running'，此处再确认一次（无害冗余，不要"优化"掉）
    const engineId = getBundledEngineId()
    if (engineId) setEngineStatus(engineId, 'running')
    state = { ...state, status: 'running', port, backend: state.backend, error: undefined }
    broadcast()
    return state
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    state = { ...state, status: 'error', error: msg }
    broadcast()
    return state
  } finally {
    starting = false
  }
}

/**
 * 停止内置引擎（幂等）：
 * - child===null 时**不得早退**——即使进程已死仍执行「引擎 status→stopped + provider→enabled=0」（R16）
 * - post-stop 的 RuntimeState 定稿：status:'ready'、清 port（binaryPath 保留）
 */
export async function stopBundledEngine(): Promise<RuntimeState> {
  if (child) {
    child.kill()
    child = null
  }
  // R16：bundled provider 行必须 enabled=0，否则 firstUsableProvider()/proxy 指向死端点
  const engineId = getBundledEngineId()
  if (engineId) {
    try { setEngineStatus(engineId, 'stopped') } catch { /* 行可能不存在，忽略 */ }
    try { getDatabase().exec('UPDATE providers SET enabled = 0 WHERE engine_id = ?', [engineId]) } catch { /* 同上 */ }
  }
  state = { ...state, status: 'ready', port: undefined, error: undefined }
  broadcast()
  return state
}
