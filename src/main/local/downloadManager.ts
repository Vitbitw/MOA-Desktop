import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { once } from 'node:events'
import { BrowserWindow } from 'electron'
import { getDatabase } from '../db/database'
import type { DownloadProgress, LocalModel } from '../../shared/types'
import { IPC_EVENT } from '../../shared/ipc-channels'
import { buildDownloadUrl, parseQuantization } from './hfHub'
import { modelsDir } from './paths'
import { fetchProxy } from './fetchProxy'

interface ActiveJob {
  controller: AbortController
  lastBytes: number
  lastTs: number
  /** 推理名(文件名去 .gguf),仅诊断用;取消必须按 rowId(跨 repo 同名文件会碰撞) */
  modelId: string
  /** DB 行 id(LocalModel.id),取消/删除的精确锚点 */
  rowId: string
}

const activeJobs = new Map<string, ActiveJob>()
/**
 * 按 (repo, file) 键控,防同一 (repo,file) 并发下载互写同个 .part(竞态 E)。
 * 结构: key = `${repo}\u0000${file}`，value = jobId。
 */
const keyToJob = new Map<string, string>()
const keyOf = (repo: string, file: string) => `${repo}\u0000${file}`

/** 广播下载进度到所有窗口(统一使用 IPC_EVENT 常量,避免字面量断链 —— 问题 D 修复)。 */
function broadcastProgress(p: DownloadProgress): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(IPC_EVENT.LOCAL_DOWNLOAD_PROGRESS, p)
  }
}

/** 销毁写流并等待句柄真正关闭(Windows: 未关闭前 unlink 会 EBUSY)。 */
function destroyStream(s: fs.WriteStream | null): Promise<void> {
  return new Promise((resolve) => {
    if (!s || (s as { closed?: boolean }).closed) { resolve(); return }
    s.once('close', () => resolve())
    s.destroy()
  })
}

/** 指数退避重试包装（3 次；仅重试 5xx / 网络错误 / 408 / 429）。 */
async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetchProxy(url, init)
      // 206 = Partial Content（断点续传成功），与 200 同等视为成功
      if (resp.ok || resp.status === 206) return resp
      // 不可重试的 4xx 立即失败（408 请求超时 / 429 限流走重试）
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 408 && resp.status !== 429) {
        throw new Error(`下载失败: HTTP ${resp.status}`)
      }
      // 5xx / 408 / 429 进入指数退避重试
      throw new Error(`HTTP ${resp.status}`)
    } catch (err) {
      if (err instanceof Error && err.message.includes('abort')) throw err // 取消：直通
      if (err instanceof Error && err.message.startsWith('下载失败:')) throw err // 不可重试：直通
      if (i === attempts - 1) throw err // 重试耗尽：直通
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i))
  }
  throw new Error('下载失败')
}

