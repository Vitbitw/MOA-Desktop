// ─── 官方定价探查（LLM 自动更新定价）───
// 职责：
//   1. 抓取官方定价页文本：HTTP（fetchProxy，尊重网络代理）优先 + 隐藏浏览器渲染兜底（兼容 SPA）
//   2. 用配置的大模型从页面文本提取结构化定价（含峰谷/错峰时段价）
//   3. Command Code 源增强：plan pattern 规范化到 /models 模型 ID、计划页额度区块提取（Usage limits 请求数 +
//      Monthly credits）、套餐外模型（premium）定价补全（全站 models 页定向提取）
//   4. 校验、币种归一化（CNY ÷7.2 → USD）、写入 AppSettings.probedPricing（独立探查定价层）
// 探查模型要求 OpenAI 兼容端点（同标题生成假设）；网络请求统一走 fetchProxy。

import { BrowserWindow } from 'electron'
import { readAppSettings, updateRawAppSettings } from '../config/appSettings'
import { getAllProviders, fetchAndCacheModels } from '../providers/providerManager'
import { getMoaConfig } from '../moa/moaConfig'
import { fetchProxy } from '../local/fetchProxy'
import { getUsageSnapshot } from '../monitoring/snapshotStore'
import { CC_PLAN_PAGE, CC_MODELS_URL } from '../monitoring/commandCode'
import { defaultPricingProbeUrlByName } from '../../shared/defaults'
import { splitModelKey } from '../../shared/modelKey'
import { hasProviderAccess } from '../../shared/providerAccess'
import type { ProbedPricingEntry, ProbedUsageLimits, PricingProbeSource, PricingWindow, PricingPageCache, ProbeProgressEvent, SubModelOutput } from '../../shared/types'

const HTTP_TIMEOUT_MS = 20_000
const BROWSER_LOAD_TIMEOUT_MS = 20_000
/** SPA 水合轮询间隔：did-finish-load 后每轮检查 innerText 是否渲染出有效文本（对纯 JS 渲染页更可靠） */
const RENDER_POLL_MS = 1_200
/** SPA 水合轮询总超时 */
const RENDER_POLL_TIMEOUT_MS = 10_000
/** LLM 提取超时：官方页文本较大 + 结构化 JSON 提取，放宽到 150s 避免误杀 */
const LLM_TIMEOUT_MS = 150_000
/**
 * 页面文本送入 LLM 前的最大字符数。
 * 权衡：中转/代理类 API（如 Command Code 走 Cloudflare）对长请求有上游处理超时（524），
 * 文本越小越不容易超时；官方直连源可接受更大的输入。
 */
const MAX_PAGE_CHARS = 12_000
/** 锚句定位定价区块时的前后安全边距（字符），保证锚所在的表头/行上下文完整 */
const FRAGMENT_PAD = 400
/** CNY → USD 固定折算率（与 usageFormat.ts 的 7.2 一致） */
const CNY_TO_USD_RATE = 7.2
/** 额度区块锚：请求数限额表表头（goat/pro/max 三套餐页通用）；`fullText.indexOf` 定位 */
const CREDITS_ANCHOR_REQUESTS = 'Requests / 5 hours'
/** 额度区块锚：月额度表表头（goat/pro 有；max 页无此表 → 只提请求数） */
const CREDITS_ANCHOR_MONTHLY = 'Monthly credits'
/** 额度区块各锚向后截取的字符数（表格文本密度 ~60 字符/行，5.5k ≈ 90 行；两片合计 ≤ MAX_PAGE_CHARS） */
const CREDITS_SLICE_CHARS = 5_500
/** 套餐外模型补全的缺失数量上限：超过则视为异常（页面改版等），不发起全站页补全 */
const ALL_MODELS_FILL_MAX = 60
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
/** 诊断开关（MOA_MONITOR_DEBUG=1）：输出探测进度细节与页面统计，排查定价解析异常时开启 */
const DEBUG = process.env.MOA_MONITOR_DEBUG === '1'

export interface ProbeModel {
  providerId: string
  baseUrl: string
  apiKey: string
  modelId: string
}

// ─── 探查模型解析 ───

/** 解析探查用模型：显式配置 > 聚合模型 > 首个可用（有 apiKey 或回环地址）的 provider */
export function resolveProbeModel(): ProbeModel | null {
  const probeModelId = readAppSettings().pricingProbe.probeModelId
  const providers = getAllProviders()

  if (probeModelId && probeModelId.includes(':')) {
    const { providerId: pid, modelId: mid } = splitModelKey(probeModelId)
    if (pid && mid) {
      const p = providers.find((prov) => prov.id === pid)
      if (p?.enabled && hasProviderAccess(p)) {
        return { providerId: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey, modelId: mid }
      }
    }
  }

  const agg = getMoaConfig().aggregator
  if (agg?.primaryProviderId && agg?.primaryModelId) {
    const p = providers.find((prov) => prov.id === agg.primaryProviderId)
    if (p?.enabled && hasProviderAccess(p)) {
      return { providerId: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey, modelId: agg.primaryModelId }
    }
  }

  for (const p of providers) {
    if (!p.enabled || !hasProviderAccess(p)) continue
    const m = p.models?.[0]
    if (m?.id) return { providerId: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey, modelId: m.id }
  }

  return null
}

// ─── 页面抓取：HTTP 优先 + 隐藏浏览器兜底 ───

/**
 * 匹配用文本归一化：小写 + 把连字符/点/斜杠等分隔符统一替换为空格。
 * 注意：全部 1:1 替换（不增删字符），归一化后文本长度与原文本一致，
 * 故在归一化副本上命中的索引可直接换算回原文本。
 * 解决官方定价页常用「空格」（Claude Sonnet 4.6）而 /models 模型 ID 常用
 * 「连字符/斜杠」（claude-sonnet-4-6、google/gemini-3.8-flash）的形态差异。
 */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[-‐‑‒–—―_./,]/g, ' ')
}

