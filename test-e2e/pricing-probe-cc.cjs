// 行为测试：定价探查「每模型 Monthly credits」— 严格解析 / 套餐→计划页 URL 动态解析 / prompt 字段
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
  pfn('toFiniteNum'),
  pfn('toMonthlyCredits'),
  pfn('parseDays'),
  pfn('normalizeWindow'),
  pfn('buildProbedEntries'),
  pfn('resolveSourceProviderId'),
  pfn('resolveProbeUrl'),
  pfn('buildProbePrompt'),
  pfn('buildFillPrompt'),
  grab(ccSrc, 'CC_PLAN_PAGE_SLUG', /const CC_PLAN_PAGE_SLUG[\s\S]*?\n}/)
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
      '\n; return { toMonthlyCredits, buildProbedEntries, resolveProbeUrl, buildProbePrompt, buildFillPrompt, CC_PLAN_PAGE_SLUG }'
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
  eq(f.toMonthlyCredits(-1), undefined, '负数 → undefined')
  eq(f.toMonthlyCredits(''), undefined, '空串 → undefined')
  eq(f.toMonthlyCredits(null), undefined, 'null → undefined')
  eq(f.toMonthlyCredits(NaN), undefined, 'NaN → undefined')
}

// ── 2. buildProbedEntries 写入 monthlyCredits ──
console.log('buildProbedEntries：')
{
  const f = makeFactory({})
  const src = { ...CC_SOURCE, timezone: 'Asia/Shanghai' }
  const entries = f.buildProbedEntries(src, [
    { pattern: 'deepseek-v4-flash', input: 0.15, output: 0.6, currency: 'USD', monthlyCredits: 60 },
    { pattern: 'glm-5.2', input: 1.4, output: 4.4, currency: 'USD', monthlyCredits: '$70' },
    { pattern: 'promo-model', input: 1, output: 2, currency: 'USD', monthlyCredits: '~~$30~~ $67 through Sep 24th' },
    { pattern: 'cn-model', input: 72, output: 144, currency: 'CNY', monthlyCredits: 72 },
    { pattern: 'no-mc-model', input: 1, output: 2, currency: 'USD' }
  ])
  eq(entries.length, 5, '非法月额度不丢条目')
  eq(entries[0].monthlyCredits, 60, 'USD 数值直存')
  eq(entries[1].monthlyCredits, 70, '"$70" 字符串解析')
  eq(entries[2].monthlyCredits, undefined, '促销串丢字段、条目保留')
  ok(entries[2].pattern === 'promo-model' && entries[2].input === 1, '促销条目其余字段完好')
  eq(entries[3].monthlyCredits, 10, 'CNY 按 7.2 折算（72 → 10）')
  eq(entries[4].monthlyCredits, undefined, '页面无该列 → 字段缺省')
  eq(entries[0].sourceUrl, src.url, 'sourceUrl 记录实际探查页')
}

// ── 3. resolveProbeUrl：按订阅套餐动态选计划页 ──
console.log('resolveProbeUrl：')
{
  const mk = (planId, providers) =>
    makeFactory({
      getAllProviders: () => providers || [CC_PROVIDER],
      readAppSettings: () => ({ monitoring: { sources: MON_SOURCES } }),
      getUsageSnapshot: () => (planId === undefined ? null : { subscription: planId ? { planId } : {} })
    })

  eq(mk('individual-goat').resolveProbeUrl(CC_SOURCE), 'https://commandcode.ai/docs/plans/goat', 'individual-goat → goat 计划页')
  eq(mk('individual-go').resolveProbeUrl(CC_SOURCE), 'https://commandcode.ai/docs/plans/go', 'individual-go → go 计划页')
  eq(mk('individual-pro-v1').resolveProbeUrl(CC_SOURCE), 'https://commandcode.ai/docs/plans/pro', 'individual-pro-v1 → pro 计划页')
  eq(mk('individual-ultra').resolveProbeUrl(CC_SOURCE), 'https://commandcode.ai/docs/plans/max', 'individual-ultra → max 计划页')
  eq(mk('teams-pro').resolveProbeUrl(CC_SOURCE), FALLBACK, 'teams-pro 无公开计划页 → 回退')
  eq(mk('individual-provider').resolveProbeUrl(CC_SOURCE), FALLBACK, 'individual-provider（PAYG）→ 回退')
  eq(mk('brand-new-plan').resolveProbeUrl(CC_SOURCE), FALLBACK, '未知 planId → 回退')
  eq(mk(undefined).resolveProbeUrl(CC_SOURCE), FALLBACK, '无监控快照 → 回退')
  eq(mk('').resolveProbeUrl(CC_SOURCE), FALLBACK, '有快照无订阅 → 回退')

  // 非 Command Code 原商：即使有快照也原样返回（零影响）
  const deepseekProvider = [{ id: 'ds', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', enabled: true, apiKey: 'k' }]
  eq(
    mk('individual-goat', deepseekProvider).resolveProbeUrl({ id: 'deepseek', name: 'DeepSeek', url: 'https://api-docs.deepseek.com/x', enabled: true }),
    'https://api-docs.deepseek.com/x',
    '非 commandcode 源原样返回'
  )

  // 无 providerId：按名称回退匹配（预置源形态）
  eq(
    mk('individual-goat').resolveProbeUrl({ id: 'auto:cc', name: 'Command Code', url: FALLBACK, enabled: true }),
    'https://commandcode.ai/docs/plans/goat',
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
  const fill = f.buildFillPrompt('TEXT', ['m1'])
  ok(fill.includes('monthlyCredits'), '补漏 prompt 输出结构含 monthlyCredits')
}

// ── 5. 套餐 → 计划页映射表 ──
console.log('CC_PLAN_PAGE_SLUG：')
{
  const f = makeFactory({})
  eq(
    f.CC_PLAN_PAGE_SLUG,
    {
      'individual-go': 'go',
      'individual-goat': 'goat',
      'individual-pro': 'pro',
      'individual-pro-v1': 'pro',
      'individual-max': 'max',
      'individual-ultra': 'max'
    },
    '六条映射与设计一致'
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
