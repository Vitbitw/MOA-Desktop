import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'node:net'
import { app, BrowserWindow } from 'electron'
import { IPC_EVENT } from '../../shared/ipc-channels'
import type { RuntimeState } from '../../shared/types'

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