/** 关键词候选变体：原样、去厂商前缀（google/gemini-3.8-flash → gemini-3.8-flash）、去 :free/:paid 后缀、
 *  字母/数字交界拆词（Qwen3.8-Max → Qwen 3.8-Max，匹配页面「Qwen 3.8 Max」的空格写法）。
 *  matchText 保持 1:1 归一化（不增删字符，索引可换算回原文），拆词变体只影响关键词侧。 */
function keywordVariants(k: string): string[] {
  if (!k) return []
  const out: string[] = [k]
  const push = (v: string) => {
    if (v && !out.includes(v)) out.push(v)
  }
  push(k.replace(/:(free|paid)$/i, ''))
  const bare = k.split('/').pop()
  if (bare && bare !== k) push(bare)
  if (bare) push(bare.replace(/:(free|paid)$/i, ''))
  // 为所有既有变体补一份「字母/数字交界拆成空格」的版本（不改变 matchText，索引仍保真）
  for (const v of [...out]) {
    const spaced = v.replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2')
    push(spaced)
  }
  return out
}

/** 升序数组分位值（0..1），空数组返回 undefined */
function quantile(sorted: number[], q: number): number | undefined {
  if (sorted.length === 0) return undefined
  return sorted[Math.floor((sorted.length - 1) * q)]
}

/**
 * canonicalize 专用规范化：括号视作分隔符（"(exp)"/"(latest)" 的括注内容参与匹配）+
 * 双向字母/数字边界拆词（"27B" → "27 B"，与 keywordVariants 的拆词形态对称）。
 * 不做 1:1 长度保持（仅用于比较，不用于索引换算）。
 */
function canonNorm(s: string): string {
  return normalizeForMatch(s.replace(/[()]/g, ' '))
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 把探查 pattern 规范化为所绑定厂商 /models 的模型 ID（无法对应则保留原样）。
 * 官方页定价表用显示名（"Kimi K3"），而 UI 模型行与成本匹配用 /models ID（"moonshotai/Kimi-K3"）——
 * 不规范化会出现「同一模型两行、其中一行无价」（显示名行有价但 ID 行匹配不上）。
 * 匹配顺序：精确 → 变体归一化相等（原文 + 剥尾部括注形态）→ 词序列连续子序列（剩余词最少者）。
 * 多候选相等时取 keywords 中先出现者（列表顺序稳定）。
 */
export function canonicalizePattern(pattern: string, keywords: string[]): string {
  if (keywords.length === 0) return pattern
  if (keywords.includes(pattern)) return pattern
  // 剥尾部括注（"(latest)" / "(exp)" 等噪声），原文形态优先于剥后形态
  const stripped = pattern.replace(/\s*\([^)]*\)\s*$/, '').trim()
  const forms = stripped && stripped !== pattern ? [pattern, stripped] : [pattern]
  // 1) 变体归一化相等
  for (const form of forms) {
    const nf = canonNorm(form)
    if (!nf) continue
    for (const k of keywords) {
      for (const v of keywordVariants(k)) {
        if (canonNorm(v) === nf) return k
      }
    }
  }
  // 2) 词序列连续子序列（"Tencent Hy3" → "tencent/hy3-paid" 剩 1 词；"Nemotron 3 Ultra" → nvidia 长 ID）
  let best: string | undefined
  let bestRemain = Infinity
  for (const form of forms) {
    const nf = canonNorm(form)
    if (!nf) continue
    for (const k of keywords) {
      for (const v of keywordVariants(k)) {
        const nv = canonNorm(v)
        if (!nv) continue
        if (seqCovered(nf, nv)) {
          const remain = nv.split(' ').length - nf.split(' ').length
          if (remain < bestRemain) {
            bestRemain = remain
            best = k
          }
        }
      }
    }
    if (best) break
  }
  return best ?? pattern
}

/**
 * 由关键词命中位置求定价区块的覆盖区间（起止索引）。
 * 命中常分为多个簇：页面顶部 DEAL/套餐区小簇（几个模型名）、定价表主体大簇、页脚 FAQ 小簇。
 * 直接取「命中数最多的簇」为主簇，天然排除顶部/页脚离群簇，保证窗口精确覆盖定价表
 * 且不超出 MAX_PAGE_CHARS 截断配额（截断会切掉表尾模型）。
 */
function pricingSpan(hits: number[], textLen: number): { lo: number; hi: number } | undefined {
  if (hits.length === 0) return undefined
  hits.sort((a, b) => a - b)
  const GAP = Math.max(4_000, textLen * 0.08)
  // 相邻间距 <= GAP 归同一簇
  const clusters: number[][] = []
  let cur = [hits[0]]
  for (let i = 1; i < hits.length; i++) {
    if (hits[i] - hits[i - 1] <= GAP) {
      cur.push(hits[i])
    } else {
      clusters.push(cur)
      cur = [hits[i]]
    }
  }
  clusters.push(cur)
  // 主簇 = 命中数最多的簇
  const main = clusters.reduce((a, b) => (b.length > a.length ? b : a))
  return { lo: main[0], hi: main[main.length - 1] }
}

/** 每个关键词（含变体）首次命中在全文中的位置（原文索引）；未命中跳过 */
function firstKeywordHits(fullText: string, keywords: string[]): number[] {
  const matchText = normalizeForMatch(fullText)
  const hits: number[] = []
  for (const k of keywords) {
    for (const v of keywordVariants(k)) {
      const idx = matchText.indexOf(normalizeForMatch(v))
      if (idx !== -1) {
        hits.push(idx)
        break
      }
    }
  }
  return hits
}

function containsKeyword(text: string, keywords: string[]): boolean {
  const matchText = normalizeForMatch(text)
  return keywords.some((k) => keywordVariants(k).some((v) => matchText.includes(normalizeForMatch(v))))
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
      if (text && validate(text)) return text
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
    // 纯 JS 渲染（SPA）页面：did-finish-load 仅代表 HTML 骨架完成，轮询等待定价内容渲染出来
    const deadline = Date.now() + RENDER_POLL_TIMEOUT_MS
    while (Date.now() < deadline) {
      const text = await win.webContents
        .executeJavaScript('document.body ? (document.body.innerText || "") : ""')
        .catch(() => '')
      if (text && validate(text)) return text
      await new Promise((r) => setTimeout(r, RENDER_POLL_MS))
    }
    return null
  } catch {
    return null
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
  }
}

