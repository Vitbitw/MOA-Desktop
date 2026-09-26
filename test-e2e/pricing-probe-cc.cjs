// 行为测试：定价探查「每模型 Monthly credits」— 严格解析 / 套餐→探查目标（URL+额度列）/ prompt 指列 / 边界去重
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
  pfn('toFiniteNum'),
  pfn('toMonthlyCredits'),
  pfn('parseDays'),
  pfn('normalizeWindow'),
  pfn('buildProbedEntries'),
  pfn('resolveSourceProviderId'),
  pfn('resolveProbeTarget'),
  pfn('buildProbePrompt'),
  pfn('buildFillPrompt'),
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
      '\n; return { toMonthlyCredits, buildProbedEntries, resolveProbeTarget, buildProbePrompt, buildFillPrompt, CC_PLAN_PAGE }'
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

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