export async function startDownload(params: {
  repo: string
  file: string
  sizeBytes?: number
  quantization?: string
}): Promise<{ jobId: string; model: LocalModel }> {
  const { repo, file, sizeBytes } = params
  const dir = modelsDir()
  // 路径穿越防护：repo 段白名单化 + file 的相对子目录逐段消毒。
  // 同一 repo 不同 quant 子目录下的同名 GGUF（如 GGUF/Q4_K_M/model.gguf 与 GGUF/Q8_0/model.gguf）
  // 此前会被拍平到同一个 repo__model.gguf，静默互相覆盖（P1-1 修复）。
  // 注意：path.dirname(file) 保留子目录时必须逐段消毒——`..`/盘符/绝对路径段一律替换为 '_'，
  // 否则 file 含 `../` 时 path.join 会归一化逃逸 modelsDir（审查修复：穿越回归）。
  // 另须消毒 repo 与 basename：白名单含 `.`，repo 恰为 '..' 时会成为 path.join 的合法 `..` 段逃逸
  // （审查修复 2：repo='..' → path.join(dir,'..',...) → 上级目录），basename 为 '..' 时同理防呆。
  const safeRepo = repo.replace(/[^\w.-]+/g, '_').replace(/^\.+$/, '_')
  const rawBase = path.basename(file)
  const baseName = rawBase === '.' || rawBase === '..' ? '_' : rawBase
  const dirSegments = path.dirname(file)
    .split(/[\\/]+/)
    .filter((s) => s !== '' && s !== '.')
    .map((s) => (s === '..' || /^[a-zA-Z]:$/.test(s) ? '_' : s.replace(/[^\w.-]+/g, '_')))
  const targetPath = path.join(dir, safeRepo, dirSegments.join(path.sep), baseName)
  // 最终防线：解析后必须仍在 modelsDir 内，否则拒绝（防任何归一化组合意外逃逸）
  const resolvedDir = path.resolve(dir)
  const resolvedTarget = path.resolve(targetPath)
  if (resolvedTarget !== resolvedDir && !resolvedTarget.startsWith(resolvedDir + path.sep)) {
    throw new Error(`非法的模型下载路径: ${repo}/${file}`)
  }
  const partPath = `${targetPath}.part`
  // 确保含子目录的落点存在，否则 createWriteStream 会 ENOENT
  try { fs.mkdirSync(path.dirname(targetPath), { recursive: true }) } catch { /* 忽略 */ }

  // 已存在完整文件 → 直接登记，跳过下载（jobId='' 表示无需取消）
  if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0) {
    const model = registerDownloadedModel({ repo, file, targetPath, sizeBytes: fs.statSync(targetPath).size })
    return { jobId: '', model }
  }

  // ── 竞态 E 修复:同 (repo,file) 并发下载判重 ──
  const k = keyOf(repo, file)
  const dupId = keyToJob.get(k)
  if (dupId && activeJobs.has(dupId)) {
    // 既有活动下载 → 复用同一 jobId,返回 DB 中已有的模型行(避免 UI 显示两条下载中条目)
    // 健壮性修复 G:DB 行一定存在(因为 startDownload 先写 DB 再 set activeJobs);
    // 若 DB 行缺失(异常状态),不构造虚假 id,而是清掉 stale 映射走正常下载流程。
    // 精确取行:用 active job 的 rowId(而非 ORDER BY created_at DESC——同 repo+file 的历史残留行
    // created_at 可能更新,取错行会返回错误模型,审查修复)
    const dupJob = activeJobs.get(dupId)!
    const dupRow = getDatabase().queryOne<{ id: string; name: string; model_id: string; gguf_path: string; size_bytes: number; downloaded_bytes: number; quantization: string | null; status: string; created_at: number }>(
      'SELECT * FROM local_models WHERE id = ?',
      [dupJob.rowId]
    )
    if (!dupRow) {
      // DB 行丢失(异常):清掉 stale 映射,落到下方正常下载流程
      activeJobs.delete(dupId)
      keyToJob.delete(k)
    } else {
      // status 安全 cast 修复 K:只允许 DB schema 中的合法状态值
      const rawStatus = dupRow.status
      const validStatus: LocalModel['status'] =
        rawStatus === 'downloading' || rawStatus === 'downloaded' || rawStatus === 'error'
          ? rawStatus
          : 'downloading' // 未知值兜底为 downloading(防御性)
      const model: LocalModel = {
        id: dupRow.id, name: dupRow.name, modelId: dupRow.model_id,
        ggufPath: dupRow.gguf_path, sizeBytes: dupRow.size_bytes,
        downloadedBytes: dupRow.downloaded_bytes, hfRepo: repo, hfFile: file,
        quantization: dupRow.quantization || undefined,
        status: validStatus,
        createdAt: dupRow.created_at
      }
      return { jobId: dupId, model }
    }
  }

  const modelId = baseName.replace(/\.gguf$/i, '')
  const jobId = crypto.randomUUID()
  const db = getDatabase()

  // ── 续传准备:读 .part 大小(问题 A 修复:downloaded_bytes 同步复位为实际字节数) ──
  let existingPartBytes = 0
  if (fs.existsSync(partPath)) {
    try { existingPartBytes = fs.statSync(partPath).size } catch { existingPartBytes = 0 }
    // .part 异常膨胀(大于预期)或等于目标大小(可能损坏) → 重置
    if (sizeBytes && existingPartBytes >= sizeBytes) existingPartBytes = 0
  }

  // P1 修复：复用同 repo+file 的既有行（此前失败/取消残留），避免重复行
  const existing = db.queryOne<{ id: string }>(
    'SELECT id FROM local_models WHERE hf_repo = ? AND hf_file = ?',
    [repo, file]
  )
  const id = existing?.id || crypto.randomUUID()
  if (existing) {
    db.exec(
      // 问题 A 修复:downloaded_bytes 填现有 .part 字节数,不再硬编码 0
      `UPDATE local_models SET status = 'downloading', downloaded_bytes = ?, size_bytes = ?, name = ?, gguf_path = ?, quantization = ? WHERE id = ?`,
      [existingPartBytes, sizeBytes || 0, `${repo} / ${file}`, targetPath,
       params.quantization || parseQuantization(file) || null, id]
    )
  } else {
    db.exec(
      // 问题 A 修复:downloaded_bytes 填现有 .part 字节数,不再硬编码 0
      `INSERT INTO local_models (id, name, model_id, gguf_path, size_bytes, downloaded_bytes, hf_repo, hf_file, quantization, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'downloading', ?)`,
      [id, `${repo} / ${file}`, modelId, targetPath, sizeBytes || 0, existingPartBytes, repo, file,
       params.quantization || parseQuantization(file) || null, Date.now()]
    )
  }

  const controller = new AbortController()
  activeJobs.set(jobId, { controller, lastBytes: existingPartBytes, lastTs: Date.now(), modelId, rowId: id })
  keyToJob.set(k, jobId)

  // 后台执行下载（不 await，立即返回 jobId）
  // out 提升到 try 外:catch 中必须可访问以销毁流——否则句柄泄漏,
  // Windows 下锁住 .part 导致 unlink EBUSY、取消后文件残留(V1 修复)
  let out: fs.WriteStream | null = null
  void (async () => {
    try {
      const url = buildDownloadUrl(repo, file)
      // 断点续传：若 .part 已有字节，带 Range 请求头从断点继续
      // Hugging Face CDN 支持 Range（返回 206 + Content-Range），失败回退从头
      let resumeFrom = existingPartBytes
      const headers: Record<string, string> = {}
      if (resumeFrom > 0) headers['Range'] = `bytes=${resumeFrom}-`
      const resp = await fetchWithRetry(url, { signal: controller.signal, headers })
      // 206 = 续传成功（从 resumeFrom 追加）；200 = 服务器忽略 Range（从头重写）
      const is206 = resp.status === 206

      // ── 问题 F 修复:Content-Range 起点校验,防版本漂移的静默数据损坏 ──
      let isResume = is206
      if (is206 && resumeFrom > 0) {
        const contentRange = resp.headers.get('content-range') || ''
        // RFC 7233 形如 "bytes 1000-9999/10000" 或 "bytes 1000-*/*"，end 可为 *
        const m = contentRange.match(/bytes (\d+)-(?:\d+|\*)\/(?:\d+|\*)/i)
        if (!m || Number(m[1]) !== resumeFrom) {
          // 起点不一致(远端文件变更/CDN 没按要求切到 resumeFrom)→ 放弃续传,删除 .part 从头重下
          try { fs.unlinkSync(partPath) } catch { /* 忽略 */ }
          isResume = false
          resumeFrom = 0
        }
      }
      if (!isResume) resumeFrom = 0

      const contentLength = Number(resp.headers.get('content-length')) || 0
      const total = sizeBytes || (isResume ? resumeFrom + contentLength : contentLength)
      // 追加模式（续传）或截断模式（从头）；挂空 error 监听防 destroy 时 uncaught
      out = fs.createWriteStream(partPath, isResume ? { flags: 'a' } : { flags: 'w' })
      out.on('error', () => { /* 销毁场景兜底,防无监听 uncaught */ })
      const reader = resp.body!.getReader()
      let received = isResume ? resumeFrom : 0
      const job = activeJobs.get(jobId)!

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        // 背压：写缓冲满时等待 drain，避免大文件内存膨胀
        if (!out.write(Buffer.from(value))) {
          await once(out, 'drain')
        }
        // 增量刷新 DB downloaded_bytes(节流,避免 DB 每条写 IO)
        if ((received - existingPartBytes) > (1024 * 1024)) { // 每 1MB 刷新一次
          try {
            db.exec('UPDATE local_models SET downloaded_bytes = ? WHERE id = ?', [received, id])
            existingPartBytes = received
          } catch { /* ignore */ }
        }
        const now = Date.now()
        const dt = (now - job.lastTs) / 1000
        if (dt >= 0.5) {
          const speed = (received - job.lastBytes) / dt
          job.lastBytes = received
          job.lastTs = now
          broadcastProgress({
            jobId, modelId, repo, file, receivedBytes: received, totalBytes: total,
            percent: total > 0 ? Math.min(100, Math.round((received / total) * 1000) / 10) : 0,
            speedBps: speed, status: 'downloading'
          })
        }
      }
      out!.end()
      await new Promise<void>((resolve, reject) => {
        out!.on('finish', resolve)
        out!.on('error', reject)
      })
      fs.renameSync(partPath, targetPath)

      db.exec(
        'UPDATE local_models SET status = \'downloaded\', downloaded_bytes = ? WHERE id = ?',
        [received, id]
      )
      broadcastProgress({
        jobId, modelId, repo, file, receivedBytes: received, totalBytes: total,
        percent: 100, speedBps: 0, status: 'done'
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const cancelled = controller.signal.aborted
      // V1 修复:先销毁写流并等待句柄关闭,否则 Windows 下 .part 被锁、unlink EBUSY
      await destroyStream(out)
      if (cancelled) {
        // 取消 → 不登记（删 DB 行），删除 .part（用户主动放弃，无需保留）
        db.exec('DELETE FROM local_models WHERE id = ?', [id])
        try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath) } catch { /* 忽略 */ }
        broadcastProgress({
          jobId, modelId, repo, file, receivedBytes: 0, totalBytes: 0,
          percent: 0, speedBps: 0, status: 'cancelled'
        })
      } else {
        // 问题 C 修复:失败时同步刷新 downloaded_bytes,便于下次续传和 UI 骨架显示已下载量
        let receivedOnError = 0
        try { if (fs.existsSync(partPath)) receivedOnError = fs.statSync(partPath).size } catch { /* ignore */ }
        try {
          db.exec(
            'UPDATE local_models SET status = \'error\', downloaded_bytes = ? WHERE id = ?',
            [receivedOnError, id]
          )
        } catch { /* ignore */ }
        broadcastProgress({
          jobId, modelId, repo, file, receivedBytes: receivedOnError, totalBytes: sizeBytes || 0,
          percent: sizeBytes ? Math.min(100, Math.round((receivedOnError / sizeBytes) * 1000) / 10) : 0,
          speedBps: 0, status: 'error', error: msg
        })
      }
    } finally {
      activeJobs.delete(jobId)
      keyToJob.delete(k)
    }
  })()

  // R5：直接构造返回，不 read-back DB
  const model: LocalModel = {
    id,
    name: `${repo} / ${file}`,
    modelId,
    ggufPath: targetPath,
    sizeBytes: sizeBytes || 0,
    downloadedBytes: existingPartBytes,
    hfRepo: repo,
    hfFile: file,
    quantization: params.quantization || parseQuantization(file),
    status: 'downloading',
    createdAt: Date.now()
  }
  return { jobId, model }
}

