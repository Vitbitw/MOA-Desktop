// ─── 官方定价探查（LLM 自动更新定价）───
// 职责：
//   1. 抓取官方定价页文本：HTTP（fetchProxy，尊重网络代理）优先 + 隐藏浏览器渲染兜底（兼容 SPA）
//   2. 用配置的大模型从页面文本提取结构化定价（含峰谷/错峰时段价）
//   3. 校验、币种归一化（CNY ÷7.2 → USD）、写入 AppSettings.probedPricing（独立探查定价层）
// 探查模型要求 OpenAI 兼容端点（同标题生成假设）；网络请求统一走 fetchProxy。

import { BrowserWindow } from 'electron'
import { getDatabase } from '../db/database'
import { getAllProviders, fetchAndCacheModels } from '../providers/providerManager'
import { getMoaConfig } from '../moa/moaConfig'
import { fetchProxy } from '../local/fetchProxy'
import { defaultPricingProbeUrlByName } from '../../shared/defaults'
import type { PricingProbeSettings, ProbedPricingEntry, PricingProbeSource, PricingWindow, ProbeProgressEvent, SubModelOutput } from '../../shared/types'

const HTTP_TIMEOUT_MS = 20_000
const BROWSER_LOAD_TIMEOUT_MS = 20_000
/** SPA 水合等待时间：did-finish-load 后再等 JS 渲染 */
const RENDER_SETTLE_MS = 3_000
/** LLM 提取超时：官方页文本较大 + 结构化 JSON 提取，放宽到 150s 避免误杀 */
const LLM_TIMEOUT_MS = 150_000
/**
 * 页面文本送入 LLM 前的最大字符数。
 * 权衡：中转/代理类 API（如 Command Code 走 Cloudflare）对长请求有上游处理超时（524），
 * 文本越小越不容易超时；官方直连源可接受更大的输入。
 */
const MAX_PAGE_CHARS = 12_000
/** CNY → USD 固定折算率（与 usageFormat.ts 的 7.2 一致） */
const CNY_TO_USD_RATE = 7.2
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

export interface ProbeModel {
  providerId: string
  baseUrl: string
  apiKey: string
  modelId: string
}

// ─── 设置读取 ───

function readAppSettings(): Record<string, unknown> | null {
  try {
    const row = getDatabase().queryOne<{ value: string }>(
      "SELECT value FROM moa_config WHERE key = 'app_settings'"
    )
    if (!row?.value) return null
    return JSON.parse(row.value) as Record<string, unknown>
  } catch {
    return null
  }
}

// ─── 探查模型解析 ───

/** 解析探查用模型：显式配置 > 聚合模型 > 首个已启用且有 apiKey 的 provider */
export function resolveProbeModel(): ProbeModel | null {
  const settings = readAppSettings()
  const probeModelId = (settings?.pricingProbe as { probeModelId?: string } | undefined)?.probeModelId
  const providers = getAllProviders()

  if (probeModelId && probeModelId.includes(':')) {
    const [pid, mid] = probeModelId.split(':')
    if (pid && mid) {
      const p = providers.find((prov) => prov.id === pid)
      if (p?.enabled && p.apiKey) {
        return { providerId: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey, modelId: mid }
      }
    }
  }

  const agg = getMoaConfig().aggregator
  if (agg?.primaryProviderId && agg?.primaryModelId) {
    const p = providers.find((prov) => prov.id === agg.primaryProviderId)
    if (p?.enabled && p.apiKey) {
      return { providerId: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey, modelId: agg.primaryModelId }
    }
  }

  for (const p of providers) {
    if (!p.enabled || !p.apiKey) continue
    const m = p.models?.[0]
    if (m?.id) return { providerId: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey, modelId: m.id }
  }

  return null
}

// ─── 页面抓取：HTTP 优先 + 隐藏浏览器兜底 ───

function containsKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase()
  return keywords.some((k) => k && lower.includes(k.toLowerCase()))
}

