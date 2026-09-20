#!/usr/bin/env node
// 端到端（真实应用）回归：MoA 协作架构「切换即改即存」—— 渲染端点击 → 主进程落库 → 重启保持
//
// 背景：架构切换按钮曾只改渲染端本地 state，需用户再点「保存配置」才落库；用户走
//       「切架构 → AI 生成专家团（生成即写库，toast 提示已保存）」路径时架构从未落库，重启回退默认选举。
// 本测试用真实 Electron 应用（隔离 userData，全程不触碰用户数据）执行断言：
//   ① 打开设置 → 点「🪑 主席团模式」（不点「保存配置」）→ 主进程配置已是 committee（即改即存）
//   ② 重启应用 → 仍是 committee；设置面板 UI 同步（按钮高亮 + 「AI 生成专家团」面板出现）
//   ③ 点「🗳️ 选举模式」→ 立即回到 election
//   ④ 重启应用 → 仍是 election，UI 高亮选举
//   ⑤ 直接经 IPC 保存 subModels（模拟「AI 生成专家团」写入链路）→ architecture 保持 committee 不被清掉
//
// 用法：npm run test:arch-persist
// 依赖：out/ 构建产物（先 npm run build）；需要图形会话（会短暂打开应用窗口，端口冲突时网关自动顺延）
// 环境变量：MOA_ARCH_E2E_KEEP=1 保留临时 userData 目录（排障用）
// 返回码：全部通过 0，有失败 1
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawnSync } = require('child_process')

const APP_ROOT = path.join(__dirname, '..')
const MAIN_OUT = path.join(APP_ROOT, 'out', 'main', 'index.js')

const phaseIdx = process.argv.indexOf('--phase')
if (phaseIdx >= 0) {
  // ── 阶段模式：由 Electron 运行（真实主进程 + 真实渲染进程 + 真实 DB）──
  runPhase(process.argv[phaseIdx + 1], process.argv[phaseIdx + 2], process.argv[phaseIdx + 3])
} else {
  runParent()
}

// ════════════════════ 阶段模式 ════════════════════

function runPhase(scenario, ud, resultFile) {
  const { app, BrowserWindow } = require('electron')
  app.setPath('userData', ud)
  require(MAIN_OUT)

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // 非 dev 启动：main 会先 loadURL('http://localhost:5173') 失败 → 回退本地构建产物
  app.on('browser-window-created', (_e, win) => {
    win.webContents.on('did-fail-load', (_ev, _code, _desc, _url) => {
      win.loadFile(path.join(APP_ROOT, 'out', 'renderer', 'index.html'))
    })
  })

  const write = (obj) => {
    try { fs.writeFileSync(resultFile, JSON.stringify(obj, null, 2)) } catch { /* 结果文件写入失败由父进程报告 */ }
  }

  app.whenReady().then(async () => {
    const out = { scenario, steps: [] }
    try {
      let win = null
      for (let i = 0; i < 200 && !win; i++) { win = BrowserWindow.getAllWindows()[0]; if (!win) await sleep(100) }
      if (!win) throw new Error('未创建窗口')
      let ready = false
      for (let i = 0; i < 300 && !ready; i++) {
        try { ready = await win.webContents.executeJavaScript('!!(window.moaAPI && document.readyState === "complete")') } catch { /* 未就绪 */ }
        if (!ready) await sleep(100)
      }
      if (!ready) throw new Error('渲染进程未就绪（window.moaAPI 不可用）')

      const evalJs = (expr) => win.webContents.executeJavaScript(expr)
      const readCfg = async () => {
        const res = await evalJs('window.moaAPI.getMoaConfig()')
        return res && typeof res === 'object' && 'success' in res ? res.data : res
      }
      const clickByText = (text) => `(() => {
        const btns = [...document.querySelectorAll('button')]
        const b = btns.find((x) => (x.textContent || '').includes(${JSON.stringify(text)}))
        if (!b) return { clicked: false, available: btns.map((x) => (x.textContent || '').trim()).filter(Boolean).slice(0, 60) }
        b.click()
        return { clicked: true }
      })()`

      // 设置面板 UI 信号（committee 专属元素：「AI 生成专家团」折叠标题）；面板未打开时 visible=false
      const uiSignals = `(() => {
        const text = document.body.innerText || ''
        const btns = [...document.querySelectorAll('button')]
        const active = (label) => {
          const el = btns.find((b) => (b.textContent || '').includes(label))
          return el ? el.className.includes('bg-background') && el.className.includes('shadow-sm') : null
        }
        return {
          settingsOpen: text.includes('协作架构'),
          electionActive: active('选举模式'),
          committeeActive: active('主席团模式'),
          expertPanel: text.includes('AI 生成专家团')
        }
      })()`

      const boot = await readCfg()
      out.steps.push({ tag: 'boot', architecture: boot && boot.architecture })

      if (scenario === 'toggle-committee' || scenario === 'toggle-election') {
        win.webContents.send('menu:openSettings')
        await sleep(1200)
        const label = scenario === 'toggle-committee' ? '主席团模式' : '选举模式'
        out.steps.push({ tag: 'click', res: await evalJs(clickByText(label)) })
        await sleep(700)
        out.steps.push({ tag: 'after-click', config: await readCfg(), ui: await evalJs(uiSignals) })
      }

      if (scenario === 'inspect') {
        win.webContents.send('menu:openSettings')
        await sleep(1200)
        out.steps.push({ tag: 'boot-config', config: await readCfg(), ui: await evalJs(uiSignals) })
      }

      if (scenario === 'submodels-save') {
        // 模拟 ExpertTeamSection 的写入链路：只带 subModels（不带 architecture）
        const res = await evalJs(`window.moaAPI.setMoaConfig({ subModels: [
          { id: 'e2e-seat-1', providerId: 'e2e-p', modelId: 'e2e-m1', order: 0, expertName: '端到端专家一' },
          { id: 'e2e-seat-2', providerId: 'e2e-p', modelId: 'e2e-m2', order: 1, expertName: '端到端专家二' }
        ] })`)
        out.steps.push({ tag: 'set-submodels', res: res && res.success === true })
        await sleep(400)
        out.steps.push({ tag: 'after-submodels-save', config: await readCfg() })
      }

      write(out)
    } catch (err) {
      out.error = String((err && err.stack) || err)
      write(out)
    }
    await sleep(1500) // 等 DB debounce 落盘 + before-quit flush
    app.quit()
  })
}

