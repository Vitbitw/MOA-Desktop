// 行为测试：定价探查「每模型 Monthly credits + Usage limits 请求数」— 严格解析 / 套餐→探查目标（URL+额度列）/ prompt 指列 / pattern 规范化（显示名→/models ID）/ 额度合并 / 边界去重
// 抽取 probe.ts + commandCode.ts 的纯函数（同 monitor-behavior.cjs 的抽取法）→ esbuild 转译 → 断言
// 用法：node test-e2e/pricing-probe-cc.cjs
const fs = require('fs')
const path = require('path')

const probeFile = process.argv[2] || path.resolve(__dirname, '../src/main/pricing/probe.ts')
const ccFile = process.argv[3] || path.resolve(__dirname, '../src/main/monitoring/commandCode.ts')
// 归一化换行：CRLF 检出下抽取正则按 LF 形状匹配
const read = (f) => fs.readFileSync(f, 'utf8').split(String.fromCharCode(13)).join('')
const probeSrc = read(probeFile)
const ccSrc = read(ccFile)

function grab(src, name, re) {
  const m = src.match(re)
  if (!m) throw new Error('抽取失败: ' + name)
  return m[0]
}
const pfn = (name) => grab(probeSrc, name, new RegExp('(?:async )?function ' + name + '\\([\\s\\S]*?\\n\\}\\n'))

const parts = [
  grab(probeSrc, 'DEBUG', /const DEBUG = [^\n]+/),
  grab(probeSrc, 'CNY_TO_USD_RATE', /const CNY_TO_USD_RATE = [^\n]+/),
  grab(probeSrc, 'HHMM_RE', /const HHMM_RE = [^\n]+/),
  grab(probeSrc, 'WEEKDAY_ABBR', /const WEEKDAY_ABBR[\s\S]*?\n}/),
  grab(probeSrc, 'normalizeForMatch', /function normalizeForMatch\([\s\S]*?\n\}\n/),
  pfn('keywordVariants'),
  pfn('seqCovered'),
  pfn('canonNorm'),
  pfn('canonicalizePattern'),
  grab(probeSrc, 'MAX_PAGE_CHARS', /const MAX_PAGE_CHARS = [^\n]+/),
  grab(probeSrc, 'CREDITS_ANCHOR_REQUESTS', /const CREDITS_ANCHOR_REQUESTS = [^\n]+/),
  grab(probeSrc, 'CREDITS_ANCHOR_MONTHLY', /const CREDITS_ANCHOR_MONTHLY = [^\n]+/),
  grab(probeSrc, 'CREDITS_SLICE_CHARS', /const CREDITS_SLICE_CHARS = [^\n]+/),
  pfn('toFiniteNum'),
  pfn('toMonthlyCredits'),
  pfn('parseDays'),
  pfn('normalizeWindow'),
  pfn('buildProbedEntries'),
  pfn('resolveSourceProviderId'),
  pfn('isCommandCodeSource'),
  pfn('resolveProbeTarget'),
  pfn('buildProbePrompt'),
  pfn('buildFillPrompt'),
  pfn('locateCreditsFragment'),
  pfn('buildCreditsPrompt'),
  pfn('pickNum'),
  pfn('mergeCreditsIntoEntries'),
  grab(ccSrc, 'CC_PLAN_PAGE', /const CC_PLAN_PAGE\s*:[\s\S]*?\n}/)
]

let cachedJs = null
/** 依赖注入：getAllProviders / readAppSettings / getUsageSnapshot 按用例传 stub */
function makeFactory(deps) {
  if (!cachedJs) {
    const esbuild = require('esbuild')
    cachedJs = esbuild.transformSync(parts.join('\n\n'), { loader: 'ts', format: 'cjs', target: 'node18' }).code
  }
  const f = new Function(
    'getAllProviders',
    'readAppSettings',
    'getUsageSnapshot',
    cachedJs +
      '\n; return { toMonthlyCredits, buildProbedEntries, resolveProbeTarget, buildProbePrompt, buildFillPrompt, CC_PLAN_PAGE, canonicalizePattern, locateCreditsFragment, buildCreditsPrompt, mergeCreditsIntoEntries }'
  )
  return f(
    deps.getAllProviders || (() => []),
    deps.readAppSettings || (() => ({ monitoring: { sources: [] } })),
    deps.getUsageSnapshot || (() => null)
  )
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
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, { actual, expected })
}

