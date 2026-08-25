import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { app, BrowserWindow } from 'electron'
import { IPC_EVENT } from '../../shared/ipc-channels'
import type { DetectedEngine, LocalModel, RuntimeState, LaunchConfig } from '../../shared/types'
import { DEFAULT_LAUNCH_CONFIG } from '../../shared/types'
import { getDatabase } from '../db/database'
import { getLocalModelById, getLaunchConfig, setEngineStatus, upsertDetectedEngine } from './localManager'
import { fetchProxy } from './fetchProxy'

const RELEASE_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest'
/** 兜底扫描端点：latest 为占位/无资产 release 时，从最近按时间倒序的 releases 里找有 win 资产的。 */
const RELEASES_LIST_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20'

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
/** 停止请求标志：stop 入口置位、start 入口清零；健康循环每个 await 后二次判（stop-during-start 竞态短路）。 */
let stopRequested = false
/** 当前 llama-server 子进程（生命周期锚点）。 */
let child: ReturnType<typeof spawn> | null = null
/** 当前正在运行模型的 LocalModel.id（删除保护/UI 展示；随状态转换维护）。 */
let runningModelId: string | null = null

/** 广播运行时状态到所有窗口（单一 RuntimeState 载荷，附 engineType 便于 UI 分派）。 */
function broadcast(): void {
  const payload = { engineType: 'bundled', ...state, runningModelId: runningModelId ?? undefined }
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(IPC_EVENT.LOCAL_ENGINE_STATUS_CHANGED, payload)
  }
}

/** 当前运行时状态；not-installed 时同步检查二进制是否存在（size>0，与 ensureRuntime 判据一致：0 字节残留不算 ready）。 */
export function getRuntimeState(): RuntimeState {
  if (state.status === 'not-installed') {
    const bin = bundledBinaryPath()
    if (fs.existsSync(bin) && fs.statSync(bin).size > 0) state = { ...state, status: 'ready', binaryPath: bin }
  }
  return { ...state, runningModelId: runningModelId ?? undefined }
}

/**
 * 二进制路径的唯一真相（查找语义，非下载目标）：
 * packaged：先探测 resourcesPath/runtime/<llama-server[.exe]>（extraResources 随包分发，存在则用），
 *           不存在则回退 userData/runtime/<llama-server[.exe]>（下载兜底落点）
 * dev：userData/runtime/<llama-server[.exe]>（GitHub 下载兜底落点）
 * 下载目标恒为 RUNTIME_DIR()（ensureRuntime 内不另算）；本函数不得再当下载目标。
 */
