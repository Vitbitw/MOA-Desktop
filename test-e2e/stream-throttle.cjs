// 行为测试：src/main/moa/streamThrottle.ts（节流推送器：合并覆盖 / 定时波次 / 终态 / dispose）
// 用法：node test-e2e/stream-throttle.cjs [path-to-streamThrottle.ts]
// 加载方式：esbuild 把 TS 现场转成 CJS 后执行（同 monitor-behavior.cjs 思路）
// 返回码：全部通过 0，有失败 1（含"dispose 后无残留 timer"的自然退出检查）
const fs = require('fs')
const path = require('path')

const file = process.argv[2] || path.resolve(__dirname, '../src/main/moa/streamThrottle.ts')

function loadTsModule(tsFile) {
  const src = fs.readFileSync(tsFile, 'utf8')
  let esbuild
  try {
    esbuild = require('esbuild')
  } catch {
    throw new Error('缺少 esbuild（随 vite 安装）：请在项目根目录执行 npm i 后再跑本脚本')
  }
  const js = esbuild.transformSync(src, { loader: 'ts', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  new Function('exports', 'module', 'require', js)(mod.exports, mod, require)
  return mod.exports
}

const { createThrottledEmitter, STREAM_PUSH_INTERVAL_MS } = loadTsModule(file)

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 带记录的 emitter：values = 每次 emit 的值，times = emit 时刻 */
function recorder(intervalMs) {
  const values = []
  const times = []
  const e = createThrottledEmitter(intervalMs, (v) => {
    values.push(v)
    times.push(Date.now())
  })
  return { e, values, times }
}

;(async () => {
  console.log('\n[1] STREAM_PUSH_INTERVAL_MS 常量')
  eq(STREAM_PUSH_INTERVAL_MS, 50, '默认推送间隔 = 50ms')

  console.log('\n[2] 窗口内多次 push 只保留最新值，到点发一次（合并覆盖）')
  {
    const r = recorder(40)
    r.e.push('a')
    r.e.push('ab')
    r.e.push('abc')
    await sleep(180)
    eq(r.values, ['abc'], '窗口到点只发一次，且是最后 push 的值')
    await sleep(120)
    eq(r.values, ['abc'], '无新 push → 计时器停止，不空转重复发送')
    r.e.dispose()
  }

  console.log('\n[3] 窗口未到不发（长 interval 下不抢跑）')
  {
    const r = recorder(10000) // 长间隔：正确实现下 dispose 会取消它（见文末自然退出检查）
    r.e.push('pending')
    await sleep(40)
    eq(r.values, [], 'interval 远未到 → 一个都不发')
    r.e.dispose()
    await sleep(20)
    eq(r.values, [], 'dispose 取消未到点的窗口')
  }

  console.log('\n[4] 真实计时器：窗口到点自动发（interval 30ms）')
  {
    const r = recorder(30)
    const t0 = Date.now()
    r.e.push('x')
    await sleep(220)
    ok(r.times.length === 1, '单次 push 只触发一次（实际 ' + r.times.length + ' 次）')
    const dt = r.times.length > 0 ? r.times[0] - t0 : -1
    ok(dt >= 10 && dt <= 200, '推送延迟 ≈ interval（实测 ' + dt + 'ms，interval=30ms）')
    r.e.push('y')
    await sleep(220)
    eq(r.values, ['x', 'y'], '静默后再 push 重新起一轮（每窗口一次）')
    r.e.dispose()
  }

  console.log('\n[5] 持续 push：每窗口一波连续发送')
  {
    const interval = 40
    const r = recorder(interval)
    let n = 0
    const iv = setInterval(() => r.e.push('v' + ++n), 5)
    await sleep(300)
    clearInterval(iv)
    const waves = r.values.length
    ok(n > 10, 'push 次数足够密（实际 ' + n + ' 次）')
    ok(waves >= 3 && waves <= 15, '300ms / interval=40ms 内多窗口连续发送（实际 ' + waves + ' 波）')
    const seq = r.values.map((v) => Number(v.slice(1)))
    ok(
      seq.every((v, i) => i === 0 || v > seq[i - 1]),
      '每波都是各自窗口内的最新值（递增：' + seq.join(',') + '）'
    )
    ok(waves < n, '合并生效：波数（' + waves + '）远小于 push 次数（' + n + '）')
    r.e.flush('end')
    eq(r.values[r.values.length - 1], 'end', 'flush(终值) 收尾')
    r.e.dispose()
  }

  console.log('\n[6] flush(value)：立即发出、丢弃 pending、取消计时器')
  {
    const r = recorder(40)
    r.e.push('old-1')
    r.e.push('old-2')
    r.e.flush('final')
    eq(r.values, ['final'], 'flush(v) 同步立即发出 v（不需要等窗口）')
    await sleep(180)
    eq(r.values, ['final'], 'flush 后旧 pending 不补发（计时器已取消）')
    r.e.dispose()
  }

  console.log('\n[7] flush()：有 pending 立即发；无 pending 无操作')
  {
    const r = recorder(40)
    r.e.flush()
    await sleep(30)
    eq(r.values, [], '无 pending 的 flush() 不触发 emit')
    r.e.push('p')
    await sleep(10)
    r.e.flush()
    eq(r.values, ['p'], 'flush() 立即发出 pending（不等窗口）')
    await sleep(180)
    eq(r.values, ['p'], 'flush() 后不重复发送')
    r.e.dispose()
  }

  console.log('\n[8] 终态序列：push a; push b; flush(c) → 只收到 [c]')
  {
    const r = recorder(40)
    r.e.push('a')
    r.e.push('b')
    r.e.flush('c')
    eq(r.values, ['c'], '同步只收到终态值 c，a/b 一个都没出去')
    await sleep(180)
    eq(r.values, ['c'], '越过窗口后也不补发 a/b（不得把 UI 打回旧文本）')
    r.e.dispose()

    // 已发出的中间值保留，pending 被终态替换
    const r2 = recorder(30)
    r2.e.push('a')
    await sleep(120)
    eq(r2.values, ['a'], '窗口到点发过一次中间值')
    r2.e.push('ab')
    r2.e.flush('done')
    eq(r2.values, ['a', 'done'], '已发出的保留，未出去的 pending 被终态替换')
    await sleep(150)
    eq(r2.values, ['a', 'done'], '终态之后无补发')
    r2.e.dispose()
  }

  console.log('\n[9] dispose()：取消计时器、清 pending，此后 push/flush 无操作')
  {
    const r = recorder(3000) // 若 dispose 漏取消，脚本退出会被拖到 ≥3s（见文末自然退出检查）
    r.e.push('zombie')
    r.e.dispose()
    r.e.push('after-dispose')
    r.e.flush('late-flush')
    r.e.flush()
    await sleep(60)
    eq(r.values, [], 'dispose 后 push/flush 均不再触发 emit')
    r.e.dispose()
  }

  // 自然退出检查：所有 emitter 已 dispose，进程应立即退出；
  // 若 dispose 漏清 timer（[3] 的 10000ms / [9] 的 3000ms），尾部耗时会远超阈值 → 记为失败
  const doneAt = Date.now()
  process.on('exit', () => {
    const tail = Date.now() - doneAt
    if (tail < 1500) {
      pass++
      console.log('  ✓ dispose 后无残留 timer，脚本自然退出（尾部 ' + tail + 'ms）')
    } else {
      fail++
      console.log('  ✗ dispose 后存在残留 timer：脚本延迟 ' + tail + 'ms 才退出')
    }
    console.log('\n──────────────────────────────')
    console.log(`通过 ${pass} / 失败 ${fail}`)
    if (fail > 0) process.exitCode = 1
  })
  process.exitCode = fail === 0 ? 0 : 1
  // 兜底看门狗：被残留 timer 拖过 4s 仍未退出则明确报错（unref 不阻塞正常退出）
  setTimeout(() => {
    console.log('  ✗ 残留 timer 阻塞退出（>4s）')
    console.log('\n──────────────────────────────')
    console.log(`通过 ${pass} / 失败 ${fail}`)
    process.exit(1)
  }, 4000).unref()
})()