// ─── 页面级缓存：哈希判变 + 锚句定位定价区块 ───

/** 页面文本哈希（FNV-1a 32）：归一化空白与小写，屏蔽时间戳/渲染噪声造成的无效差异 */
function hashPageText(text: string): string {
  const norm = text.replace(/\s+/g, ' ').trim().toLowerCase()
  let h = 0x811c9dc5
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h.toString(36)
}

/** 读取全部源的页面级缓存（探出哈希 + 定价区块锚句） */
function readPageCache(): Record<string, PricingPageCache> {
  return readAppSettings().pricingProbeCache ?? {}
}

/** 更新单个源页面缓存（读最新 → 改 → 写回，避免覆盖探查期间其它写入） */
function updatePageCache(sourceId: string, patch: PricingPageCache): void {
  updateRawAppSettings((raw) => {
    const cache = (raw.pricingProbeCache ?? {}) as Record<string, PricingPageCache>
    cache[sourceId] = { ...cache[sourceId], ...patch }
    raw.pricingProbeCache = cache
  })
}

/** 读回某源已持久化的探查条目（页面未变更时直接沿用） */
function readProbedPricingEntries(sourceId: string): ProbedPricingEntry[] {
  return readAppSettings().probedPricing.filter((e) => e.sourceId === sourceId)
}

/**
 * 从全文定位定价区块文本（LLM 输入片段）：
 * 关键词（模型名，归一化匹配）命中位置构成的覆盖区间为主依据，缓存锚句区间并入取并集——
 * 即使历史锚句劣化（集中在单行）或漂移，也不会让片段小于关键词覆盖的定价表主体。
 * 全部失败回退整页头部截断（原行为兜底）。
 */
function locatePricingFragment(
  fullText: string,
  keywords: string[],
  anchors?: Pick<PricingPageCache, 'fragmentFrom' | 'fragmentTo'>
): string {
  const hits = firstKeywordHits(fullText, keywords)
  const span = pricingSpan(hits, fullText.length)
  const from = anchors?.fragmentFrom?.trim()
  const to = anchors?.fragmentTo?.trim()
  let aLo: number | undefined
  let aHi: number | undefined
  if (from && to) {
    const iFrom = fullText.indexOf(from)
    const iTo = fullText.indexOf(to)
    if (iFrom !== -1 && iTo !== -1 && iTo >= iFrom) {
      aLo = iFrom - FRAGMENT_PAD
      aHi = iTo + to.length + FRAGMENT_PAD
    }
  }
  const lo = Math.min(span ? span.lo - FRAGMENT_PAD / 2 : Infinity, aLo ?? Infinity)
  const hi = Math.max(span ? span.hi + FRAGMENT_PAD / 2 : -Infinity, aHi ?? -Infinity)
  if (lo !== Infinity && hi !== -Infinity && hi > lo) {
    return fullText.slice(Math.max(0, lo), Math.min(fullText.length, hi)).slice(0, MAX_PAGE_CHARS)
  }
  if (hits.length === 1) {
    const c = hits[0]
    return fullText.slice(Math.max(0, c - MAX_PAGE_CHARS / 2), c + MAX_PAGE_CHARS / 2)
  }
  return fullText.slice(0, MAX_PAGE_CHARS)
}

