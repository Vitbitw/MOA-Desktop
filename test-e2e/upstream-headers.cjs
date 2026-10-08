// 纯 Node 测试：src/main/providers/upstreamHeaders.ts（上游请求头统一构建）
// 覆盖：isOpencodeUpstream 域名矩阵（命中 / 子域 / 大小写 / 端口路径 / 伪装域拒绝 / 非法 URL）
//       + buildUpstreamHeaders（非 opencode 域不附加自定义头 / opencode 域补头与兜底 UUID / Key 与 session 相互独立）
//       + newUpstreamSessionId 形态与一次性语义
// 口径：x-opencode-session 仅发往 opencode.ai 及其子域；sessionId 缺省/空串一律兜底随机 UUID（缺失头 opencode 直接 400）
// 用法：node test-e2e/upstream-headers.cjs
// 加载方式：esbuild transform TS → CJS 后实例化（依赖仅 node:crypto，CJS require 直通）
// 返回码：全部通过 0，有失败 1
const fs = require('fs')
const path = require('path')
const esbuild = require('esbuild')

let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) {
    pass++
    console.log('  \u2713 ' + label)
  } else {
    fail++
    console.log('  \u2717 ' + label + (extra !== undefined ? ' \u2192 ' + JSON.stringify(extra) : ''))
  }
}

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'providers', 'upstreamHeaders.ts'), 'utf8')
const { code } = esbuild.transformSync(src, { loader: 'ts', format: 'cjs' })
const mod = { exports: {} }
new Function('exports', 'module', 'require', code)(mod.exports, mod, require)
const { isOpencodeUpstream, buildUpstreamHeaders, newUpstreamSessionId } = mod.exports

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

console.log('isOpencodeUpstream —— 命中：')
ok(isOpencodeUpstream('https://opencode.ai') === true, '裸域名 → true')
ok(isOpencodeUpstream('https://opencode.ai/zen/go/v1') === true, '域名 + 路径 → true')
ok(isOpencodeUpstream('https://api.opencode.ai/v1') === true, '子域 → true')
ok(isOpencodeUpstream('https://OPENCODE.AI/zen/v1') === true, '大小写混写 → true')
ok(isOpencodeUpstream('https://opencode.ai:8443/zen/v1') === true, '带端口 → true')

console.log('isOpencodeUpstream —— 伪装域必须拒绝（F1 回归锚）：')
ok(isOpencodeUpstream('https://opencode.ai.attacker.com/v1') === false, 'opencode.ai.attacker.com → 拒绝')
ok(isOpencodeUpstream('https://attackeropencode.ai/v1') === false, 'attackeropencode.ai → 拒绝')
ok(isOpencodeUpstream('https://myopencode.ai/v1') === false, 'myopencode.ai（仅前缀相似）→ 拒绝')
ok(isOpencodeUpstream('https://api.deepseek.com/v1') === false, '非 opencode 域名 → 拒绝')
ok(isOpencodeUpstream('') === false, '空串 → false')
ok(isOpencodeUpstream('not-a-url') === false, '非 URL → false')

console.log('buildUpstreamHeaders —— 域名门控（不向无关上游发自定义头）：')
const other = buildUpstreamHeaders('https://api.deepseek.com/v1', 'test-key', 'sess-1')
ok(other['Content-Type'] === 'application/json', '非 opencode：Content-Type 恒有')
ok(other.Authorization === 'Bearer test-key', '非 opencode：带 Key → Bearer')
ok(other['x-opencode-session'] === undefined, '非 opencode：不带 x-opencode-session（会话值不外发）')
const otherNoKey = buildUpstreamHeaders('https://api.deepseek.com/v1', '')
ok(otherNoKey.Authorization === undefined, '非 opencode：空 Key → 无 Authorization')

console.log('buildUpstreamHeaders —— opencode 域：')
const oc = buildUpstreamHeaders('https://opencode.ai/zen/go/v1', 'test-key', 'sess-1')
ok(oc['x-opencode-session'] === 'sess-1', '显式 sessionId → 原样携带')
ok(oc.Authorization === 'Bearer test-key', 'opencode + Key → Bearer 与 session 头并存')
const ocNoKey = buildUpstreamHeaders('https://opencode.ai/zen/go/v1', '', 'sess-2')
ok(ocNoKey.Authorization === undefined, '空 Key → 无 Authorization')
ok(ocNoKey['x-opencode-session'] === 'sess-2', '无 Key 不影响 session 头')
const ocNoSess = buildUpstreamHeaders('https://opencode.ai/zen/go/v1', 'test-key')
ok(UUID_RE.test(ocNoSess['x-opencode-session'] || ''), '缺省 sessionId → 兜底 UUID（保证不 400）')
const ocEmptySess = buildUpstreamHeaders('https://opencode.ai/zen/go/v1', 'test-key', '')
ok(UUID_RE.test(ocEmptySess['x-opencode-session'] || ''), '空串 sessionId → 兜底 UUID')
const ocSub = buildUpstreamHeaders('https://api.opencode.ai/v1', 'test-key', 'sess-3')
ok(ocSub['x-opencode-session'] === 'sess-3', '子域同样附加（透传值）')
const autoA = buildUpstreamHeaders('https://opencode.ai/v1', 'test-key')
const autoB = buildUpstreamHeaders('https://opencode.ai/v1', 'test-key')
ok(autoA['x-opencode-session'] !== autoB['x-opencode-session'], '无会话上下文的两轮独立构建 → 一次性 UUID 互不相同')

console.log('newUpstreamSessionId：')
ok(UUID_RE.test(newUpstreamSessionId()), '返回 UUID 形态')
ok(newUpstreamSessionId() !== newUpstreamSessionId(), '两轮调用互不相同')

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