// ════════════════════ 父进程模式 ════════════════════

function runParent() {
  if (!fs.existsSync(MAIN_OUT)) {
    console.error(`缺少构建产物 ${MAIN_OUT}：先运行 npm run build`)
    process.exit(1)
  }
  let electronPath = null
  try { electronPath = require('electron') } catch { /* 未安装 */ }
  if (typeof electronPath !== 'string') {
    console.error('无法定位 electron 可执行文件（请先 npm install electron）')
    process.exit(1)
  }

  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'moa-arch-e2e-'))
  console.log(`[arch-persist] 隔离 userData: ${ud}\n`)

  let pass = 0
  let fail = 0
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✓ ${name}`) }
    else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
  }

  /** 启动一次真实应用执行阶段，返回其写入的结果 JSON */
  const phase = (scenario) => {
    const resultFile = path.join(ud, `result-${scenario}.json`)
    try { fs.unlinkSync(resultFile) } catch { /* 首次运行无文件 */ }
    const proc = spawnSync(electronPath, [__filename, '--phase', scenario, ud, resultFile], {
      stdio: 'inherit',
      timeout: 180_000,
      windowsHide: true
    })
    try {
      return JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    } catch {
      return { error: `未生成结果文件（exit=${proc.status} signal=${proc.signal ?? '无'}）` }
    }
  }

  const arch = (res) => {
    const last = res && Array.isArray(res.steps) ? res.steps[res.steps.length - 1] : null
    const cfg = last && (last.config || last)
    return cfg && cfg.architecture
  }

  console.log('[1] 打开设置 → 点「主席团模式」（不点保存配置）→ 期望立即落库')
  const t1 = phase('toggle-committee')
  check('点击后主进程配置 architecture=committee（即改即存）', arch(t1) === 'committee', `实际 ${JSON.stringify(arch(t1))} steps=${JSON.stringify(t1.steps)}`)
  check('UI 同步：主席团高亮 + 「AI 生成专家团」面板出现', !!(t1.steps && t1.steps[t1.steps.length - 1]?.ui?.committeeActive && t1.steps[t1.steps.length - 1]?.ui?.expertPanel), JSON.stringify(t1.steps?.[t1.steps.length - 1]?.ui))

  console.log('\n[2] 重启应用 → 期望保持主席团')
  const t2 = phase('inspect')
  check('重启后 architecture=committee', arch(t2) === 'committee', `实际 ${JSON.stringify(arch(t2))}`)
  check('重启后 UI 高亮主席团', !!(t2.steps && t2.steps.find((s) => s.ui)?.ui?.committeeActive), JSON.stringify(t2.steps))

  console.log('\n[3] 点「选举模式」→ 期望立即落库')
  const t3 = phase('toggle-election')
  check('点击后 architecture=election', arch(t3) === 'election', `实际 ${JSON.stringify(arch(t3))}`)

  console.log('\n[4] 重启应用 → 期望保持选举')
  const t4 = phase('inspect')
  check('重启后 architecture=election 且 UI 高亮选举', arch(t4) === 'election' && !!(t4.steps && t4.steps.find((s) => s.ui)?.ui?.electionActive), `arch=${JSON.stringify(arch(t4))}`)

  console.log('\n[5] 保存 subModels（模拟「AI 生成专家团」写入链路）→ 期望 architecture 不被清掉')
  const t5 = phase('submodels-save')
  check('subModels 保存后 architecture 保持 election', arch(t5) === 'election', `实际 ${JSON.stringify(arch(t5))}`)

  console.log('\n──────────────────────────────')
  console.log(`通过 ${pass} / 失败 ${fail}`)
  if (process.env.MOA_ARCH_E2E_KEEP === '1') {
    console.log(`[arch-persist] 保留现场：${ud}`)
  } else {
    try { fs.rmSync(ud, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
  }
  process.exit(fail === 0 ? 0 : 1)
}