/** 轻量 HTML → 纯文本：去 script/style/标签与常用实体，压缩空白（HTTP 抓到的原始 HTML 噪声很大） */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchPageText(url: string, keywords: string[]): Promise<string | null> {
  // 关键词为空时不做页面有效性校验（无模型名也能抓取，交由 LLM 自行识别）
  const validate = (text: string): boolean => keywords.length === 0 || containsKeyword(text, keywords)

  // 1) HTTP 优先（走 fetchProxy，尊重网络代理）
  try {
    const resp = await fetchProxy(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
    if (resp.ok) {
      const raw = await resp.text().catch(() => '')
      const text = raw.includes('<') ? htmlToText(raw) : raw
      if (text && validate(text)) return text.slice(0, MAX_PAGE_CHARS)
    }
  } catch {
    /* 失败 → 浏览器兜底 */
  }

  // 2) 隐藏浏览器渲染兜底（兼容 SPA；走 Chromium 系统网络，不经过自定义代理）
  let win: BrowserWindow | null = null
  try {
    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: { contextIsolation: true, sandbox: false }
    })
    const loaded = await Promise.race([
      new Promise<boolean>((resolve) => {
        win!.webContents.once('did-finish-load', () => resolve(true))
        win!.webContents.once('did-fail-load', () => resolve(false))
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), BROWSER_LOAD_TIMEOUT_MS))
    ])
    if (!loaded) return null
    await new Promise((r) => setTimeout(r, RENDER_SETTLE_MS))
    const text = await win.webContents
      .executeJavaScript('document.body ? (document.body.innerText || "") : ""')
      .catch(() => '')
    if (text && validate(text)) return text.slice(0, MAX_PAGE_CHARS)
    return null
  } catch {
    return null
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
  }
}

// ─── 探查关键词：自动取所绑定厂商 /models 的模型名 ───

/** 解析源绑定的厂商 ID：优先 providerId，旧数据回退按名称匹配 */
export function resolveSourceProviderId(source: PricingProbeSource): string | undefined {
  if (source.providerId) return source.providerId
  const n = (source.name || '').trim().toLowerCase()
  if (!n) return undefined
  return getAllProviders().find((p) => {
    const pn = (p.name || '').trim().toLowerCase()
    return pn === n || pn.includes(n) || n.includes(pn)
  })?.id
}

/** 探查关键词：自动取所绑定厂商 /models 的模型名；尚未拉取过则先调用 /models */
async function getSourceKeywords(source: PricingProbeSource): Promise<string[]> {
  const providerId = resolveSourceProviderId(source)
  if (!providerId) return []
  let provider = getAllProviders().find((p) => p.id === providerId)
  if (provider && provider.models.length === 0) {
    try {
      await fetchAndCacheModels(providerId)
      provider = getAllProviders().find((p) => p.id === providerId)
    } catch {
      /* 忽略：保留空列表 */
    }
  }
  return (provider?.models ?? []).map((m) => m.id).filter((id): id is string => !!id)
}

// ─── LLM 提取 ───

function buildProbePrompt(source: PricingProbeSource, keywords: string[], pageText: string): string {
  const keywordText = keywords.length > 0 ? keywords.join('、') : '页面上所有已定价模型'
  const tz = source.timezone || 'Asia/Shanghai'
  return `你是一个模型定价解析器。下面是某厂商官方定价页面的文本（可能是原始 HTML，含无关标记，请忽略它们只找价格）。

请提取与该页面模型相关的定价。重点关注以下关键词（模型名或名称片段）：${keywordText}

匹配规则：
- 关键词可完整匹配，也可作为模型 ID/名称的子串匹配（忽略大小写）。例如关键词 deepseek 可匹配 deepseek-chat、deepseek-v4-flash。
- 若页面出现其它明确定价、且与关键词同系列/同厂商的模型，也一并提取。
- 页面里没有明确价格的一律不要编造；不确定的条目不要输出。

输出要求：
1. 价格按页面原样给出数值与币种（USD 或 CNY），用 currency 字段标明币种（中文页面通常为 CNY 元）。
2. 计费单位按页面实际标注如实填写到 unit 字段（如 "per 1M tokens" / "per 1K tokens" / "per request" / "per hour"）；页面未标注单位时默认 "per 1M tokens"。
3. 只输出 JSON 数组，每项结构：
{ "pattern": "模型ID或唯一前缀", "input": 数字, "output": 数字, "currency": "USD"|"CNY", "unit": "计费单位描述", "cacheRead": 数字(可选), "cacheCreation": 数字(可选), "windows": [ { "start": "HH:mm", "end": "HH:mm", "input": 数字, "output": 数字, "days": ["mon","tue"] (可选, 适用星期, 缺省=每天; 也接受 "weekday"/"工作日"/"weekend"/"周末" 或 [1,2,3] 数字数组) } ] }
   - 页面标注的「输入（缓存命中）」对应 cacheRead，「输入（缓存未命中）」对应 input。
4. windows 用于峰谷/错峰/时段优惠价（如 off-peak、错峰、时段折扣、凌晨低价、工作日/周末差价）。若页面含此类时段价，务必提取到 windows；无则省略该字段。窗口时间为 24 小时制 HH:mm，时区为 ${tz}。
5. 除 JSON 数组外不要输出任何内容，不要使用 markdown 代码块，不要任何解释。

页面文本：
${pageText}`
}