const CC_PROVIDER = {
  id: 'cc',
  name: 'Command Code',
  baseUrl: 'https://api.commandcode.ai/provider/v1',
  enabled: true,
  apiKey: 'k'
}
const CC_SOURCE = { id: 'commandcode', name: 'Command Code', providerId: 'cc', url: 'https://commandcode.ai/docs/resources/pricing-limits', enabled: true }
const MON_SOURCES = [{ id: 'commandcode', type: 'commandcode', name: 'Command Code 云端', studioUrl: '', enabled: true }]
const FALLBACK = CC_SOURCE.url

// ── 1. toMonthlyCredits 严格解析 ──
console.log('toMonthlyCredits：')
{
  const f = makeFactory({})
  eq(f.toMonthlyCredits(67), 67, 'number 原样')
  eq(f.toMonthlyCredits(0), 0, '0 合法')
  eq(f.toMonthlyCredits('$70'), 70, '"$70" 带 $ 前缀')
  eq(f.toMonthlyCredits(' 72.5 '), 72.5, '空白包裹数字')
  eq(f.toMonthlyCredits('$30 $67'), undefined, '促销双值串 → undefined')
  eq(f.toMonthlyCredits('67 through Sep 24th'), undefined, '促销说明串 → undefined')
  eq(f.toMonthlyCredits('~~$30~~ $67'), undefined, '划线+现价串 → undefined')
  eq(f.toMonthlyCredits('1e3'), undefined, '科学计数串 → undefined')
  eq(f.toMonthlyCredits('$ 70'), 70, '"$ 70"（$ 后空格）合法')
  eq(f.toMonthlyCredits('70.5.5'), undefined, '多小数点串 → undefined')
  eq(f.toMonthlyCredits('70,'), undefined, '带尾逗号串 → undefined')
  eq(f.toMonthlyCredits(-1), undefined, '负数 → undefined')
  eq(f.toMonthlyCredits(''), undefined, '空串 → undefined')
  eq(f.toMonthlyCredits(null), undefined, 'null → undefined')
  eq(f.toMonthlyCredits(NaN), undefined, 'NaN → undefined')
}

// ── 2. buildProbedEntries 写入 monthlyCredits + 归一化去重 ──
console.log('buildProbedEntries：')
{
  const f = makeFactory({})
  const src = { ...CC_SOURCE, timezone: 'Asia/Shanghai' }
  const entries = f.buildProbedEntries(src, [
    { pattern: 'deepseek-v4-flash', input: 0.15, output: 0.6, currency: 'USD', monthlyCredits: 60 },
    { pattern: 'DEEPSEEK/v4-FLASH', input: 0.2, output: 0.7, currency: 'USD', monthlyCredits: 55 },
    { pattern: 'glm-5.2', input: 1.4, output: 4.4, currency: 'USD', monthlyCredits: '$70' },
    { pattern: 'promo-model', input: 1, output: 2, currency: 'USD', monthlyCredits: '~~$30~~ $67 through Sep 24th' },
    { pattern: 'cn-model', input: 72, output: 144, currency: 'CNY', monthlyCredits: 72 },
    { pattern: 'no-mc-model', input: 1, output: 2, currency: 'USD' }
  ])
  eq(entries.length, 5, '归一化重复 pattern 去重（首条保留）且非法月额度不丢条目')
  eq(entries[0].monthlyCredits, 60, 'USD 数值直存（重复项未覆盖首条）')
  eq(entries[1].pattern, 'glm-5.2', '第 2 条是 glm（重复 pattern 已跳过）')
  eq(entries[1].monthlyCredits, 70, '"$70" 字符串解析')
  eq(entries[2].monthlyCredits, undefined, '促销串丢字段、条目保留')
  ok(entries[2].pattern === 'promo-model' && entries[2].input === 1, '促销条目其余字段完好')
  eq(entries[3].monthlyCredits, 10, 'CNY 按 7.2 折算（72 → 10）')
  eq(entries[4].monthlyCredits, undefined, '页面无该列 → 字段缺省')
  eq(entries[0].sourceUrl, src.url, 'sourceUrl 记录实际探查页')
}

