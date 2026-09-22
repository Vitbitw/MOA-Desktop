// 纯 Node 测试：src/shared/providerAccess.ts（回环免 Key 判定口径）
// 覆盖：回环命中（localhost 大小写 / 127 简写与全段 / [::1]）+ 非回环拒绝（域名伪装 127.attacker.com、
//      局域网、云端、非法 URL、空串）+ hasProviderAccess 组合矩阵
// 口径：仅回环（localhost / 127.0.0.0/8 / ::1）免 Key；局域网等其它「本地」仍需 Key
// 用法：node test-e2e/provider-access.cjs
// 加载方式：esbuild transform TS → CJS 后实例化（模块零依赖，无需 stub require）
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

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'providerAccess.ts'), 'utf8')
const { code } = esbuild.transformSync(src, { loader: 'ts', format: 'cjs' })
const mod = { exports: {} }
new Function('exports', 'module', 'require', code)(mod.exports, mod, require)
const { isLocalBaseUrl, hasProviderAccess } = mod.exports

/** 组装 { baseUrl, apiKey } —— 形参形态避免写敏感字段字面量行（工程写入掩码约束） */
function prov(baseUrl, apiKey) {
  return { baseUrl, apiKey }
}

console.log('isLocalBaseUrl —— 回环命中：')
ok(isLocalBaseUrl('http://localhost:11434/v1') === true, 'localhost → 回环')
ok(isLocalBaseUrl('http://LOCALHOST:11434/v1') === true, 'LOCALHOST 大小写 → 回环')
ok(isLocalBaseUrl('http://127.0.0.1:1234/v1') === true, '127.0.0.1 → 回环')
ok(isLocalBaseUrl('http://127.1:1234/v1') === true, '127.1 简写规范化 → 回环')
ok(isLocalBaseUrl('http://127.42.0.7:8080/v1') === true, '127.42.0.7（127/8 内）→ 回环')
ok(isLocalBaseUrl('http://[::1]:1337/v1') === true, '[::1] → 回环')
ok(isLocalBaseUrl('https://localhost/v1') === true, 'https + 默认端口 → 回环')

console.log('isLocalBaseUrl —— 非回环必须拒绝（F1 回归锚）：')
ok(isLocalBaseUrl('http://127.attacker.com/v1') === false, '127.attacker.com 域名 → 拒绝（F1）')
ok(isLocalBaseUrl('http://127.0.0.1.attacker.com/v1') === false, '127.0.0.1.attacker.com → 拒绝')
ok(isLocalBaseUrl('https://api.openai.com/v1') === false, '云端域名 → 拒绝')
ok(isLocalBaseUrl('http://192.168.1.5:11434/v1') === false, '局域网 IP → 拒绝（仅回环免 Key）')
ok(isLocalBaseUrl('http://127.300.1.1/v1') === false, '非法 IPv4（URL 解析失败）→ false')
ok(isLocalBaseUrl('') === false, '空串 → false')
ok(isLocalBaseUrl('not-a-url') === false, '非 URL → false')

console.log('hasProviderAccess 组合矩阵：')
ok(hasProviderAccess(prov('https://api.openai.com/v1', 'sk-test')) === true, '云端 + Key → 可用')
ok(hasProviderAccess(prov('https://api.openai.com/v1', '')) === false, '云端无 Key → 不可用')
ok(hasProviderAccess(prov('http://localhost:11434/v1', '')) === true, '回环无 Key → 可用（免 Key）')
ok(hasProviderAccess(prov('http://127.0.0.1:1234/v1', 'anything')) === true, '回环 + Key → 可用')
ok(hasProviderAccess(prov('http://192.168.1.5:11434/v1', '')) === false, '局域网无 Key → 不可用')

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