interface RawProbeEntry {
  pattern?: unknown
  /** LLM 可能用 model/name 代替 pattern */
  model?: unknown
  name?: unknown
  input?: unknown
  output?: unknown
  currency?: unknown
  unit?: unknown
  cacheRead?: unknown
  cacheCreation?: unknown
  windows?: unknown
  /** 窗口适用星期（可选） */
  days?: unknown
}

/** 宽容数值解析：数字直接取；字符串支持「2.5」「0.27/1M」「$0.27」等带单位/前缀形态 */
function toFiniteNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const t = v.trim()
    if (t === '') return undefined
    const clean = t.replace(/[^\d.\-]/g, '')
    if (clean === '' || clean === '-' || clean === '.') return undefined
    const n = Number(clean)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** 包裹对象中可能承载数组的字段名 */
const WRAPPER_ARRAY_KEYS = ['data', 'pricing', 'prices', 'items', 'models', 'result', 'entries'] as const

/** 从 LLM 输出中提取原始条目数组：支持数组 / { data|pricing|...: [...] } 包裹 / 单个对象 */
function extractJsonArray(content: string): RawProbeEntry[] | null {
  let s = content.replace(/```[a-zA-Z]*/g, '').trim()
  // 截掉前置说明文字（定位到首个 [ 或 {）
  const firstJson = s.search(/[[{]/)
  if (firstJson > 0) s = s.slice(firstJson)

  // 1) 数组形态
  const arrStart = s.indexOf('[')
  const arrEnd = s.lastIndexOf(']')
  if (arrStart !== -1 && arrEnd > arrStart) {
    try {
      const parsed = JSON.parse(s.slice(arrStart, arrEnd + 1))
      if (Array.isArray(parsed)) return parsed as RawProbeEntry[]
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>
        for (const key of WRAPPER_ARRAY_KEYS) {
          const v = obj[key]
          if (Array.isArray(v)) return v as RawProbeEntry[]
        }
      }
    } catch {
      /* fallthrough */
    }
  }

  // 2) 单个对象（平衡花括号截取，避免拖尾文字导致 parse 失败）
  const braceStart = s.indexOf('{')
  if (braceStart !== -1) {
    let depth = 0
    let braceEnd = -1
    for (let i = braceStart; i < s.length; i++) {
      const ch = s[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) { braceEnd = i; break }
      }
    }
    if (braceEnd !== -1) {
      try {
        const obj = JSON.parse(s.slice(braceStart, braceEnd + 1))
        if (obj && typeof obj === 'object') {
          const o = obj as Record<string, unknown>
          for (const key of WRAPPER_ARRAY_KEYS) {
            const v = o[key]
            if (Array.isArray(v)) return v as RawProbeEntry[]
          }
          return [o as RawProbeEntry]
        }
      } catch {
        /* ignore */
      }
    }
  }
  return null
}

const WEEKDAY_ABBR: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6
}

/** 解析窗口适用星期（0=周日..6=周六）。支持数字/英文缩写/工作日/周末；解析不出返回 undefined（= 每天） */
function parseDays(v: unknown): number[] | undefined {
  const out: number[] = []
  const push = (d: number) => {
    if (!out.includes(d)) out.push(d)
  }
  const items = Array.isArray(v) ? v : [v]
  for (const item of items) {
    if (typeof item === 'string') {
      const t = item.trim().toLowerCase()
      if (t === '工作日' || t === 'weekday' || t === 'weekdays') { [1, 2, 3, 4, 5].forEach(push); continue }
      if (t === '周末' || t === 'weekend') { [0, 6].forEach(push); continue }
      if (WEEKDAY_ABBR[t]) { push(WEEKDAY_ABBR[t]); continue }
      if (/^\d$/.test(t)) { const n = Number(t); if (n >= 0 && n <= 6) push(n) }
      continue
    }
    if (typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 6) push(item)
  }
  return out.length ? out : undefined
}

function normalizeWindow(w: unknown, currency: 'USD' | 'CNY'): PricingWindow | null {
  if (!w || typeof w !== 'object') return null
  const rec = w as Record<string, unknown>
  const start = typeof rec.start === 'string' ? rec.start : ''
  const end = typeof rec.end === 'string' ? rec.end : ''
  if (!HHMM_RE.test(start) || !HHMM_RE.test(end)) return null
  const input = toFiniteNum(rec.input)
  const output = toFiniteNum(rec.output)
  if (input === undefined || output === undefined || input < 0 || output < 0) return null
  const rate = currency === 'CNY' ? CNY_TO_USD_RATE : 1
  const days = parseDays(rec.days)
  const win: PricingWindow = { start, end, input: input / rate, output: output / rate }
  if (days) win.days = days
  return win
}

function buildProbedEntries(source: PricingProbeSource, raw: RawProbeEntry[]): ProbedPricingEntry[] {
  const tz = source.timezone || 'Asia/Shanghai'
  const now = Date.now()
  const entries: ProbedPricingEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const patternRaw =
      typeof item.pattern === 'string'
        ? item.pattern
        : typeof item.model === 'string'
          ? item.model
          : typeof item.name === 'string'
            ? item.name
            : ''
    const pattern = patternRaw.trim()
    const currency = item.currency === 'CNY' ? 'CNY' : 'USD'
    const input = toFiniteNum(item.input)
    const output = toFiniteNum(item.output)
    // 无模型标识则丢弃；负数视为异常数据丢弃（缺失数值按 0 处理：页面标注免费）
    if (!pattern) continue
    if ((input !== undefined && input < 0) || (output !== undefined && output < 0)) continue

    const rate = currency === 'CNY' ? CNY_TO_USD_RATE : 1
    const entry: ProbedPricingEntry = {
      pattern,
      input: (input ?? 0) / rate,
      output: (output ?? 0) / rate,
      currency,
      unit: typeof item.unit === 'string' && item.unit.trim() ? item.unit.trim() : undefined,
      timezone: tz,
      sourceId: source.id,
      sourceUrl: source.url,
      fetchedAt: now
    }

    const cacheRead = toFiniteNum(item.cacheRead)
    const cacheCreation = toFiniteNum(item.cacheCreation)
    if (cacheRead !== undefined && cacheRead >= 0) entry.cacheRead = cacheRead / rate
    if (cacheCreation !== undefined && cacheCreation >= 0) entry.cacheCreation = cacheCreation / rate

    if (Array.isArray(item.windows)) {
      const windows: PricingWindow[] = []
      for (const w of item.windows) {
        const nw = normalizeWindow(w, currency)
        if (nw) windows.push(nw)
      }
      if (windows.length > 0) entry.windows = windows
    }

    entries.push(entry)
  }
  return entries
}

// ─── 持久化（读 → 删旧源条目 → 追加 → 写回）───

function persistProbedPricing(sourceId: string, entries: ProbedPricingEntry[]): void {
  const row = getDatabase().queryOne<{ value: string }>(
    "SELECT value FROM moa_config WHERE key = 'app_settings'"
  )
  const current = row?.value ? JSON.parse(row.value) : {}
  const existing = Array.isArray(current.probedPricing)
    ? (current.probedPricing as ProbedPricingEntry[])
    : []
  current.probedPricing = [...existing.filter((e) => e.sourceId !== sourceId), ...entries]
  getDatabase().exec(
    "INSERT OR REPLACE INTO moa_config (key, value, updated_at) VALUES ('app_settings', ?, ?)",
    [JSON.stringify(current), Date.now()]
  )
}

// ─── 探查入口 ───

export type ProbeSourceResult =
  | { ok: true; entries: ProbedPricingEntry[] }
  | { ok: false; error: string }

export type ProbeStage = 'fetching' | 'extracting'

export async function probeSource(
  source: PricingProbeSource,
  model: ProbeModel,
  onStage?: (stage: ProbeStage) => void
): Promise<ProbeSourceResult> {
  // 关键词自动取所绑定厂商 /models 的模型名
  const keywords = await getSourceKeywords(source)
  console.log(`[PricingProbe] ${source.name}(${source.id}) probe model: ${model.baseUrl} / ${model.modelId}`)
  onStage?.('fetching')
  const pageText = await fetchPageText(source.url, keywords)
  if (!pageText) {
    return { ok: false, error: '抓取失败（HTTP 与浏览器均无法获取有效页面文本）' }
  }

  const prompt = buildProbePrompt(source, keywords, pageText)
  onStage?.('extracting')
  const result = await callProbeLLM(model, prompt)
  if (result.status !== 'success' || !result.content) {
    return { ok: false, error: `大模型调用失败: ${result.error || '空响应'}` }
  }
  console.log(`[PricingProbe] ${source.name}(${source.id}) page ${pageText.length} chars, keywords ${keywords.length}, LLM response ${result.content.length} chars`)

  const entries = buildProbedEntries(source, extractJsonArray(result.content) ?? [])
  if (entries.length === 0) {
    // 失败时打印原始响应便于定位（可能是格式不符 / 页面无相关价格）
    console.warn(
      `[PricingProbe] ${source.name}(${source.id}) no valid pricing parsed, LLM raw response: ${result.content.slice(0, 800)}`
    )
    return { ok: false, error: '未能从页面解析出有效定价' }
  }

  persistProbedPricing(source.id, entries)
  return { ok: true, entries }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 可重试的 LLM 错误：5xx / 524（上游超时）/ 客户端超时 / 网络类 */
function isRetriableLLMError(err: string): boolean {
  return /HTTP\s+5\d\d|HTTP\s+524|aborted|timeout|temporarily unavailable|ECONNRESET|ECONNREFUSED|ENETUNREACH|network/i.test(err)
}

/** 单次 LLM 调用（支持流式/非流式），返回 SubModelOutput */
async function probeLLMOnce(model: ProbeModel, prompt: string, useStream: boolean): Promise<SubModelOutput> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (model.apiKey) headers.Authorization = `Bearer ${model.apiKey}`
  const body = JSON.stringify({
    model: model.modelId,
    messages: [{ role: 'user', content: prompt }],
    stream: useStream
  })

  try {
    const resp = await fetchProxy(`${model.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS)
    })
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      return {
        modelId: model.modelId,
        providerId: model.providerId,
        content: '',
        status: 'error',
        error: `HTTP ${resp.status}: ${errText.slice(0, 300)}`
      }
    }

    let content = ''
    if (useStream) {
      // 解析 SSE：data: {...} 行，累积 delta.content
      const reader = resp.body?.getReader()
      if (reader) {
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let idx
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).replace(/\r$/, '').trim()
            buffer = buffer.slice(idx + 1)
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (!data || data === '[DONE]') continue
            try {
              const parsed = JSON.parse(data)
              const delta = parsed.choices?.[0]?.delta?.content
              if (typeof delta === 'string') content += delta
            } catch {
              /* 忽略非 JSON 行 */
            }
          }
        }
      }
    } else {
      const data = await resp.json().catch(() => null)
      content = data?.choices?.[0]?.message?.content || ''
    }

    return { modelId: model.modelId, providerId: model.providerId, content, status: 'success' }
  } catch (err) {
    return {
      modelId: model.modelId,
      providerId: model.providerId,
      content: '',
      status: 'error',
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * 调用探查模型。优先流式（响应头尽早返回、边生成边输出，规避中转/Cloudflare 上游超时 524）；
 * 流式失败则回退非流式；可重试错误（5xx/524/超时/网络）重试一次，4xx 不重试避免重复计费。
 */
async function callProbeLLM(model: ProbeModel, prompt: string): Promise<SubModelOutput> {
  let last: SubModelOutput | null = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    const streamed = await probeLLMOnce(model, prompt, true)
    if (streamed.status === 'success') return streamed
    last = streamed
    const fallback = await probeLLMOnce(model, prompt, false)
    if (fallback.status === 'success') return fallback
    last = fallback
    const err = fallback.error || streamed.error || ''
    if (!isRetriableLLMError(err) || attempt === 2) return fallback
    console.warn(`[PricingProbe] LLM call failed (retriable), attempt ${attempt + 1}: ${err}`)
    await sleep(2_000 * attempt)
  }
  return last ?? { modelId: model.modelId, providerId: model.providerId, content: '', status: 'error', error: 'unknown' }
}

export interface ProbeBatchResultItem {
  sourceId: string
  ok: boolean
  entryCount?: number
  error?: string
}

/** 顺序探查（避免并发 LLM 调用 / 触发限流）。onProgress 在每个源的阶段变化与完成时回调 */
export async function probeSources(
  sources: PricingProbeSource[],
  model: ProbeModel,
  onProgress?: (p: ProbeProgressEvent) => void
): Promise<ProbeBatchResultItem[]> {
  const results: ProbeBatchResultItem[] = []
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]
    const base = { sourceId: source.id, sourceName: source.name, index: i + 1, total: sources.length }
    onProgress?.({ ...base, stage: 'fetching' })
    const r = await probeSource(source, model, (stage) => onProgress?.({ ...base, stage }))
    results.push({
      sourceId: source.id,
      ok: r.ok,
      entryCount: r.ok ? r.entries.length : undefined,
      error: r.ok ? undefined : r.error
    })
    onProgress?.({
      ...base,
      stage: 'extracting',
      done: true,
      ok: r.ok,
      entryCount: r.ok ? r.entries.length : undefined,
      error: r.ok ? undefined : r.error
    })
    if (!r.ok) console.warn(`[PricingProbe] ${source.name}(${source.id}) failed: ${r.error}`)
  }
  return results
}