export function cancelDownload(jobId: string): void {
  const job = activeJobs.get(jobId)
  if (job) job.controller.abort()
}

/**
 * 按 DB 行 id（LocalModel.id）取消活动下载任务。
 * 精确锚点:modelId 只是文件名,跨 repo 同名文件会碰撞误取消(V2 修复)。
 */
export function cancelDownloadByRowId(rowId: string): void {
  for (const [, job] of activeJobs) {
    if (job.rowId === rowId) {
      job.controller.abort()
      // 注意:不提前从 activeJobs / keyToJob 移除,交由后台任务 catch→finally 统一清理
      break
    }
  }
}

/** 递归收集目录树内所有 .part 文件（下载落点含 repo/子目录，需递归扫描）。 */
function collectPartFiles(root: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.part')) out.push(full)
    }
  }
  walk(root)
  return out
}

/**
 * 启动时清理孤儿 .part 文件 + 重置崩溃残留的下载状态。
 * 1) status='downloading' 的行必为 stale(启动时无任何活动任务)→ 重置为 error,
 *    否则 UI 永久显示"下载中";.part 保留,下次点击即断点续传。
 * 2) 保留有对应 DB 行（status='error'，可续传）的 .part；
 *    删除无对应 DB 行的孤儿 .part（应用崩溃/手动删 DB 行后的残留）。
 * 应用启动时 activeJobs 为空，不会误删正在下载的文件。
 */
