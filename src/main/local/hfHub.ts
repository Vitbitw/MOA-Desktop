import type { HfSearchResult } from '../../shared/types'
import { fetchProxy } from './fetchProxy'

const HF_API = 'https://huggingface.co/api'

/** 搜索 GGUF 模型仓库。 */
export async function searchHfModels(query: string, limit = 20): Promise<HfSearchResult[]> {
  const url = `${HF_API}/models?search=${encodeURIComponent(query)}&filter=gguf&limit=${limit}`
  const resp = await fetchProxy(url, { signal: AbortSignal.timeout(15_000) })
  if (!resp.ok) throw new Error(`HF 搜索失败: HTTP ${resp.status}`)
  const body = (await resp.json()) as Array<{
    id: string; downloads?: number; likes?: number; siblings?: Array<{ rfilename: string; size?: number }>
  }>
  return body.map((m) => {
    const ggufFiles = (m.siblings || [])
      .filter((s) => s.rfilename.toLowerCase().endsWith('.gguf'))
      .map((s) => ({ filename: s.rfilename, sizeBytes: s.size || 0 }))
    const parts = m.id.split('/')
    return {
      id: m.id,
      author: parts[0] || '',
      name: parts[1] || m.id,
      downloads: m.downloads || 0,
      likes: m.likes || 0,
      ggufFiles
    }
  }).filter((m) => m.ggufFiles.length > 0)
}

/** 枚举单个 repo 的 GGUF 文件（tree API，recursive）。 */
export async function listRepoGgufFiles(repo: string): Promise<Array<{ filename: string; sizeBytes: number }>> {
  const url = `${HF_API}/models/${repo}/tree/main?recursive=true`
  const resp = await fetchProxy(url, { signal: AbortSignal.timeout(15_000) })
  if (!resp.ok) throw new Error(`HF 文件列表失败: HTTP ${resp.status}`)
  const body = (await resp.json()) as Array<{ path?: string; size?: number; type?: string }>
  return (body || [])
    .filter((e) => e.type === 'file' && e.path && e.path.toLowerCase().endsWith('.gguf'))
    .map((e) => ({ filename: e.path!, sizeBytes: e.size || 0 }))
}

/** 构造下载直链（302 到 CDN）。 */
export function buildDownloadUrl(repo: string, filename: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${filename.split('/').map(encodeURIComponent).join('/')}`
}

/** 从文件名解析量化名（Q4_K_M / Q8_0 / F16 等；兼容小写文件名，i 忽略大小写）。 */
export function parseQuantization(filename: string): string | undefined {
  // [A-Z0-9_] 需含下划线：否则 q4_k_m 会被截断成 Q4_K（_ 不在字符类内导致提前停止）
  const m = filename.match(/(Q\d+_[A-Z0-9_]+|F16|F32|IQ\d+_[A-Z0-9_]+)/i)
  return m?.[0]?.toUpperCase()
}