export function bundledBinaryPath(): string {
  const fileName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  if (app.isPackaged) {
    const packaged = path.join(process.resourcesPath, 'runtime', fileName)
    if (fs.existsSync(packaged)) return packaged
  }
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

const backendOf = (n: string): RuntimeAsset['backend'] | null => {
  const l = n.toLowerCase()
  if (l.includes('win-avx2') || l.includes('win-cpu')) return 'cpu'
  if (l.includes('win-vulkan')) return 'vulkan'
  if (l.includes('win-cuda')) return 'cuda'
  return null
}

/** 资产名是否匹配本机架构（llama.cpp 资产名含 x64/arm64 后缀）。 */
const archMatches = (name: string): boolean => {
  const l = name.toLowerCase()
  const isArm = l.includes('arm64')
  const isX64 = l.includes('x64')
  // 无架构标记的资产视为通用，允许（cudart 等部分资产不带）
  if (!isArm && !isX64) return true
  if (process.arch === 'arm64') return isArm
  return isX64
}

/** 从一次 GitHub release 响应体提取可用的 llama-server 资产（按后端+本机架构过滤，按 name 去重）。 */
function extractAssets(body: {
  tag_name?: string
  assets?: Array<{ name: string; browser_download_url: string; size: number }>
}): RuntimeAsset[] {
  const seen = new Set<string>()
  const assets: RuntimeAsset[] = []
  for (const a of body.assets || []) {
    const backend = backendOf(a.name)
    if (!backend) continue
    if (!archMatches(a.name)) continue
    // 用 asset.name 去重（同一 release 内 win-cpu-x64 等唯一），避免同 tag 重复
    if (seen.has(a.name)) continue
    seen.add(a.name)
    assets.push({ name: a.name, url: a.browser_download_url, sizeBytes: a.size, backend })
  }
  return assets
}

/**
 * 查询 llama-server 资产（Windows 后端：cpu/vulkan/cuda）。
 * 先查 latest release；若其无可下载的 win 资产（例如 latest 是仅含 nightly-tag.txt 的
 * 占位 release，经某些代理节点会落到这类无效 latest），则回退扫描最近 releases，
 * 取第一个含 win 资产的稳定 release。
 */
export async function listRuntimeAssets(): Promise<RuntimeAsset[]> {
  const headers = { 'User-Agent': 'moa-desktop' }
  const signal = AbortSignal.timeout(20_000)

  const fetchJson = async (url: string): Promise<unknown> => {
    const resp = await fetchProxy(url, { headers, signal })
    if (!resp.ok) throw new Error(`GitHub release 查询失败: HTTP ${resp.status}`)
    return resp.json() as Promise<unknown>
  }

  // 1) latest
  const latestBody = (await fetchJson(RELEASE_API)) as {
    tag_name?: string
    assets?: Array<{ name: string; browser_download_url: string; size: number }>
  }
  const latest = extractAssets(latestBody)
  if (latest.length > 0) return latest

  // 2) fallback：扫描最近 releases，找一个真有 win 资产的
  const listBody = (await fetchJson(`${RELEASES_LIST_API}`)) as Array<{
    tag_name?: string
    assets?: Array<{ name: string; browser_download_url: string; size: number }>
  }>
  for (const rel of listBody || []) {
    const a = extractAssets(rel)
    if (a.length > 0) return a
  }
  return []
}

/** 下载并解压 llama-server 二进制到 RUNTIME_DIR()（下载目标唯一真相；bundledBinaryPath 仅查找，packaged 预装存在即 ready）。 */
export async function ensureRuntime(backend = 'vulkan'): Promise<RuntimeState> {
  if (state.status === 'downloading') return state
  // 查找语义：packaged 预装存在（size>0）即 ready，无需下载
  const bin = bundledBinaryPath()
  // 仅 size>0 才算 ready：防上次失败遗留 0 字节/半截二进制被误判
  if (fs.existsSync(bin) && fs.statSync(bin).size > 0) {
    state = { ...state, status: 'ready', binaryPath: bin, backend, error: undefined }
    broadcast()
    return state
  }

  state = { ...state, status: 'downloading', progress: 0, backend, error: undefined }
  broadcast()
  // out 声明在 try 外:catch 中必须可访问以关闭句柄——否则下载中途
  // 抛错(600s 超时/断网)时写流不关闭,泄漏句柄 + 残留半截 zip(R 修复)
  let out: fs.WriteStream | null = null
  try {
    const assets = await listRuntimeAssets()
    const asset = assets.find((a) => a.backend === backend) || assets.find((a) => a.backend === 'cpu')
    if (!asset) {
      // 风险 B 兜底：非 Windows 或资产为空时明确报错，不静默空数组
      throw new Error(process.platform === 'win32'
        ? '未找到匹配平台的 llama-server 资产'
        : '当前平台暂不支持内置运行时自动下载，请手动添加本地引擎')
    }
    // P3-8：资产回落（请求 vulkan/cuda 但只有 cpu 资产）时同步实际 backend，避免元数据失真
    if (asset.backend !== backend) {
      state = { ...state, backend: asset.backend }
    }
    // 不变式：下载落点恒为 userData/runtime，任何写路径不得指向 resourcesPath（UAC）
    const dir = RUNTIME_DIR()
    fs.mkdirSync(dir, { recursive: true })
    // 断点续传：先写 .part，带 Range 续传；完成后 rename 为正式 zip，失败保留 .part 供下次续传
    const zipPath = path.join(dir, asset.name)
    const partPath = `${zipPath}.part`
    let resumeFrom = 0
    try {
      const st = fs.statSync(partPath)
      if (st.size > 0) resumeFrom = st.size
    } catch { /* .part 不存在或不可读，从头下载 */ }
    const headers: Record<string, string> = { 'User-Agent': 'moa-desktop' }
    // content-length 已知时做合法性校验：.part 异常大于目标 → 重置从头下
    if (asset.sizeBytes > 0 && resumeFrom > asset.sizeBytes) resumeFrom = 0
    if (resumeFrom > 0) headers['Range'] = `bytes=${resumeFrom}-`

    const resp = await fetchProxy(asset.url, {
      headers,
      signal: AbortSignal.timeout(600_000)
    })
    if (!resp.ok) throw new Error(`下载失败: HTTP ${resp.status}`)
    const total = asset.sizeBytes || Number(resp.headers.get('content-length')) || 0
    const reader = resp.body!.getReader()
    // 与 GGUF 下载对齐（问题 F 修复）：206 续传时校验 Content-Range 起点，防 CDN 资产
    // 已变化（起点 ≠ resumeFrom）时静默追加到旧 .part 造成二进制损坏；不一致则删 .part 从头重下
    let isResume = resp.status === 206 && resumeFrom > 0
    if (resp.status === 206 && resumeFrom > 0) {
      const contentRange = resp.headers.get('content-range') || ''
      // RFC 7233 形如 "bytes 1000-9999/10000" 或 "bytes 1000-*/*"，end 可为 *
      const m = contentRange.match(/bytes (\d+)-(?:\d+|\*)\/(?:\d+|\*)/i)
      if (!m || Number(m[1]) !== resumeFrom) {
        try { fs.unlinkSync(partPath) } catch { /* 忽略 */ }
        isResume = false
        resumeFrom = 0
      }
    }
    if (!isResume) resumeFrom = 0
    // 200 = 服务器忽略 Range 全新开始（覆盖写）；206 = 部分内容（追加续传）
    out = fs.createWriteStream(partPath, { flags: isResume ? 'a' : 'w' })
    // 挂空 error 监听：abort/销毁时若无监听,error 事件会变 uncaught exception
    out.on('error', () => { /* 销毁场景兜底 */ })
    let received = isResume ? resumeFrom : 0
    let lastPercent = -1
    // 无进展保护：长时间收不到数据（断流但连接未关闭）提前中止，避免等满 600s
    let lastData = Date.now()
    let stalled = false
    const stallGuard = setInterval(() => {
      if (Date.now() - lastData > 45_000) {
        lastData = Date.now()
        stalled = true
        try { if (!resp.body) return; (resp.body as ReadableStream).cancel?.() } catch { /* ignore */ }
      }
    }, 15_000)
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        lastData = Date.now()
        const toWrite = isResume ? value : Buffer.from(value)
        received += toWrite.byteLength
        // 背压：写缓冲满时等待 drain，避免大文件内存膨胀
        if (!out.write(toWrite)) {
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
    } finally {
      clearInterval(stallGuard)
    }
    // 无进展超时：流被 cancel 后 read 以 done 结束，若不显式抛错会误把截断文件当成功
    if (stalled) throw new Error('下载无进展（45s 未收到数据），已中断，请检查网络后重试')
    // events.once 在流触发 error 时也会自动 reject，无需额外 error 监听
    out.end()
    await once(out, 'finish')
    out = null

    // 完整下载完毕：.part → 正式 zip，随后解压
    fs.renameSync(partPath, zipPath)
    await extractZip(zipPath, dir)
    try { fs.unlinkSync(zipPath) } catch { /* 残留 zip 无害，忽略 */ }

    const found = findExecutableInDir(dir)
    if (!found) throw new Error('压缩包内未找到 llama-server 可执行文件')
    // 落点恒为 RUNTIME_DIR()（不以 bin 为目标：packaged 预装 0 字节残留时 bin 可能指向 resourcesPath）
    const target = path.join(dir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server')
    // found 与 target 可能是同一路径（zip 根层直接含 llama-server.exe 时 walk 返回自身）
    // 此时 unlinkSync 会先删文件，renameSync 随即 ENOENT——跳过 rename 即可
    if (path.resolve(found) !== path.resolve(target)) {
      // Windows rename 不覆盖已存在目标（EPERM）：先清陈旧 0 字节/半截 bin 再移动
      try { fs.unlinkSync(target) } catch { /* 陈旧目标或不存在，忽略 */ }
      fs.renameSync(found, target)
    }

    state = { ...state, status: 'ready', binaryPath: target, progress: 100 }
    broadcast()
    return state
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 关闭未完成的写流,释放句柄、避免半截 zip 文件被锁(Windows);下次重下会截断覆盖
    try { if (out && !(out as { closed?: boolean }).closed) out.destroy() } catch { /* 忽略 */ }
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

/** 根据 LaunchConfig 构造 llama-server CLI 参数数组 */
function buildArgs(model: LocalModel, config: LaunchConfig, port: number): string[] {
  const args: string[] = [
    '-m', model.ggufPath,
    '--host', '127.0.0.1',
    '--port', String(port),
    '-ngl', String(config.gpuLayers),
    '-c', String(config.contextLength),
    '--cache-type-k', config.cacheTypeK,
    '--cache-type-v', config.cacheTypeV,
  ]
  if (config.flashAttention) args.push('-fa')
  if (config.jinja) args.push('--jinja')
  if (config.tensorSplit && config.tensorSplit.trim()) {
    args.push('-ts', config.tensorSplit.trim())
  }
  if (config.threads > 0) args.push('-t', String(config.threads))
  if (config.extraArgs && config.extraArgs.trim()) {
    // 按空格拆分额外参数（简单拆分，不支持引号嵌套）
    for (const a of config.extraArgs.trim().split(/\s+/)) {
      if (a) args.push(a)
    }
  }
  return args
}

/**
 * 启动内置 llama-server（reject-if-busy）：
 * 1) starting 标志在首个 await 之前同步置 true（防并发启动竞态）
 * 2) findFreePort 拿动态端口（先 close 再 spawn）
 * 3) spawn -m <ggufPath> -ngl <N> -c <ctx> ... --host 127.0.0.1 --port <port>
 * 4) 裸根 /health 探测循环（超时 30s）→ 成功后 upsertDetectedEngine 注册 provider（baseUrl 含 /v1）
 * 5) 失败/崩溃 → error 状态 + 广播，不 throw（handler 层不 catch）
 */
export async function startBundledEngine(localModelId: string): Promise<RuntimeState> {
  // 新一轮启动清零 stopRequested（防陈旧标志锁死后续启动；stop-during-start 竞态短路依赖它）
  stopRequested = false
  // reject-if-busy：starting 标志 + running 状态双条件
  if (starting || state.status === 'running') return { ...state }
  const model = getLocalModelById(localModelId)
  if (!model) {
    runningModelId = null
    state = { ...state, status: 'error', error: '本地模型不存在' }
    broadcast()
    return state
  }
  // 必须先置 starting 再 await（JS 单线程下第二次并发调用必被拦）
  starting = true
  try {
    const bin = bundledBinaryPath()
    if (!fs.existsSync(bin)) {
      runningModelId = null
      state = { ...state, status: 'error', error: '内置运行时未安装，请先完成运行时下载' }
      broadcast()
      return state
    }
    const port = await findFreePort()
    // stop-during-start 竞态：findFreePort 窗口内 stop 已置 stopRequested + state=ready，
    // 必须在此短路（running 写回之前），否则 stop 的 ready 被 running 覆盖
    if (stopRequested) return state
    state = { ...state, status: 'running', port }
    broadcast()
    // 读取启动参数（DB 无配置时用默认值）
    const launchConfig = getLaunchConfig(localModelId)
    const args = buildArgs(model, launchConfig, port)
    // 启动子进程（windowsHide：防 Windows 下 console 子系统 exe 弹出黑色控制台窗口）
    child = spawn(bin, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    // stale exit 校验锚点：stop→start 快速切换后旧进程 exit 不得误杀/清空新 child
    const pid = child.pid
    // 引流 stderr：Windows 命名管道缓冲填满会阻塞子进程写日志 → 假死；
    // 同时缓存末尾 4KB——llama-server 启动失败时诊断信息只在 stderr，
    // 空消费会导致用户只看到 "异常退出 code N" 无任何线索
    const stderrBuf: Buffer[] = []
    const STDERR_CAP = 4096
    let stderrLen = 0
    child.stderr?.on('data', (chunk: Buffer) => {
      // 滑动窗口：保留最后 4KB，丢弃更早的内容
      stderrBuf.push(chunk)
      stderrLen += chunk.length
      while (stderrLen > STDERR_CAP) {
        const dropped = stderrBuf.shift()!
        stderrLen -= dropped.length
      }
    })
    /** 取缓存的 stderr 末尾内容（用于 error 消息诊断）。 */
    const tailStderr = (): string => {
      if (stderrLen === 0) return ''
      const s = Buffer.concat(stderrBuf).toString('utf-8').trim()
      // 只取最后几行（避免单行过长撑爆 error 消息）
      const lines = s.split('\n')
      return lines.slice(-5).join('\n')
    }
    // spawn 启动失败（EACCES/ENOENT/损坏二进制）走 'error' 而非 'exit'：无监听器 = uncaught exception = 主进程崩溃
    child.once('error', (err) => {
      child = null
      runningModelId = null
      const diag = tailStderr()
      state = {
        ...state,
        status: 'error',
        error: diag ? `llama-server 启动失败: ${err.message}\n${diag}` : `llama-server 启动失败: ${err.message}`,
        port: undefined
      }
      broadcast()
    })
    // 健康通过 + 注册完成前保持 false：启动期 exit 走「落 error 保留原因」，运行期 exit 才走优雅 stop
    let startedOk = false
    child.once('exit', (code) => {
      // stale exit 校验：pid 不匹配（child 已指向新进程）时静默返回，不动新 child
      if (child?.pid !== pid) return
      child = null
      runningModelId = null
      if (startedOk) {
        // 正常运行期意外退出 → 走优雅 stop（R16：禁 provider + 引擎置 stopped）
        stopBundledEngine().catch(() => {})
      } else if (state.status === 'running') {
        // 启动期退出（坏 GGUF/端口占用等）→ 直接落 error 保留崩溃原因；不调 stop（stop 会覆盖成 ready 丢原因）
        const diag = tailStderr()
        state = {
          ...state,
          status: 'error',
          error: diag
            ? `llama-server 异常退出（code ${code}）\n${diag}`
            : `llama-server 异常退出（code ${code}）`
        }
        broadcast()
      }
    })
    // 健康探测：裸根 /health（chat API 在 /v1，探测必须用裸根，R15）
    const rootUrl = `http://127.0.0.1:${port}`
    const apiBaseUrl = `${rootUrl}/v1`
    // P2-5：大模型加载慢（几十 GB GGUF 的 mmap 可能远超 30s），健康等待上限按文件大小估算：
    // 保底 30s，每 1GiB 追加 2s，上限 300s（避免 70B 等大模型被误判启动超时并 kill）
    const modelBytes = model.sizeBytes || 0
    const healthWaitMs = Math.min(300_000, Math.max(30_000, 30_000 + Math.ceil(modelBytes / (1024 ** 3)) * 2000))
    const deadline = Date.now() + healthWaitMs
    let healthy = false
    while (Date.now() < deadline) {
      // stop-during-start 竞态：每个 await 后二次判（此处覆盖上一轮 sleep 之后）
      if (child === null || stopRequested) { healthy = false; break }
      try {
        const resp = await fetch(`${rootUrl}/health`, { signal: AbortSignal.timeout(1_000) })
        if (resp.ok) { healthy = true; break }
      } catch { /* 未就绪，重试 */ }
      // await fetch 后二次判：stop 落在 fetch 窗口时短路
      if (child === null || stopRequested) { healthy = false; break }
      await new Promise((r) => setTimeout(r, 300))
    }
    if (!healthy) {
      // stop-during-start 短路（必须早于下方超时 throw）：stop 落在健康循环 await 窗口时
      // state 已被 stop 置 ready，不短路则下方会因 state!=='error' throw → catch 覆盖成 error
      if (stopRequested) {
        // post-stop 定稿（与 stopBundledEngine 一致）：ready + 清 port/error，绝不广播 running/error
        state = { ...state, status: 'ready', port: undefined, error: undefined }
        broadcast()
        return state
      }
      // 判空：error/exit 监听已把 child 置 null（进程已死），此时 kill 会 null.kill() 抛 TypeError
      if (child) {
        child.kill()
        child = null
      }
      // 启动期 exit 已落 error（崩溃原因保留），不额外覆盖为超时错误
      if (state.status !== 'error') {
        throw new Error(`llama-server 启动超时（${Math.round(healthWaitMs / 1000)}s 内 /health 未就绪）`)
      }
      return state
    }
    // 健康通过：此后 exit 才走优雅 stop（startedOk=true 之后无 await，注册段全同步，健康期 exit 不会半途插入）
    startedOk = true
    // 健康通过段短路：stop 落在最后一次 fetch 成功与注册之间时，不得 upsert 注册/广播 running
    if (stopRequested) {
      state = { ...state, status: 'ready', port: undefined, error: undefined }
      broadcast()
      return state
    }
    // 记录当前运行模型 id（删除保护/UI 禁用删除）
    runningModelId = localModelId
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
    runningModelId = null
    state = { ...state, status: 'error', error: msg, port: undefined }
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
  // 入口置位（在 if (child) 之前）：stop-during-start 竞态短路——健康循环/注册段据此放弃尾段
  stopRequested = true
  runningModelId = null
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