export function cleanupOrphanPartFiles(): void {
  const db = getDatabase()
  // 先重置 stale 状态(在 SELECT 前,让这些行落入 keepSet 保留 .part)
  db.exec("UPDATE local_models SET status = 'error' WHERE status = 'downloading'")

  const dir = modelsDir()
  let partFiles: string[] = []
  try { partFiles = collectPartFiles(dir) } catch { return }
  if (partFiles.length === 0) return
  const rows = db.query<{ gguf_path: string }>(
    "SELECT gguf_path FROM local_models WHERE status = 'error'"
  )
  const keepSet = new Set(rows.map((r) => `${r.gguf_path}.part`))
  for (const full of partFiles) {
    if (!keepSet.has(full)) {
      try { fs.unlinkSync(full) } catch { /* 忽略 */ }
    }
  }
}

function registerDownloadedModel(p: { repo: string; file: string; targetPath: string; sizeBytes: number }): LocalModel {
  const db = getDatabase()
  const baseName = path.basename(p.file)
  const modelId = baseName.replace(/\.gguf$/i, '')
  const existing = db.queryOne<{ id: string }>(
    'SELECT id FROM local_models WHERE gguf_path = ?', [p.targetPath]
  )
  const id = existing?.id || crypto.randomUUID()
  if (existing) {
    // P2 修复：复用既有行时同步 DB 状态（此前可能残留 error/downloading 状态）
    // P1-1 修复：同步 name/hf_repo/hf_file，避免同路径被不同子目录文件覆盖后元数据失真
    db.exec(
      `UPDATE local_models SET status = 'downloaded', downloaded_bytes = ?, size_bytes = ?, quantization = ?, name = ?, hf_repo = ?, hf_file = ? WHERE id = ?`,
      [p.sizeBytes, p.sizeBytes, parseQuantization(baseName) || null, `${p.repo} / ${p.file}`, p.repo, p.file, id]
    )
  } else {
    db.exec(
      `INSERT INTO local_models (id, name, model_id, gguf_path, size_bytes, downloaded_bytes, hf_repo, hf_file, quantization, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'downloaded', ?)`,
      [id, `${p.repo} / ${p.file}`, modelId, p.targetPath, p.sizeBytes, p.sizeBytes, p.repo, p.file,
       parseQuantization(baseName) || null, Date.now()]
    )
  }
  return {
    id,
    name: `${p.repo} / ${p.file}`,
    modelId,
    ggufPath: p.targetPath,
    sizeBytes: p.sizeBytes,
    downloadedBytes: p.sizeBytes,
    hfRepo: p.repo,
    hfFile: p.file,
    quantization: parseQuantization(baseName),
    status: 'downloaded',
    createdAt: Date.now()
  }
}
