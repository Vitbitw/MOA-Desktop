import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { once } from 'node:events'
import { BrowserWindow } from 'electron'
import { getDatabase } from '../db/database'
import type { DownloadProgress, LocalModel } from '../../shared/types'
import { buildDownloadUrl, parseQuantization } from './hfHub'
import { modelsDir } from './paths'

interface ActiveJob {
  controller: AbortController
  lastBytes: number
  lastTs: number
  modelId: string
}

const activeJobs = new Map<string, ActiveJob>()

/** 广播下载进度到所有窗口。 */
function broadcastProgress(p: DownloadProgress): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('local:downloadProgress', p)
  }
}

/** 指数退避重试包装（3 次；仅重试 5xx / 网络错误 / 408 / 429）。 */
async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetch(url, init)
      if (resp.ok) return resp
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
  // 路径穿越防护：repo 段白名单化 + 文件名取 basename（拍平子目录）
  const safeRepo = repo.replace(/[^\w.-]+/g, '_')
  const baseName = path.basename(file)
  const targetPath = path.join(dir, `${safeRepo}__${baseName}`)
  const partPath = `${targetPath}.part`

  // 已存在完整文件 → 直接登记，跳过下载（jobId='' 表示无需取消）
  if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0) {
    const model = registerDownloadedModel({ repo, file, targetPath, sizeBytes: fs.statSync(targetPath).size })
    return { jobId: '', model }
  }

  const modelId = baseName.replace(/\.gguf$/i, '')
  const jobId = crypto.randomUUID()
  const db = getDatabase()

  // P1 修复：复用同 repo+file 的既有行（此前失败/取消残留），避免重复行
  const existing = db.queryOne<{ id: string }>(
    'SELECT id FROM local_models WHERE hf_repo = ? AND hf_file = ?',
    [repo, file]
  )
  const id = existing?.id || crypto.randomUUID()
  if (existing) {
    db.exec(
      `UPDATE local_models SET status = 'downloading', downloaded_bytes = 0, size_bytes = ?, name = ?, gguf_path = ?, quantization = ? WHERE id = ?`,
      [sizeBytes || 0, `${repo} / ${baseName}`, targetPath,
       params.quantization || parseQuantization(file) || null, id]
    )
  } else {
    db.exec(
      `INSERT INTO local_models (id, name, model_id, gguf_path, size_bytes, downloaded_bytes, hf_repo, hf_file, quantization, status, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 'downloading', ?)`,
      [id, `${repo} / ${baseName}`, modelId, targetPath, sizeBytes || 0, repo, file,
       params.quantization || parseQuantization(file) || null, Date.now()]
    )
  }

  const controller = new AbortController()
  activeJobs.set(jobId, { controller, lastBytes: 0, lastTs: Date.now(), modelId })

  // 后台执行下载（不 await，立即返回 jobId）
  void (async () => {
    try {
      const url = buildDownloadUrl(repo, file)
      const resp = await fetchWithRetry(url, { signal: controller.signal })
      const total = sizeBytes || Number(resp.headers.get('content-length')) || 0
      const out = fs.createWriteStream(partPath)
      const reader = resp.body!.getReader()
      let received = 0
      const job = activeJobs.get(jobId)!

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        // 背压：写缓冲满时等待 drain，避免大文件内存膨胀
        if (!out.write(Buffer.from(value))) {
          await once(out, 'drain')
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
      out.end()
      await new Promise<void>((resolve, reject) => {
        out.on('finish', resolve)
        out.on('error', reject)
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
      if (cancelled) {
        // R4：取消 → 不登记（删 DB 行），保留 .part 供将来续传
        db.exec('DELETE FROM local_models WHERE id = ?', [id])
        // 事件层必须发 'cancelled' 终止信号，否则 UI downloads 残留 downloading 条目（见 Part 3 注）
        broadcastProgress({
          jobId, modelId, repo, file, receivedBytes: 0, totalBytes: 0,
          percent: 0, speedBps: 0, status: 'cancelled'
        })
      } else {
        // 失败 → 状态 error，保留 .part
        db.exec('UPDATE local_models SET status = \'error\' WHERE id = ?', [id])
        broadcastProgress({
          jobId, modelId, repo, file, receivedBytes: 0, totalBytes: 0, percent: 0, speedBps: 0,
          status: 'error', error: msg
        })
      }
    } finally {
      activeJobs.delete(jobId)
    }
  })()

  // R5：直接构造返回，不 read-back DB
  const model: LocalModel = {
    id,
    name: `${repo} / ${baseName}`,
    modelId,
    ggufPath: targetPath,
    sizeBytes: sizeBytes || 0,
    downloadedBytes: 0,
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

/** 按 modelId（LocalModel.modelId）取消活动下载任务。 */
export function cancelDownloadByModel(modelId: string): void {
  for (const [jobId, job] of activeJobs) {
    if (job.modelId === modelId) {
      job.controller.abort()
      activeJobs.delete(jobId)
      break
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
    db.exec(
      `UPDATE local_models SET status = 'downloaded', downloaded_bytes = ?, size_bytes = ?, quantization = ? WHERE id = ?`,
      [p.sizeBytes, p.sizeBytes, parseQuantization(baseName) || null, id]
    )
  } else {
    db.exec(
      `INSERT INTO local_models (id, name, model_id, gguf_path, size_bytes, downloaded_bytes, hf_repo, hf_file, quantization, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'downloaded', ?)`,
      [id, `${p.repo} / ${baseName}`, modelId, p.targetPath, p.sizeBytes, p.sizeBytes, p.repo, p.file,
       parseQuantization(baseName) || null, Date.now()]
    )
  }
  return {
    id,
    name: `${p.repo} / ${baseName}`,
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