/** 读取定价探查配置；自动并入所有已配置 API Key 厂商的派生源（未手动创建源的厂商自动可用，不持久化） */
export function getPricingProbeConfig(): { autoRefreshDays: number; sources: PricingProbeSource[] } {
  const settings = readAppSettings()
  const pp = (settings?.pricingProbe ?? {}) as Partial<PricingProbeSettings>
  const configSources = Array.isArray(pp.sources) ? (pp.sources as PricingProbeSource[]) : []
  const autoRefreshDays =
    typeof pp.autoRefreshDays === 'number' && Number.isFinite(pp.autoRefreshDays) && pp.autoRefreshDays >= 0
      ? pp.autoRefreshDays
      : 0

  // 已配置 API Key 的厂商自动派生为源（无需手动添加）
  const keyedProviders = getAllProviders().filter((p) => p.apiKey && p.enabled)
  const bound = new Set<string>()
  for (const s of configSources) {
    const pid = resolveSourceProviderId(s)
    if (pid) bound.add(pid)
  }
  const autoSources: PricingProbeSource[] = keyedProviders
    .filter((p) => !bound.has(p.id))
    .map((p) => ({
      id: `auto:${p.id}`,
      name: p.name,
      providerId: p.id,
      url: defaultPricingProbeUrlByName(p.name),
      enabled: true
    }))

  return { autoRefreshDays, sources: [...configSources, ...autoSources] }
}

/**
 * 该源绑定的厂商是否已配置 API Key。
 * 未配置 key 的来源不参与探查与展示。
 */
export function sourceHasConfiguredKey(source: PricingProbeSource): boolean {
  const providerId = resolveSourceProviderId(source)
  if (!providerId) return false
  const p = getAllProviders().find((prov) => prov.id === providerId)
  return !!p?.enabled && !!p.apiKey
}