// ── 3. resolveProbeTarget：按订阅套餐动态选计划页 + 额度列标题 ──
console.log('resolveProbeTarget：')
{
  // v5：套餐按**账号**存。用例造两个账号——按量账号排在前且无订阅，
  // 断言 resolveProbeTarget 会优先取 Plan 账号的快照（否则会误回退到源 URL）
  const mk = (planId, providers) =>
    makeFactory({
      getAllProviders: () => providers || [CC_PROVIDER],
      readAppSettings: () => ({
        monitoring: {
          sources: MON_SOURCES,
          accounts: [
            { id: 'commandcode-payg', sourceId: 'commandcode', label: '按量号', billing: 'usage' },
            { id: 'commandcode', sourceId: 'commandcode', label: 'Plan号', billing: 'plan' }
          ]
        }
      }),
      getUsageSnapshot: (accountId) => {
        if (accountId === 'commandcode-payg') return {} // 按量账号：有快照但无订阅
        return planId === undefined ? null : { subscription: planId ? { planId } : {} }
      }
    })

  eq(mk('individual-goat').resolveProbeTarget(CC_SOURCE), { url: 'https://commandcode.ai/docs/plans/goat', creditsColumn: 'Monthly credits' }, 'goat → goat 计划页 + Monthly credits 列')
  eq(mk('individual-go').resolveProbeTarget(CC_SOURCE), { url: 'https://commandcode.ai/docs/plans/go', creditsColumn: 'Monthly credits' }, 'go → go 计划页 + Monthly credits 列')
  eq(mk('individual-pro-v1').resolveProbeTarget(CC_SOURCE), { url: 'https://commandcode.ai/docs/plans/pro', creditsColumn: 'Monthly credits' }, 'pro-v1 → pro 计划页')
  // max 页是 Max 10×/20× 双列且无 Monthly credits 列 → 必须按套餐指列（评审 F1）
  eq(mk('individual-max').resolveProbeTarget(CC_SOURCE), { url: 'https://commandcode.ai/docs/plans/max', creditsColumn: 'Max 10× credits' }, 'max → max 计划页 + 10× 列')
  eq(mk('individual-ultra').resolveProbeTarget(CC_SOURCE), { url: 'https://commandcode.ai/docs/plans/max', creditsColumn: 'Max 20× credits' }, 'ultra → max 计划页 + 20× 列')
  eq(mk('teams-pro').resolveProbeTarget(CC_SOURCE), { url: FALLBACK }, 'teams-pro 无公开计划页 → 回退且无列提示')
  eq(mk('individual-provider').resolveProbeTarget(CC_SOURCE), { url: FALLBACK }, 'individual-provider（PAYG）→ 回退')
  eq(mk('brand-new-plan').resolveProbeTarget(CC_SOURCE), { url: FALLBACK }, '未知 planId → 回退')
  eq(mk(undefined).resolveProbeTarget(CC_SOURCE), { url: FALLBACK }, '无监控快照 → 回退')
  eq(mk('').resolveProbeTarget(CC_SOURCE), { url: FALLBACK }, '有快照无订阅 → 回退')

  // 非 Command Code 原商：即使有快照也原样返回（零影响）
  const deepseekProvider = [{ id: 'ds', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', enabled: true, apiKey: 'k' }]
  eq(
    mk('individual-goat', deepseekProvider).resolveProbeTarget({ id: 'deepseek', name: 'DeepSeek', url: 'https://api-docs.deepseek.com/x', enabled: true }),
    { url: 'https://api-docs.deepseek.com/x' },
    '非 commandcode 源原样返回'
  )

  // 无 providerId：按名称回退匹配（预置源形态）
  eq(
    mk('individual-goat').resolveProbeTarget({ id: 'auto:cc', name: 'Command Code', url: FALLBACK, enabled: true }),
    { url: 'https://commandcode.ai/docs/plans/goat', creditsColumn: 'Monthly credits' },
    '无 providerId 按名称匹配 → 仍解析到计划页'
  )
}

// ── 4. prompt 含 monthlyCredits 字段与取现价规则 ──
console.log('prompt：')
{
  const f = makeFactory({})
  const src = { id: 'commandcode', name: 'Command Code', url: FALLBACK, enabled: true, timezone: 'Asia/Shanghai' }
  const prompt = f.buildProbePrompt(src, ['deepseek-v4-flash'], 'TEXT')
  ok(prompt.includes('monthlyCredits'), '主 prompt 输出结构含 monthlyCredits')
  ok(prompt.includes('当前生效'), '主 prompt 要求促销取现价')
  ok(prompt.includes('额度不是单价'), '主 prompt 声明是额度不是单价')
  ok(!prompt.includes('只取列标题为'), '无列提示（非 cc / 套餐未解析）→ 不含指列规则')

  const maxPrompt = f.buildProbePrompt(src, ['deepseek-v4-flash'], 'TEXT', 'Max 10× credits')
  ok(maxPrompt.includes('只取列标题为「Max 10× credits」'), '带列提示 → 主 prompt 含 10× 指列规则')

  const fill = f.buildFillPrompt('TEXT', ['m1'])
  ok(fill.includes('monthlyCredits'), '补漏 prompt 输出结构含 monthlyCredits')
  ok(!fill.includes('只取列标题为'), '补漏无列提示 → 不含指列规则')
  const maxFill = f.buildFillPrompt('TEXT', ['m1'], 'Max 20× credits')
  ok(maxFill.includes('只取列标题为「Max 20× credits」'), '补漏 prompt 含 20× 指列规则')
}

// ── 5. CC_PLAN_PAGE 映射表（URL + 额度列，四页实抓核对） ──
console.log('CC_PLAN_PAGE：')
{
  const f = makeFactory({})
  eq(
    f.CC_PLAN_PAGE,
    {
      'individual-go': { url: 'https://commandcode.ai/docs/plans/go', creditsColumn: 'Monthly credits' },
      'individual-goat': { url: 'https://commandcode.ai/docs/plans/goat', creditsColumn: 'Monthly credits' },
      'individual-pro': { url: 'https://commandcode.ai/docs/plans/pro', creditsColumn: 'Monthly credits' },
      'individual-pro-v1': { url: 'https://commandcode.ai/docs/plans/pro', creditsColumn: 'Monthly credits' },
      'individual-max': { url: 'https://commandcode.ai/docs/plans/max', creditsColumn: 'Max 10× credits' },
      'individual-ultra': { url: 'https://commandcode.ai/docs/plans/max', creditsColumn: 'Max 20× credits' }
    },
    '六条映射（URL+额度列）与四页实抓一致'
  )
}

// ── 6. canonicalizePattern：页面显示名 → /models 规范 ID ──
console.log('canonicalizePattern：')
{
  const f = makeFactory({})
  const KW = [
    'moonshotai/Kimi-K3', 'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-flash-vision-exp',
    'deepseek/deepseek-v4-flash-fast', 'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4.1-flash',
    'Qwen/Qwen3.8-Max', 'Qwen/Qwen3.8-Max-0902', 'Qwen/Qwen3.8-27B', 'z-ai/glm-5.3-flash',
    'z-ai/glm-5.3-flashx', 'zai-org/GLM-5.3', 'xiaomi/mimo-v2.6-pro', 'xiaomi/mimo-v2.6-pro-ultraspeed',
    'tencent/hy3-paid', 'MiniMaxAI/MiniMax-M3', 'nvidia/nemotron-3-ultra-550b-a55b', 'gpt-5.6-sol', 'stealth/pixel-canary'
  ]
  eq(f.canonicalizePattern('Kimi K3', KW), 'moonshotai/Kimi-K3', '显示名 → 规范 ID')
  eq(f.canonicalizePattern('deepseek/deepseek-v4-flash', KW), 'deepseek/deepseek-v4-flash', '已规范 ID → 原样')
  eq(f.canonicalizePattern('DeepSeek V4 Flash (latest)', KW), 'deepseek/deepseek-v4-flash', '剥 (latest) 归一化命中')
  eq(f.canonicalizePattern('DeepSeek V4 Flash Vision (exp)', KW), 'deepseek/deepseek-v4-flash-vision-exp', '(exp) 括注含语义 → vision-exp（防回归：不落 v4-flash）')
  eq(f.canonicalizePattern('DeepSeek V4 Flash Fast', KW), 'deepseek/deepseek-v4-flash-fast', 'Fast 变体不落基础版')
  eq(f.canonicalizePattern('DeepSeek V4 Pro (latest)', KW), 'deepseek/deepseek-v4-pro', 'Pro (latest) 不落 flash')
  eq(f.canonicalizePattern('Qwen 3.8 27B', KW), 'Qwen/Qwen3.8-27B', '27B 字母数字拆词（防回归：原型未映射）')
  eq(f.canonicalizePattern('Qwen 3.8 Max', KW), 'Qwen/Qwen3.8-Max', 'Max 不落 Max-0902（剩余词最少）')
  eq(f.canonicalizePattern('Qwen 3.8 Max 0902', KW), 'Qwen/Qwen3.8-Max-0902', 'Max 0902 精确')
  eq(f.canonicalizePattern('GLM-5.3 Flash', KW), 'z-ai/glm-5.3-flash', 'Flash 不落 FlashX')
  eq(f.canonicalizePattern('GLM-5.3 FlashX', KW), 'z-ai/glm-5.3-flashx', 'FlashX 精确')
  eq(f.canonicalizePattern('GLM-5.3', KW), 'zai-org/GLM-5.3', '不带后缀 → 基础版')
  eq(f.canonicalizePattern('MiMo V2.6 Pro', KW), 'xiaomi/mimo-v2.6-pro', 'Pro 不落 UltraSpeed')
  eq(f.canonicalizePattern('Tencent Hy3', KW), 'tencent/hy3-paid', '子序列匹配（剩 -paid）')
  eq(f.canonicalizePattern('Nemotron 3 Ultra', KW), 'nvidia/nemotron-3-ultra-550b-a55b', '长 ID 子序列匹配')
  eq(f.canonicalizePattern('Pixel Canary', KW), 'stealth/pixel-canary', 'stealth/ 前缀段匹配')
  eq(f.canonicalizePattern('Jev', KW), 'Jev', '不在 /models → 保留原样')
  eq(f.canonicalizePattern('Kimi K3', []), 'Kimi K3', '无关键词 → 原样（非 CC 源零影响）')
}

// ── 7. buildProbedEntries 接入规范化：显示名与 ID 形态收敛去重 ──
console.log('buildProbedEntries + keywords：')
{
  const f = makeFactory({})
  const KW = ['moonshotai/Kimi-K3', 'deepseek/deepseek-v4-flash']
  const entries = f.buildProbedEntries({ ...CC_SOURCE, providerId: undefined }, [
    { pattern: 'Kimi K3', input: 3, output: 15, currency: 'USD', monthlyCredits: 40 },
    { pattern: 'moonshotai/Kimi-K3', input: 3, output: 15, currency: 'USD', monthlyCredits: 40 },
    { pattern: 'DeepSeek V4 Flash (latest)', input: 0.15, output: 0.6, currency: 'USD' }
  ], KW)
  eq(entries.length, 2, '显示名与 ID 形态收敛为一条（3 → 2）')
  eq(entries[0].pattern, 'moonshotai/Kimi-K3', '保留首条且带规范 ID')
  eq(entries[1].pattern, 'deepseek/deepseek-v4-flash', '(latest) 剥后缀规范化')
  const raw2 = f.buildProbedEntries({ ...CC_SOURCE, providerId: undefined }, [
    { pattern: 'Kimi K3', input: 3, output: 15, currency: 'USD' }
  ])
  eq(raw2[0].pattern, 'Kimi K3', '不传 keywords → pattern 原样（旧行为不变）')
}

// ── 8. mergeCreditsIntoEntries：额度合并（请求数 + 月额度独立更新，不匹配忽略） ──
console.log('mergeCreditsIntoEntries：')
{
  const f = makeFactory({})
  const KW = ['gpt-5.6-sol', 'xiaomi/mimo-v2.6-pro']
  const entries = f.buildProbedEntries({ ...CC_SOURCE, providerId: undefined }, [
    { pattern: 'GPT-5.6 Sol', input: 5, output: 30, currency: 'USD', monthlyCredits: 70 },
    { pattern: 'MiMo V2.6 Pro', input: 0.435, output: 0.87, currency: 'USD' }
  ], KW)
  const touched = f.mergeCreditsIntoEntries(entries, [
    { pattern: 'GPT-5.6 Sol', fiveHour: 414, weekly: 1040, monthly: 2070 },
    { pattern: 'MiMo V2.6 Pro', fiveHour: '5,700', weekly: '14,200', monthlyCredits: '$20' },
    { pattern: '未知模型', fiveHour: 1, weekly: 2, monthly: 3 },
    { pattern: 'GPT-5.6 Sol', monthlyCredits: 70 }
  ], KW)
  eq(touched, 3, '3 条更新（未知模型忽略）')
  eq(entries[0].usageLimits, { fiveHour: 414, weekly: 1040, monthly: 2070 }, 'usageLimits 三窗口写入')
  eq(entries[0].monthlyCredits, 70, '已存 monthlyCredits 未被覆盖为其他值')
  eq(entries[1].usageLimits, { fiveHour: 5700, weekly: 14200 }, '带千分位逗号字符串解析')
  eq(entries[1].monthlyCredits, 20, '"$20" 解析并写入')
  f.mergeCreditsIntoEntries(entries, [{ pattern: 'MiMo V2.6 Pro', monthly: 999 }], KW)
  eq(entries[1].usageLimits, { fiveHour: 5700, weekly: 14200, monthly: 999 }, '二次合并补 monthly、已有窗口保留')
  const t2 = f.mergeCreditsIntoEntries(entries, [{ pattern: 'GPT-5.6 Sol', fiveHour: -5, weekly: 'Free' }], KW)
  eq(t2, 0, '负值 / "Free" → 不更新')
  eq(entries[0].usageLimits.monthly, 2070, '已有值不受无效更新影响')
}

// ── 9. 额度区块定位与 prompt（锚句切片 / 无锚降级 / 指列规则） ──
console.log('额度区块：')
{
  const f = makeFactory({})
  const reqBlock = ' How far each window goes depends on the model. Estimated request counts per limit window : Model Requests / 5 hours Requests / week Requests / month GPT-5.6 Sol 414 1,040 2,070 Kimi K3 78 196 390'
  const mcBlock = ' Model Input Output Cache Read Cache Write Monthly credits GPT-5.6 Sol $5.00 $30.00 $0.50 $6.25 $70 Kimi K3 $3.00 $15.00 $0.30 $3.75 $40'
  const fullText = 'Z'.repeat(300) + reqBlock + 'Y'.repeat(80) + mcBlock + 'END'
  const frag = f.locateCreditsFragment(fullText)
  ok(!!frag && frag.includes('Requests / 5 hours') && frag.includes('GPT-5.6 Sol 414'), '片段含请求数表')
  ok(!!frag && frag.includes('Monthly credits') && frag.includes('$70'), '片段含月额度表')
  eq(f.locateCreditsFragment('无锚文本'.repeat(50)), undefined, '无锚 → undefined（跳过额度提取）')
  const p = f.buildCreditsPrompt('TEXT', 'Monthly credits')
  ok(p.includes('"fiveHour"') && p.includes('"weekly"') && p.includes('"monthly"') && p.includes('"monthlyCredits"'), 'prompt 含四个输出字段')
  ok(p.includes('只取列标题为「Monthly credits」'), 'prompt 含指列规则')
  ok(!f.buildCreditsPrompt('TEXT').includes('只取列标题为'), '无列提示 → 不含指列规则')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