/** 清理锚文本：压缩空白。锚须是原文连续片段（indexOf 子串匹配），故不删内部字符 */
function cleanAnchor(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * 探查成功后从全文生成定价区块锚句：
 * 取所有条目 pattern（模型名）在全文中的命中位置，取 20%~80% 分位分别作为起止锚。
 * 用分位而非首末：顶部 DEAL/套餐区也会出现模型名（离群点），首末锚会被污染；
 * 分位锚稳定落在定价表主体，下次页面变更时间按锚切出完整定价区块。
 */
function deriveFragmentAnchors(
  fullText: string,
  entries: ProbedPricingEntry[]
): { fragmentFrom?: string; fragmentTo?: string } {
  if (entries.length === 0) return {}
  const hits = firstKeywordHits(fullText, entries.map((e) => e.pattern))
  if (hits.length === 0) return {}
  hits.sort((a, b) => a - b)
  const lo = quantile(hits, 0.2) ?? hits[0]
  const hi = quantile(hits, 0.8) ?? hits[hits.length - 1]
  const from = cleanAnchor(fullText.slice(Math.max(0, lo - 16), lo + 48))
  const to = cleanAnchor(fullText.slice(Math.max(0, hi - 48), hi + 16))
  return { fragmentFrom: from || undefined, fragmentTo: to || undefined }
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

/** 探查关键词：开关开启（缺省）则每次探查前调用 /models 刷新所绑定厂商的模型名缓存；关闭则直接用本地缓存 */
async function getSourceKeywords(source: PricingProbeSource): Promise<string[]> {
  const providerId = resolveSourceProviderId(source)
  if (!providerId) return []
  if (source.fetchModelsBeforeProbe !== false) {
    try {
      await fetchAndCacheModels(providerId)
    } catch {
      /* 忽略 /models 失败：回落到已有缓存列表 */
    }
  }
  const provider = getAllProviders().find((p) => p.id === providerId)
  return (provider?.models ?? []).map((m) => m.id).filter((id): id is string => !!id)
}

// ─── 探查目标：Command Code 按订阅套餐动态选计划页 + 额度列 ───

/** 探查目标：实际 URL + （仅 commandcode）月度额度列标题 */
export interface ProbeTarget {
  url: string
  /** 月度额度列标题；注入 prompt 防多列套餐页（如 max 页双列）取错列。套餐不可解析时缺省 */
  creditsColumn?: string
}

/** 源绑定的厂商是否为 Command Code（按 baseUrl 判定；探查增强逻辑——额度区块/全站补全——的共用门槛） */
export function isCommandCodeSource(source: PricingProbeSource): boolean {
  const providerId = resolveSourceProviderId(source)
  const provider = providerId ? getAllProviders().find((p) => p.id === providerId) : undefined
  return !!provider?.baseUrl?.includes('api.commandcode.ai')
}

/**
 * 解析源的探查目标。
 * 绑定厂商为 Command Code（baseUrl 含 api.commandcode.ai）时，读云监控快照里的订阅 planId，
 * 动态选对应计划页（URL 与额度列标题见 CC_PLAN_PAGE——每模型 Monthly credits 只在计划页有，
 * 且 max 页为双列、必须指列）；
 * 未登录 / 无订阅 / 未知 planId（teams-pro、provider 等无公开计划页）/ 快照异常 → 回退源自带 URL。
 * 其余源原样返回（零影响）。多账号时**Plan 账号优先**（其快照才带订阅），再按配置顺序找第一个能解析出套餐的。
 */
export function resolveProbeTarget(source: PricingProbeSource): ProbeTarget {
  if (!isCommandCodeSource(source)) return { url: source.url }
  try {
    // v5：套餐信息按**账号**存。同一源可能有 Plan 账号与按量账号——优先取 Plan 账号的订阅快照，
    // 拿不到再看其它账号，避免用按量账号的空订阅去否定套餐计划页。
    const mon = readAppSettings().monitoring
    const ccSourceIds = new Set(
      mon.sources.filter((s) => s.enabled && s.type === 'commandcode').map((s) => s.id)
    )
    const candidates = mon.accounts
      .filter((a) => ccSourceIds.has(a.sourceId))
      .sort((a, b) => (a.billing === b.billing ? 0 : a.billing === 'plan' ? -1 : 1))
    for (const acc of candidates) {
      const snap = getUsageSnapshot(acc.id)
      const planId = snap && 'subscription' in snap ? snap.subscription?.planId : undefined
      const page = planId ? CC_PLAN_PAGE[planId] : undefined
      if (page) {
        if (DEBUG) {
          console.log(`[PricingProbe] ${source.name}(${source.id}) 账号 ${acc.id} 套餐 ${planId} → 计划页 ${page.url}（额度列「${page.creditsColumn}」）`)
        }
        return { url: page.url, creditsColumn: page.creditsColumn }
      }
      if (DEBUG) {
        console.log(`[PricingProbe] ${source.name}(${source.id}) 账号 ${acc.id} 套餐不可用(planId=${planId ?? '无'})，回退源 URL ${source.url}`)
      }
    }
  } catch (err) {
    if (DEBUG) console.warn(`[PricingProbe] ${source.name}(${source.id}) 套餐解析失败，回退源 URL:`, err)
  }
  return { url: source.url }
}

// ─── LLM 提取 ───

function buildProbePrompt(
  source: PricingProbeSource,
  keywords: string[],
  pageText: string,
  creditsColumn?: string
): string {
  const keywordText = keywords.length > 0 ? keywords.join('、') : '页面上所有已定价模型'
  const tz = source.timezone || 'Asia/Shanghai'
  // 指列规则：仅按套餐解析出列标题时注入（多列套餐页必须指列；无该列的页面靠「没有此列就省略」兜底）
  const columnRule = creditsColumn
    ? `\n   - 本页是该套餐的计划页：monthlyCredits 只取列标题为「${creditsColumn}」的那一列（同页有多个额度列时其余一律忽略）；页面没有此列就省略。`
    : ''
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
{ "pattern": "模型ID或唯一前缀", "input": 数字, "output": 数字, "currency": "USD"|"CNY", "unit": "计费单位描述", "cacheRead": 数字(可选), "cacheCreation": 数字(可选), "monthlyCredits": 数字(可选), "windows": [ { "start": "HH:mm", "end": "HH:mm", "input": 数字, "output": 数字, "days": ["mon","tue"] (可选, 适用星期, 缺省=每天; 也接受 "weekday"/"工作日"/"weekend"/"周末" 或 [1,2,3] 数字数组) } ] }
   - 页面标注的「输入（缓存命中）」对应 cacheRead，「输入（缓存未命中）」对应 input。
   - monthlyCredits 是套餐给该模型的「月度额度」（如计划页 Monthly credits 列的 $70），是额度不是单价：取当前生效数值（促销行的划线原价忽略，只取现价）；页面没有该列就省略，不要编造。${columnRule}
4. windows 用于峰谷/错峰/时段优惠价（如 off-peak、错峰、时段折扣、凌晨低价、工作日/周末差价）。若页面含此类时段价，务必提取到 windows；无则省略该字段。窗口时间为 24 小时制 HH:mm，时区为 ${tz}。
4.5. 定价表可能延续到片段末尾（如 Inkling、Grok 等表尾模型）。务必把页面上所有已标注价格的模型都提取，不要遗漏表格末尾的行。
5. 除 JSON 数组外不要输出任何内容，不要使用 markdown 代码块，不要任何解释。

页面文本：
${pageText}`
}

/** 判定归一化后的关键词 nk 是否被某 pattern 归一化 np 覆盖（按词序连续子序列，避免 1 词子串误判） */
function seqCovered(nk: string, np: string): boolean {
  const a = nk.split(' ').filter(Boolean)
  const b = np.split(' ').filter(Boolean)
  if (a.length === 0 || b.length === 0) return false
  if (a.length === b.length) return a.every((w, i) => w === b[i])
  const [short, long] = a.length < b.length ? [a, b] : [b, a]
  // 单词语义过宽（如 inkling 覆盖 inkling-small），不放宽；多词才允许子序列匹配
  if (short.length < 2) return false
  for (let i = 0; i + short.length <= long.length; i++) {
    if (long.slice(i, i + short.length).every((w, j) => w === short[j])) return true
  }
  return false
}

/** 找出「页面文本中存在定价但当前提取条目未覆盖」的关键词（模型），用于定向二次补漏 */
function findMissingModels(
  fullText: string,
  keywords: string[],
  entries: ProbedPricingEntry[]
): string[] {
  const matchText = normalizeForMatch(fullText)
  const missing: string[] = []
  for (const k of keywords) {
    if (!k) continue
    const present = keywordVariants(k).some((v) => matchText.includes(normalizeForMatch(v)))
    if (!present) continue
    const nk = normalizeForMatch(k)
    const covered = entries.some((e) => {
      const np = e.pattern ? normalizeForMatch(e.pattern) : ''
      return np && seqCovered(nk, np)
    })
    if (!covered) missing.push(k)
  }
  return missing
}

/** 补漏输入：围绕每个缺失模型在全文中的位置切片（前后上下文），重叠区间合并后拼接。
 *  不依赖主定位窗口——即使主窗口被 12k 截断切掉了表尾，这里仍能精确包含目标模型行。 */
function buildMissingFragment(fullText: string, missing: string[]): string {
  const matchText = normalizeForMatch(fullText)
  // 每个缺失模型取一个命中位置，切片 [idx-300, idx+800]
  const ranges: { lo: number; hi: number }[] = []
  for (const k of missing) {
    for (const v of keywordVariants(k)) {
      const idx = matchText.indexOf(normalizeForMatch(v))
      if (idx >= 0) {
        ranges.push({ lo: Math.max(0, idx - 300), hi: Math.min(fullText.length, idx + 800) })
        break
      }
    }
  }
  if (ranges.length === 0) return fullText.slice(0, MAX_PAGE_CHARS)
  ranges.sort((a, b) => a.lo - b.lo)
  // 合并重叠/相邻区间
  const merged: { lo: number; hi: number }[] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r.lo <= last.hi + 200) last.hi = Math.max(last.hi, r.hi)
    else merged.push({ ...r })
  }
  return merged.map((r) => fullText.slice(r.lo, r.hi)).join('\n---\n')
}

/** 定向补提 prompt：从片段中提取指定模型的定价（用于同页补漏与全站 models 页补全两处调用） */
function buildFillPrompt(pageText: string, missing: string[], creditsColumn?: string): string {
  const columnRule = creditsColumn
    ? `\n- monthlyCredits 只取列标题为「${creditsColumn}」的那一列（同页多个额度列时其余忽略）；页面没有此列就省略。`
    : ''
  return `你是模型定价解析器。以下是官方定价页的文本片段（HTML/纯文本混合，忽略无关标记）。

⚠️ 请从片段中重点找到以下模型的定价并提取（其余模型不在本次范围）：
${missing.map((m, i) => `${i + 1}. ${m}`).join('\n')}

匹配规则与输出要求同上：
- 只输出 JSON 数组，每项：{ "pattern": "模型ID或唯一前缀", "input": 数字, "output": 数字, "currency": "USD"|"CNY", "unit": "计费单位描述", "cacheRead": 数字(可选), "cacheCreation": 数字(可选), "monthlyCredits": 数字(可选，该模型月度额度、取现价), "windows": 数组(可选) }
- 页面里没有明确价格的模型一律不要输出；不确定不要编造。${columnRule}
- 除 JSON 数组外不要输出任何内容，不要 markdown 代码块。

页面片段：
${pageText}`
}

// ─── 计划页额度区块：Usage limits（请求数限额）+ Monthly credits（月度额度）───

/**
 * 定位计划页额度区块片段（两段拼接）：
 *  1) 请求数限额表：锚「Requests / 5 hours」（goat/pro/max 三套餐页通用表头），前留 400 字符带入"official 估算"上下文说明；
 *  2) 月额度表：锚「Monthly credits」（goat/pro 有；max 页无此表 → 只提请求数）。
 * 锚都不存在返回 undefined（非计划页/页面改版 → 跳过，不影响定价主流程）。
 */
function locateCreditsFragment(fullText: string): string | undefined {
  const parts: string[] = []
  const iReq = fullText.indexOf(CREDITS_ANCHOR_REQUESTS)
  if (iReq !== -1) parts.push(fullText.slice(Math.max(0, iReq - 400), iReq + CREDITS_SLICE_CHARS))
  const iMc = fullText.indexOf(CREDITS_ANCHOR_MONTHLY)
  if (iMc !== -1) parts.push(fullText.slice(Math.max(0, iMc - 200), iMc + CREDITS_SLICE_CHARS))
  if (parts.length === 0) return undefined
  return parts.join('\n---\n').slice(0, MAX_PAGE_CHARS)
}

/** 额度区块提取 prompt：Usage limits（每模型请求数/窗口）+ Monthly credits（月度额度） */
function buildCreditsPrompt(pageText: string, creditsColumn?: string): string {
  const columnRule = creditsColumn
    ? `\n- monthlyCredits 只取列标题为「${creditsColumn}」的那一列（同页多个额度列时其余一律忽略）；页面没有此列就省略。`
    : ''
  return `你是订阅套餐额度解析器。以下是某厂商套餐计划页的文本（HTML/纯文本混合，忽略无关标记）。
页面包含两类额度数据：
1) 用量限额表（表头形如 "Model / Requests / 5 hours / Requests / week / Requests / month"）：每个模型在各窗口内可用的**请求数**（官方估算）；
2) 月度额度表（表头含 "Monthly credits"）：每个模型的月度额度（美元，如 $70）。

请提取页面上这两类表的全部数据，输出 JSON 数组，每项结构：
{ "pattern": "模型名", "fiveHour": 数字(可选), "weekly": 数字(可选), "monthly": 数字(可选), "monthlyCredits": 数字(可选) }
- fiveHour / weekly / monthly 分别对应 Requests / 5 hours、Requests / week、Requests / month 三列；monthlyCredits 为 Monthly credits 列值。
- 数值必须来自页面；"Free" 等非数字一律省略该字段（不要填 0）。
- 同一模型的请求数限额与月度额度尽量合并为一条；提不全时就拆多条。
- 页面没有的数据不要编造。${columnRule}
- 除 JSON 数组外不要输出任何内容，不要使用 markdown 代码块。

页面文本：
${pageText}`
}

/** 额度提取的原始条目（LLM 输出，字段名宽容解析） */
interface RawCreditsEntry {
  pattern?: unknown
  model?: unknown
  name?: unknown
  /** 5 小时窗口请求数；LLM 可能用 fiveHour/five_hour/fiveHours 等变体 */
  fiveHour?: unknown
  weekly?: unknown
  monthly?: unknown
  monthlyCredits?: unknown
}

/** 从原始条目按候选字段名取第一个可解析为有限数的值 */
function pickNum(rec: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const n = toFiniteNum(rec[k])
    if (n !== undefined) return n
  }
  return undefined
}

/**
 * 把额度提取结果按模型合并进价格条目（只更新已存在条目，匹配不上的忽略——额度不是独立条目）。
 * usageLimits 各窗口与 monthlyCredits 独立更新：本次提不到的字段保留旧值；负值/非数字跳过。
 * 返回发生更新的条目数。
 */
export function mergeCreditsIntoEntries(
  entries: ProbedPricingEntry[],
  raw: RawCreditsEntry[],
  keywords: string[]
): number {
  let touched = 0
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const patternRaw =
      typeof rec.pattern === 'string' ? rec.pattern : typeof rec.model === 'string' ? rec.model : typeof rec.name === 'string' ? rec.name : ''
    if (!patternRaw.trim()) continue
    const key = normalizeForMatch(canonicalizePattern(patternRaw.trim(), keywords))
    const entry = entries.find((e) => normalizeForMatch(e.pattern) === key)
    if (!entry) continue

    let changed = false
    const fiveHour = pickNum(rec, ['fiveHour', 'five_hour', 'fiveHours', 'five_hours', 'fivehour'])
    const weekly = pickNum(rec, ['weekly', 'week', 'weekLimit', 'week_limit'])
    const monthly = pickNum(rec, ['monthly', 'month', 'monthLimit', 'month_limit'])
    if (fiveHour !== undefined || weekly !== undefined || monthly !== undefined) {
      const limits: ProbedUsageLimits = { ...entry.usageLimits }
      const setLim = (k: 'fiveHour' | 'weekly' | 'monthly', v: number | undefined) => {
        if (v !== undefined && v >= 0) {
          limits[k] = Math.round(v)
          changed = true
        }
      }
      setLim('fiveHour', fiveHour)
      setLim('weekly', weekly)
      setLim('monthly', monthly)
      if (changed) entry.usageLimits = limits
    }
    const mc = toMonthlyCredits(rec.monthlyCredits)
    if (mc !== undefined) {
      entry.monthlyCredits = mc
      changed = true
    }
    if (changed) touched++
  }
  return touched
}

/** 合并补充条目（按归一化 pattern 去重、保留既有条目；用于补漏与全站补全）。返回新增条数 */
function appendNewEntries(entries: ProbedPricingEntry[], extra: ProbedPricingEntry[]): number {
  const known = new Set(entries.map((e) => normalizeForMatch(e.pattern)).filter(Boolean))
  let added = 0
  for (const ex of extra) {
    const key = normalizeForMatch(ex.pattern)
    if (!key || known.has(key)) continue
    known.add(key)
    entries.push(ex)
    added++
  }
  return added
}

/** 日志用简短片段：压缩空白后取前 40 字符 */
function briefOf(s: string): string {
  return s.replace(/\s+/g, ' ').slice(0, 40)
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
  /** 模型月度额度（计划页 Monthly credits 列；外部数据，严格解析见 toMonthlyCredits） */
  monthlyCredits?: unknown
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

/** 月度额度严格解析（外部数据防御）：仅 number / "$70" / "70" 形态；
 *  促销串（"$30 $67"、"67 through Sep 24th"）、负数、空 → undefined（宁缺勿错，条目其余字段照存） */
function toMonthlyCredits(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : undefined
  if (typeof v === 'string') {
    const m = v.trim().match(/^\$?\s*(\d+(?:\.\d+)?)$/)
    if (m) {
      const n = Number(m[1])
      if (Number.isFinite(n)) return n
    }
  }
  return undefined
}

/** 包裹对象中可能承载数组的字段名 */
const WRAPPER_ARRAY_KEYS = ['data', 'pricing', 'prices', 'items', 'models', 'result', 'entries', 'experts'] as const

/** 从 LLM 输出中提取条目数组：支持数组 / { data|pricing|...: [...] } 包裹 / 单个对象。
 *  泛型 T 供复用方（如专家团生成器）指定条目形状；缺省 RawProbeEntry，既有调用推断不变 */
export function extractJsonArray<T = RawProbeEntry>(content: string): T[] | null {
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
      if (Array.isArray(parsed)) return parsed as T[]
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>
        for (const key of WRAPPER_ARRAY_KEYS) {
          const v = obj[key]
          if (Array.isArray(v)) return v as T[]
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
            if (Array.isArray(v)) return v as T[]
          }
          return [o as unknown as T]
        }
      } catch {
        /* ignore */
      }
    }
  }
  return null
}

/** 从 LLM 输出中提取第一个平衡花括号 JSON 对象（剥 markdown 代码块、容错前置说明与拖尾文字；字符串感知：引号内 {} 不计入平衡——N-1）。失败返回 null */
export function extractJsonObject(content: string): Record<string, unknown> | null {
  let s = content.replace(/```[a-zA-Z]*/g, '').trim()
  // 截掉前置说明文字（定位到首个 [ 或 {）
  const firstJson = s.search(/[[{]/)
  if (firstJson > 0) s = s.slice(firstJson)

  const braceStart = s.indexOf('{')
  if (braceStart === -1) return null
  let depth = 0
  let braceEnd = -1
  let inString = false // 字符串感知（N-1）：双引号内的 {} 不计入平衡深度
  for (let i = braceStart; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (ch === '\\') i++ // 转义：跳过被转义字符
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { braceEnd = i; break }
    }
  }
  if (braceEnd === -1) return null

  try {
    const obj = JSON.parse(s.slice(braceStart, braceEnd + 1))
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null
  } catch {
    return null
  }
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

function buildProbedEntries(source: PricingProbeSource, raw: RawProbeEntry[], keywords: string[] = []): ProbedPricingEntry[] {
  const tz = source.timezone || 'Asia/Shanghai'
  const now = Date.now()
  // T2 探查分绑（设计 §5）：源绑定了 provider → 条目带 providerId/billing，命中时按通道过滤；未绑 → 通用条目（两字段不写）
  const boundProvider = source.providerId ? getAllProviders().find((p) => p.id === source.providerId) : undefined
  const entries: ProbedPricingEntry[] = []
  // 同页重复 pattern（LLM 输出抖动）只留首条：外部边界一次去重，避免下游重复行 / 重复 React key
  const seen = new Set<string>()
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
    // pattern 规范化：页面显示名 → 所绑定厂商 /models 模型 ID（未绑定/对应不上时保留原样）
    const pattern = canonicalizePattern(patternRaw.trim(), keywords)
    const currency = item.currency === 'CNY' ? 'CNY' : 'USD'
    const input = toFiniteNum(item.input)
    const output = toFiniteNum(item.output)
    // 无模型标识则丢弃；负数视为异常数据丢弃（缺失数值按 0 处理：页面标注免费）
    if (!pattern) continue
    if ((input !== undefined && input < 0) || (output !== undefined && output < 0)) continue
    const dupKey = normalizeForMatch(pattern)
    if (seen.has(dupKey)) continue
    seen.add(dupKey)

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
    if (boundProvider) {
      entry.providerId = boundProvider.id
      entry.billing = boundProvider.billing
    }

    const cacheRead = toFiniteNum(item.cacheRead)
    const cacheCreation = toFiniteNum(item.cacheCreation)
    if (cacheRead !== undefined && cacheRead >= 0) entry.cacheRead = cacheRead / rate
    if (cacheCreation !== undefined && cacheCreation >= 0) entry.cacheCreation = cacheCreation / rate

    // 月度额度：严格解析，异常值只丢该字段、不影响条目其余内容
    const monthlyCredits = toMonthlyCredits(item.monthlyCredits)
    if (monthlyCredits !== undefined) entry.monthlyCredits = monthlyCredits / rate

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
  updateRawAppSettings((raw) => {
    const existing = Array.isArray(raw.probedPricing) ? (raw.probedPricing as ProbedPricingEntry[]) : []
    raw.probedPricing = [...existing.filter((e) => e.sourceId !== sourceId), ...entries]
  })
}

// ─── 探查入口 ───

export type ProbeSourceResult =
  | { ok: true; entries: ProbedPricingEntry[]; skipped?: boolean }
  | { ok: false; error: string }

export type ProbeStage = 'fetching' | 'extracting'

export async function probeSource(
  source: PricingProbeSource,
  model: ProbeModel,
  onStage?: (stage: ProbeStage) => void,
  force = false
): Promise<ProbeSourceResult> {
  // 关键词自动取所绑定厂商 /models 的模型名
  const keywords = await getSourceKeywords(source)
  // 探查目标：Command Code 按订阅套餐动态选计划页（含额度列标题），其余源原样（后续抓取/来源记录统一用 effSource）
  const target = resolveProbeTarget(source)
  const effSource = { ...source, url: target.url }
  // Command Code 增强（额度区块 / 套餐外模型补全）门槛：仅 CC 源生效，其余源零影响
  const isCc = isCommandCodeSource(source)
  if (DEBUG) {
    console.log(`[PricingProbe] ${effSource.name}(${effSource.id}) probe model: ${model.baseUrl} / ${model.modelId}${force ? ' [force]' : ''} url=${effSource.url}`)
  }
  onStage?.('fetching')
  const fullText = await fetchPageText(effSource.url, keywords)
  if (!fullText) {
    return { ok: false, error: '抓取失败（HTTP 与浏览器均无法获取有效页面文本）' }
  }

  // 页面级缓存：哈希相同 → 页面未变更，沿用上次结果、跳过 LLM 调用（强制探查时跳过此判断）
  const cache = readPageCache()[source.id]
  const hash = hashPageText(fullText)
  if (!force && cache?.hash && cache.hash === hash) {
    const existing = readProbedPricingEntries(source.id)
    if (existing.length > 0) {
      if (DEBUG) {
        console.log(
          `[PricingProbe] ${source.name}(${source.id}) page unchanged (${fullText.length} chars), reuse ${existing.length} entries, skip LLM`
        )
      }
      return { ok: true, entries: existing, skipped: true }
    }
  }

  // 定位定价区块（锚句 → 关键词居中 → 整页头部），避免全页送入 LLM
  const pageText = locatePricingFragment(fullText, keywords, cache)
  const prompt = buildProbePrompt(effSource, keywords, pageText, target.creditsColumn)
  onStage?.('extracting')
  const result = await callProbeLLM(model, prompt)
  if (result.status !== 'success' || !result.content) {
    return { ok: false, error: `大模型调用失败: ${result.error || '空响应'}` }
  }
  if (DEBUG) {
    console.log(
      `[PricingProbe] ${source.name}(${source.id}) page ${fullText.length} chars, fragment ${pageText.length} chars (…${briefOf(pageText.slice(0, 40))}…|…${briefOf(pageText.slice(-60))}), keywords ${keywords.length}, LLM response ${result.content.length} chars`
    )
  }

  let entries = buildProbedEntries(effSource, extractJsonArray(result.content) ?? [], keywords)
  if (entries.length === 0) {
    // 失败时打印原始响应便于定位（可能是格式不符 / 页面无相关价格）
    console.warn(
      `[PricingProbe] ${source.name}(${source.id}) 未解析出有效定价${DEBUG ? `，LLM 原始响应: ${result.content.slice(0, 800)}` : ''}`
    )
    return { ok: false, error: '未能从页面解析出有效定价' }
  }

  // 补漏：页面存在定价但首轮未提取的模型 → 定向二次提取（输入按缺失模型位置切片，确保目标行必在片段内）
  const missing = findMissingModels(fullText, keywords, entries)
  if (missing.length > 0 && missing.length <= 20) {
    const fillText = buildMissingFragment(fullText, missing)
    const fill = await callProbeLLM(model, buildFillPrompt(fillText, missing, target.creditsColumn))
    if (fill.status === 'success' && fill.content) {
      const added = appendNewEntries(entries, buildProbedEntries(effSource, extractJsonArray(fill.content) ?? [], keywords))
      if (DEBUG && added > 0) {
        console.log(`[PricingProbe] ${source.name}(${source.id}) fill missing ${missing.length} models → +${added} entries`)
      }
    }
  }

  // 额度区块（仅 Command Code 计划页）：Usage limits 每模型请求数 + Monthly credits 月度额度 → 合并进价格条目
  if (isCc) {
    const creditsText = locateCreditsFragment(fullText)
    if (creditsText) {
      const cr = await callProbeLLM(model, buildCreditsPrompt(creditsText, target.creditsColumn))
      if (cr.status === 'success' && cr.content) {
        const creditsRaw = extractJsonArray<RawCreditsEntry>(cr.content) ?? []
        const touched = mergeCreditsIntoEntries(entries, creditsRaw, keywords)
        if (DEBUG) {
          console.log(`[PricingProbe] ${source.name}(${source.id}) credits extract: ${creditsRaw.length} rows → ${touched} entries updated`)
        }
      } else if (DEBUG) {
        console.warn(`[PricingProbe] ${source.name}(${source.id}) credits extract failed: ${cr.error || 'empty'}`)
      }
    } else if (DEBUG) {
      console.log(`[PricingProbe] ${source.name}(${source.id}) credits anchors not found, skip credits extract`)
    }
  }

  // 套餐外模型补全（仅 Command Code，缺省开启）：计划页未覆盖的模型（premium / 未列入套餐）→ 全站 models 页定向补价
  if (isCc && source.fetchAllModelsPricing !== false && keywords.length > 0) {
    const covered = new Set(entries.map((e) => e.pattern))
    const uncovered = keywords.filter((k) => !covered.has(k))
    if (uncovered.length > 0 && uncovered.length <= ALL_MODELS_FILL_MAX) {
      const modelsText = await fetchPageText(CC_MODELS_URL, uncovered)
      if (modelsText) {
        const frag = buildMissingFragment(modelsText, uncovered)
        const fill = await callProbeLLM(model, buildFillPrompt(frag, uncovered))
        if (fill.status === 'success' && fill.content) {
          const added = appendNewEntries(
            entries,
            buildProbedEntries({ ...effSource, url: CC_MODELS_URL }, extractJsonArray(fill.content) ?? [], keywords)
          )
          if (DEBUG) {
            console.log(`[PricingProbe] ${source.name}(${source.id}) all-models fill: ${uncovered.length} uncovered → +${added} entries`)
          }
        } else if (DEBUG) {
          console.warn(`[PricingProbe] ${source.name}(${source.id}) all-models fill failed: ${fill.error || 'empty'}`)
        }
      } else if (DEBUG) {
        console.warn(`[PricingProbe] ${source.name}(${source.id}) all-models page fetch failed: ${CC_MODELS_URL}`)
      }
    } else if (DEBUG && uncovered.length > ALL_MODELS_FILL_MAX) {
      console.log(`[PricingProbe] ${source.name}(${source.id}) uncovered=${uncovered.length} exceeds ${ALL_MODELS_FILL_MAX}, skip all-models fill`)
    }
  }

  persistProbedPricing(source.id, entries)
  // 记录页面哈希与定价区块锚句：下次哈希不变直接沿用；变则按锚切片段快速解析。
  // 注：哈希仅跟踪计划页（含额度区块），全站 models 页变化不触发重探（需「强制探查」）。
  updatePageCache(source.id, { hash, ...deriveFragmentAnchors(fullText, entries) })
  return { ok: true, entries }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 可重试的 LLM 错误：5xx / 524（上游超时）/ 取消与超时（含 streamChat 的中文超时文案）/ 网络类（导出供专家团生成等复用） */
export function isRetriableLLMError(err: string): boolean {
  return /HTTP\s+5\d\d|HTTP\s+524|aborted|timed?\s*out|超时|流中断|temporarily unavailable|ECONNRESET|ECONNREFUSED|ENETUNREACH|network|fetch failed/i.test(err)
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
  /** 页面未变更、沿用旧结果（未调用 LLM） */
  skipped?: boolean
}

/** 顺序探查（避免并发 LLM 调用 / 触发限流）。onProgress 在每个源的阶段变化与完成时回调 */
export async function probeSources(
  sources: PricingProbeSource[],
  model: ProbeModel,
  onProgress?: (p: ProbeProgressEvent) => void,
  force = false
): Promise<ProbeBatchResultItem[]> {
  const results: ProbeBatchResultItem[] = []
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]
    const base = { sourceId: source.id, sourceName: source.name, index: i + 1, total: sources.length }
    onProgress?.({ ...base, stage: 'fetching' })
    const r = await probeSource(source, model, (stage) => onProgress?.({ ...base, stage }), force)
    results.push({
      sourceId: source.id,
      ok: r.ok,
      entryCount: r.ok ? r.entries.length : undefined,
      error: r.ok ? undefined : r.error,
      skipped: r.ok ? r.skipped : undefined
    })
    onProgress?.({
      ...base,
      stage: 'extracting',
      done: true,
      ok: r.ok,
      entryCount: r.ok ? r.entries.length : undefined,
      error: r.ok ? undefined : r.error,
      skipped: r.ok ? r.skipped : undefined
    })
    if (!r.ok) console.warn(`[PricingProbe] ${source.name}(${source.id}) failed: ${r.error}`)
  }
  return results
}

/** 读取定价探查配置；自动并入所有已配置 API Key 厂商的派生源（未手动创建源的厂商自动可用，不持久化） */
export function getPricingProbeConfig(): { autoRefreshSeconds: number; sources: PricingProbeSource[] } {
  const pp = readAppSettings().pricingProbe
  const configSources = pp.sources
  // 自动刷新间隔（秒）；兼容旧配置 autoRefreshDays（天 → 秒）
  const legacyDays = (pp as { autoRefreshDays?: unknown }).autoRefreshDays
  const legacy =
    typeof legacyDays === 'number' && Number.isFinite(legacyDays) && legacyDays > 0 ? Math.round(legacyDays * 24 * 60 * 60) : 0
  const autoRefreshSeconds =
    typeof pp.autoRefreshSeconds === 'number' && Number.isFinite(pp.autoRefreshSeconds) && pp.autoRefreshSeconds >= 0
      ? pp.autoRefreshSeconds
      : legacy

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

  return { autoRefreshSeconds, sources: [...configSources, ...autoSources] }
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
