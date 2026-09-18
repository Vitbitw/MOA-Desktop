import crypto from 'node:crypto'
import { app, BrowserWindow, ipcMain, Menu, clipboard } from 'electron'
import path from 'path'
import { getDatabase } from './db/database'
import { readAppSettings, updateRawAppSettings } from './config/appSettings'
import { handleIpc, handleIpcRaw } from './ipc/handle'
import { IPC, IPC_EVENT } from '../shared/ipc-channels'
import type { AppSettings, SubOutputUpdate, AggregationChunk, UsageSummary, UsageRange, UsageGroupBy, UsageToday, UsageRow, PricingProbeSource, ProbeProgressEvent, ToastData } from '../shared/types'
import { DEFAULT_HOST, DEFAULT_PORT } from '../shared/defaults'
import { applyGatewayServer, stopGatewayServer } from './gateway/server'
import { initUiBridge } from './uiBridge'
import { getAllProviders, addProvider, removeProvider, fetchAndCacheModels, seedBuiltInProviders } from './providers/providerManager'
import { getMoaConfig, setMoaConfig, loadMoaConfigFromDb } from './moa/moaConfig'
import { executeMoA, executeMoAWithEvents } from './moa/moaEngine'
import type { MoaResponse } from './moa/moaEngine'
import { createThrottledEmitter, STREAM_PUSH_INTERVAL_MS } from './moa/streamThrottle'
import type { ThrottledEmitter } from './moa/streamThrottle'
import { generateTitle } from './title/titleGenerator'
import { buildUsageEntries, sumUsage } from './moa/usage'
import { createUsageWindow, destroyUsageWindow, setOpenUsageHandler, syncUsageWindow } from './usage/usageWindow'
import { invalidateProxyCache } from './local/fetchProxy'
import { loginToCommandCode, logoutCommandCode, getMonitorStatus, refreshCommandCodeUsage, usageApiKeyKey } from './monitoring/commandCode'
import { loginToMimo, refreshMimoUsage } from './monitoring/mimo'
import { loginToDeepSeek, logoutDeepSeek, getDeepSeekStatus, refreshDeepSeekUsage } from './monitoring/deepseek'
import { getCumulativeUsage, clearCumulativeUsage } from './monitoring/usageAccumulator'
import { startUsageCollector, stopUsageCollector, getCollectorStatus, markUsageCollected } from './monitoring/collector'
import { resolveProbeModel, probeSources, getPricingProbeConfig, sourceHasConfiguredKey } from './pricing/probe'
import { saveUsageCredential } from './store/key-store'
import type { RemoteUsageSource } from '../shared/types'

// ── 系统边界防御：stdout/stderr 管道断裂（EPIPE）──
// 应用从终端/脚本启动时，父进程先退出或控制台关闭后管道即不可写。
// 此后任意 console.log（如退出时的 stopGatewayServer）都会抛未捕获异常，
// Electron 会弹出「A JavaScript error occurred in the main process」错误框。
// EPIPE 是该场景的正常现象，吞掉；其他流错误照常抛出。
for (const stream of [process.stdout, process.stderr] as const) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err
  })
}

let mainWindow: BrowserWindow | null = null

/**
 * 安全向主窗口发送 IPC 事件：窗口未创建 / 已销毁或发送失败时静默丢弃。
 * UI 通知属非关键路径——主窗口在 MoA 执行中途被关闭时，
 * 'Object has been destroyed' 不得冒泡打断落库、记账与收尾流程。
 */
function safeSendMain(channel: string, ...args: unknown[]): void {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, ...args)
    }
  } catch {
    // 窗口销毁竞态：通知丢失即为预期结果
  }
}

// ── 用量监控状态 ──
// MoA 任务是否正在执行（用于今日用量悬浮窗的 running 状态）
let moaRunning = false

// ── 定价探查状态 ──
let pricingProbeRunning = false

/** request_logs 表行结构（含 models 列） */
interface RequestLogRow {
  request_id: string
  timestamp: number
  client_ip: string
  source: string
  moa_mode: string
  sub_count: number
  prompt_tokens: number
  completion_tokens: number
  cost: number
  duration_ms: number
  success: number
  error_detail: string | null
  models: string | null
}

/**
 * 广播用量更新事件，通知渲染进程重新拉取用量数据。
 * 桌面用量悬浮窗同步收到无参信号（渲染端自行拉取数据）。
 */
function broadcastUsageUpdate() {
  safeSendMain(IPC_EVENT.USAGE_UPDATED)
  syncUsageWindow()
}

/** 向主窗口推送一条悬浮通知（渲染进程全局 ToastCenter 展示） */
function sendToastToRenderer(data: ToastData): void {
  safeSendMain(IPC_EVENT.RENDERER_TOAST, data)
}

/** 记录一次标题生成的用量日志（source='title'）；tokenUsage 缺失则跳过 */
function recordTitleUsage(modelId: string, providerId: string, tokenUsage?: { prompt: number; completion: number }): void {
  if (!tokenUsage) return
  try {
    const entries = buildUsageEntries([{
      modelId,
      providerId,
      role: 'title',
      prompt: tokenUsage.prompt,
      completion: tokenUsage.completion
    }])
    getDatabase().exec(
      `INSERT INTO request_logs (request_id, timestamp, client_ip, source, moa_mode, sub_count, prompt_tokens, completion_tokens, cost, duration_ms, success, error_detail, models)
       VALUES (?, ?, '127.0.0.1', 'title', 'direct', 1, ?, ?, ?, 0, 1, NULL, ?)`,
      [
        crypto.randomUUID(),
        Date.now(),
        tokenUsage.prompt,
        tokenUsage.completion,
        entries[0].cost,
        JSON.stringify(entries)
      ]
    )
    broadcastUsageUpdate()
  } catch (err) {
    console.error('[Main] failed to record title usage:', err)
  }
}

/**
 * 读取设置；若已启用桌面用量悬浮窗则创建（app.whenReady / activate 时调用）。
 * 悬浮窗创建失败不阻塞启动，故保留兜底捕获。
 */
function maybeCreateUsageOverlay() {
  try {
    const settings = readAppSettings()
    if (settings.display?.usageOverlay) {
      createUsageWindow(settings)
    }
  } catch (err) {
    console.error('[Main] failed to create usage overlay:', err)
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  // 主窗口关闭时销毁悬浮窗并失效主窗口引用，保证 window-all-closed 能正常退出应用
  mainWindow.on('closed', () => {
    destroyUsageWindow()
    mainWindow = null
  })
}

function createApplicationMenu() {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: 'MoA Desktop',
      submenu: [
        { role: 'about' as const, label: '关于 MoA Desktop' },
        { type: 'separator' as const },
        { role: 'quit' as const, label: '退出' }
      ]
    }] : []),
    {
      label: '文件',
      submenu: [
        {
          label: '新建对话',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            safeSendMain(IPC_EVENT.MENU_NEW_CONVERSATION)
          }
        },
        { type: 'separator' as const },
        {
          label: '设置',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            safeSendMain(IPC_EVENT.MENU_OPEN_SETTINGS)
          }
        },
        { type: 'separator' as const },
        ...(isMac ? [] : [{ role: 'quit' as const, label: '退出' }])
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' as const, label: '撤销' },
        { role: 'redo' as const, label: '重做' },
        { type: 'separator' as const },
        { role: 'cut' as const, label: '剪切' },
        { role: 'copy' as const, label: '复制' },
        { role: 'paste' as const, label: '粘贴' },
        { role: 'selectAll' as const, label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' as const, label: '重新加载' },
        { role: 'forceReload' as const, label: '强制重新加载' },
        { role: 'toggleDevTools' as const, label: '开发者工具' },
        { type: 'separator' as const },
        { role: 'resetZoom' as const, label: '重置缩放' },
        { role: 'zoomIn' as const, label: '放大' },
        { role: 'zoomOut' as const, label: '缩小' },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const, label: '全屏' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' as const, label: '最小化' },
        { role: 'close' as const, label: '关闭' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: 'MoA 网关地址',
          click: () => {
            // 从 DB 读真实网关设置（用户可能改过 host/port/关闭网关）
            const { gateway } = readAppSettings()
            const url = gateway.enabled
              ? `http://${gateway.host}:${gateway.port}`
              : `http://${DEFAULT_HOST}:${DEFAULT_PORT} (网关未启用)`
            clipboard.writeText(gateway.enabled ? `http://${gateway.host}:${gateway.port}` : '')
            safeSendMain(IPC_EVENT.MENU_COPY_GATEWAY_URL, url)
          }
        }
      ]
    }
  ]
  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

function registerIpcHandlers() {
  // ── Config / Providers ──
  handleIpc(IPC.CONFIG_GET_PROVIDERS, () => getAllProviders())

  handleIpc(IPC.CONFIG_ADD_PROVIDER, (_e, data: { name: string; baseUrl: string; apiKey: string }) =>
    addProvider(data.name, data.baseUrl, data.apiKey)
  )

  handleIpc(IPC.CONFIG_REMOVE_PROVIDER, (_e, id: string) => {
    removeProvider(id)
  })

  handleIpc(IPC.CONFIG_GET_MODELS, (_e, providerId: string) => fetchAndCacheModels(providerId))

  // ── Conversations ──
  handleIpc(IPC.DB_GET_CONVERSATIONS, () =>
    getDatabase().query('SELECT * FROM conversations ORDER BY updated_at DESC')
  )

  handleIpc(IPC.DB_DELETE_CONVERSATION, (_e, id: string) => {
    getDatabase().exec('DELETE FROM messages WHERE conversation_id = ?', [id])
    getDatabase().exec('DELETE FROM conversations WHERE id = ?', [id])
  })

  handleIpc(IPC.DB_GET_MESSAGES, (_e, conversationId: string) =>
    getDatabase().query(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp',
      [conversationId]
    )
  )

  // ── Settings ──
  handleIpc(IPC.SETTINGS_GET_ALL, () => readAppSettings())

  handleIpc(IPC.SETTINGS_SET, (_e, key: string, value: unknown) => {
    const current = updateRawAppSettings((raw) => {
      if (key === 'display') {
        // display.usageOverlayPos 由主进程维护（悬浮窗拖拽回写，见 usageWindow.saveUsageOverlayPos），
        // 渲染端整块覆盖携带的快照可能过期 → 写入时保留主进程当前值，忽略 payload 中的该字段
        const incoming = { ...((value ?? {}) as Record<string, unknown>) }
        delete incoming.usageOverlayPos
        const prevPos = (raw.display as Record<string, unknown> | undefined)?.usageOverlayPos
        if (prevPos !== undefined) incoming.usageOverlayPos = prevPos
        raw.display = incoming
        return
      }
      raw[key] = value
    })

    // ── MoA 网关设置变更 → 运行态即时生效（enabled/host/port）──
    if (key === 'gateway') {
      applyGatewayServer()
        .then((actualPort) => {
          if (actualPort === null) return
          // 端口被占用时网关自动顺延：反馈实际监听端口，避免「改了设置但没生效」的错觉
          const { port } = readAppSettings().gateway
          if (actualPort !== port) {
            sendToastToRenderer({
              type: 'warning',
              title: '网关端口被占用',
              message: `网关端口 ${port} 被占用，实际监听 ${actualPort}`
            })
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('[Main] Gateway apply failed:', msg)
          sendToastToRenderer({ type: 'error', title: '网关启动失败', message: msg })
        })
    }

    // ── 网络代理变更 → 清除代理缓存 ──
    if (key === 'network') {
      invalidateProxyCache()
    }

    // ── 定价探查设置变更 → 重新调度自动探查定时器（间隔/源变化即时生效）──
    if (key === 'pricingProbe') {
      reschedulePricingAutoRefresh()
    }

    // ── 桌面用量悬浮窗开关联动 ──
    if (key === 'display') {
      const display = (value as Partial<AppSettings['display']>) ?? {}
      if (display.usageOverlay === true) {
        createUsageWindow(current)
      } else if (display.usageOverlay === false) {
        destroyUsageWindow()
      }
    }
  })

  // ── MoA Config ──
  ipcMain.handle(IPC.MOA_GET_CONFIG, () => {
    return getMoaConfig()
  })

  handleIpc(IPC.MOA_SET_CONFIG, (_e, config) => setMoaConfig(config))

  // ── MoA Send Message ──
  handleIpcRaw(IPC.MOA_SEND_MESSAGE, async (_e, msg: {
    conversationId?: string
    title?: string
    content: string
    mode: string
  }) => {
    moaRunning = true
    try {
      const db = getDatabase()
      let convId = msg.conversationId
      const now = Date.now()

      // ── Validate MoA config before execution ──
      const config = getMoaConfig()
      if (config.subModels.length === 0) {
        return { success: false, error: '请先配置子模型（MoA → 添加子模型）' }
      }
      if (msg.mode === 'aggregate' && !config.aggregator) {
        return { success: false, error: '聚合模式需要配置聚合模型（MoA → 聚合模型），或切换为 D 模式' }
      }

      // Auto-create conversation if none
      if (!convId) {
        convId = crypto.randomUUID()
        // 标题留空：渲染端 maybeAutoTitle 以「空标题」判定自动生成首轮标题，
        // 截取前 30 字会使其永不触发（侧栏对空标题回退显示「新对话」）
        const title = msg.title || ''
        db.exec(
          'INSERT INTO conversations (id, title, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          [convId, title, msg.mode, now, now]
        )

        // ── Fire-and-forget: first_message auto title generation ──
        // 注意：仅处理 autoMode='first_message'（用户首条消息一发出即生成标题）。
        // first_reply / first_and_manual 由渲染端在 onAllDone 收到完整回复后触发，
        // 此处必须排除，否则默认 first_and_manual 下两端会重复生成标题（双倍 API 调用）。
        ;(async () => {
          try {
            const ts = readAppSettings().title
            if (!ts.providerId || !ts.modelId) return
            if (ts.autoMode !== 'first_message') return
            const genResult = await generateTitle({
              messages: [{ role: 'user', content: msg.content }],
              providerId: ts.providerId,
              modelId: ts.modelId,
              maxLength: ts.maxLength || 50,
              language: ts.language || 'auto'
            })
            if (genResult.title) {
              db.exec('UPDATE conversations SET title = ? WHERE id = ?', [genResult.title, convId])
              const updatedConvs = db.query('SELECT * FROM conversations ORDER BY updated_at DESC')
              const wins = BrowserWindow.getAllWindows()
              for (const w of wins) {
                w.webContents.send(IPC_EVENT.TITLE_UPDATED, { conversationId: convId, title: genResult.title, conversations: updatedConvs })
              }

              // 标题生成成功且有 tokenUsage 时，记录一条用量日志（source='title'）；失败不记
              recordTitleUsage(ts.modelId, ts.providerId, genResult.tokenUsage)
            }
          } catch {
            // silent — title generation failure is non-critical
          }
        })()
      }

      // Load conversation history BEFORE saving user message (for multi-turn context)
      const historyRows = db.query<{ role: string; content: string }>(
        'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY timestamp',
        [convId]
      )
      const historyMessages = historyRows.map((r) => ({ role: r.role, content: r.content }))

      // Save user message
      const userMsgId = crypto.randomUUID()
      db.exec(
        `INSERT INTO messages (id, conversation_id, role, content, mode, timestamp)
         VALUES (?, ?, 'user', ?, ?, ?)`,
        [userMsgId, convId, msg.content, msg.mode, now]
      )

      // 防丢失：在历史查询之后落 assistant 占位行，完成/失败后回填内容——
      // 执行中途退出不会留下孤儿 user 行（占位若在历史查询前插入，空消息会污染多轮上下文）
      const asstMsgId = crypto.randomUUID()
      db.exec(
        `INSERT INTO messages (id, conversation_id, role, content, mode, sub_outputs, timestamp)
         VALUES (?, ?, 'assistant', '', ?, NULL, ?)`,
        [asstMsgId, convId, msg.mode, Date.now()]
      )

      // 每轮发送新建节流发射器（STREAM_PUSH_INTERVAL_MS）：每个子模型 index 一个 + 聚合一个。
      // running 增量与聚合 chunk(done=false) 走 push（窗口内只保留最新累计文本）；
      // 终态（success/error、done=true）走 flush(终值) + dispose()：立即发出、丢弃 pending，
      // 此后 push/flush 均为无操作（绝不把 UI 打回旧文本）。一轮结束后统一 dispose 防泄漏。
      const subEmitters = new Map<number, ThrottledEmitter<SubOutputUpdate>>()
      const subEmitterOf = (index: number): ThrottledEmitter<SubOutputUpdate> => {
        let emitter = subEmitters.get(index)
        if (!emitter) {
          emitter = createThrottledEmitter<SubOutputUpdate>(STREAM_PUSH_INTERVAL_MS, (update) => {
            safeSendMain(IPC_EVENT.MOA_SUB_OUTPUT_UPDATE, update)
          })
          subEmitters.set(index, emitter)
        }
        return emitter
      }
      const aggEmitter = createThrottledEmitter<AggregationChunk>(STREAM_PUSH_INTERVAL_MS, (chunk) => {
        safeSendMain(IPC_EVENT.MOA_AGGREGATION_CHUNK, chunk)
      })

      // Execute MoA with event emission：事件经 safeSendMain 隔离，窗口销毁不得打断执行与落库
      let moaResult: MoaResponse
      try {
        moaResult = await executeMoAWithEvents({
          messages: [...historyMessages, { role: 'user', content: msg.content }],
          subModels: config.subModels,
          aggregator: config.aggregator || undefined,
          mode: msg.mode as 'aggregate' | 'compare' | 'direct',
          aggregationPromptVariant: config.aggregationPromptVariant,
          // 定制聚合提示词须随聊天路径一并传入（此前只在网关路径生效）
          customAggregationPrompt: config.customAggregationPrompt,
          architecture: config.architecture,
          emitSubOutput: (output, index) => {
            const update = {
              index,
              modelId: output.modelId,
              providerId: output.providerId,
              content: output.content,
              status: output.status,
              error: output.error,
              durationMs: output.durationMs,
              tokenUsage: output.tokenUsage,
              role: output.role
            } satisfies SubOutputUpdate
            const emitter = subEmitterOf(index)
            if (output.status === 'running') {
              emitter.push(update)
            } else {
              // 终态：立即发终值（丢弃 pending）+ dispose，此后不得再补发旧文本
              emitter.flush(update)
              emitter.dispose()
            }
          },
          emitAggregationStart: () => {
            safeSendMain(IPC_EVENT.MOA_AGGREGATION_START)
          },
          emitAggregationChunk: (text, done) => {
            const chunk = { text, done } satisfies AggregationChunk
            if (!done) {
              aggEmitter.push(chunk)
            } else {
              // 终态：立即发终值（丢弃 pending）+ dispose
              aggEmitter.flush(chunk)
              aggEmitter.dispose()
            }
          }
        })
      } catch (err) {
        // 引擎整体抛错时转译为失败结果继续落库（与 gateway/server.ts 对同一调用的 .catch 先例一致）
        moaResult = {
          type: 'aggregate',
          content: '',
          subOutputs: [],
          success: false,
          error: `执行异常: ${err instanceof Error ? err.message : String(err)}`
        }
      } finally {
        // 一轮结束：清空全部发射器（防泄漏）；已 dispose 的重复调用为无操作
        for (const emitter of subEmitters.values()) emitter.dispose()
        aggEmitter.dispose()
      }

      // 回填 assistant 占位行（成功/失败均落内容，sub_outputs 记明细）
      const responseContent = moaResult.success ? moaResult.content : (moaResult.error || '处理失败')
      db.exec(
        'UPDATE messages SET content = ?, sub_outputs = ? WHERE id = ?',
        [responseContent, JSON.stringify(moaResult.subOutputs || []), asstMsgId]
      )

      // Update conversation
      db.exec('UPDATE conversations SET message_count = message_count + 2, updated_at = ?, mode = ? WHERE id = ?', [Date.now(), msg.mode, convId])

      // Log request
      const logId = crypto.randomUUID()
      const logDuration = Date.now() - now
      // 组装用量明细：成功且有 tokenUsage 的子模型（role='sub'）+ 聚合器（role='agg'，有则记）
      // 注意：SubModelOutput.providerId 已由 callSubModel 写入真实厂商 ID（providerId 参数），
      // 不再需要按 modelId 反查厂商（同名模型跨厂商会互相覆盖——旧实现的坑）。
      const usageInputs: Array<{ modelId: string; providerId?: string; role: 'sub' | 'agg' | 'title'; prompt: number; completion: number }> = []
      for (const o of (moaResult.subOutputs || [])) {
        if (o.status === 'success' && o.tokenUsage) {
          usageInputs.push({
            modelId: o.modelId,
            providerId: o.providerId,
            role: 'sub',
            prompt: o.tokenUsage.prompt,
            completion: o.tokenUsage.completion
          })
        }
      }
      if (moaResult.aggregatorUsage) {
        // fallback 聚合生效时 aggregatorModelId/ProviderId 是 fallback 的
        usageInputs.push({
          modelId: moaResult.aggregatorModelId || config.aggregator?.primaryModelId || '',
          providerId: moaResult.aggregatorProviderId || config.aggregator?.primaryProviderId,
          role: 'agg',
          prompt: moaResult.aggregatorUsage.prompt,
          completion: moaResult.aggregatorUsage.completion
        })
      }
      const usageEntries = buildUsageEntries(usageInputs, now)
      const usageTotals = sumUsage(usageEntries)
      db.exec(
        `INSERT INTO request_logs (request_id, timestamp, client_ip, source, moa_mode, sub_count, prompt_tokens, completion_tokens, cost, duration_ms, success, error_detail, models)
         VALUES (?, ?, '127.0.0.1', 'chat', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [logId, now, msg.mode, moaResult.subOutputs.length, usageTotals.prompt, usageTotals.completion, usageTotals.cost, logDuration, moaResult.success ? 1 : 0, moaResult.success ? null : (moaResult.error || null), JSON.stringify(usageEntries)]
      )

      // 用量更新广播（悬浮窗同步由后续任务接入）
      broadcastUsageUpdate()

      // Fetch updated conversation list
      const conversations = db.query('SELECT * FROM conversations ORDER BY updated_at DESC')

      // Emit allDone event
      safeSendMain(IPC_EVENT.MOA_ALL_DONE, {
        conversationId: convId,
        conversations
      })

      return { success: true, data: { conversationId: convId, moaResult, conversations } }
    } finally {
      moaRunning = false
    }
  })

  // ── Title Generate ──
  handleIpcRaw(IPC.TITLE_GENERATE, async (_e, data: {
    conversationId: string
    messages: Array<{ role: string; content: string }>
    providerId: string
    modelId: string
    maxLength: number
    language: 'auto' | 'zh' | 'en'
  }) => {
    const result = await generateTitle({
      messages: data.messages,
      providerId: data.providerId,
      modelId: data.modelId,
      maxLength: data.maxLength,
      language: data.language
    })
    if (result.title === null) {
      return { success: false, error: '标题生成失败：模型返回空或未配置正确（请检查厂商 API Key 和模型 ID）' }
    }
    // 渲染端手动/首次标题生成同样记录用量，与主进程 first_message 路径口径一致
    recordTitleUsage(data.modelId, data.providerId, result.tokenUsage)
    return { success: true, title: result.title }
  })

  // ── Update Conversation Title ──
  handleIpcRaw(IPC.DB_UPDATE_CONVERSATION_TITLE, (_e, conversationId: string, title: string, titleEdited?: boolean) => {
    const db = getDatabase()
    // Only update title & title_edited — never touch updated_at;
    // sort order must reflect real activity, not metadata changes.
    db.exec(
      'UPDATE conversations SET title = ?, title_edited = ? WHERE id = ?',
      [title, titleEdited ? 1 : 0, conversationId]
    )
    const conversations = db.query('SELECT * FROM conversations ORDER BY updated_at DESC')
    return { success: true, conversations }
  })

  // ── Usage Monitoring ──
  handleIpc(IPC.USAGE_GET_SUMMARY, (_e, params: { range: UsageRange; groupBy: UsageGroupBy }) => {
    const { range, groupBy } = params
    const now = Date.now()
    let since: number | null = null
    if (range === 'today') since = new Date().setHours(0, 0, 0, 0)
    else if (range === 'week') since = now - 7 * 86400000
    else if (range === 'month') since = now - 30 * 86400000
    // range === 'all' → 不限时间范围

    const rows = since === null
      ? getDatabase().query<RequestLogRow>('SELECT * FROM request_logs')
      : getDatabase().query<RequestLogRow>('SELECT * FROM request_logs WHERE timestamp >= ?', [since])

    // 厂商 ID → 厂商名称（getAllProviders 依赖 DB 已初始化，故在 handler 内调用）
    const providerNameMap = new Map(getAllProviders().map((p) => [p.id, p.name] as const))
    const MODE_LABELS: Record<string, string> = {
      aggregate: '聚合',
      compare: '对比',
      direct: '直通',
      passthrough: '透传'
    }

    // 总量：行数 / 成功行数 / 各列累加
    const totals = { requests: 0, success: 0, prompt: 0, completion: 0, cost: 0 }
    // 分组明细：Map<key, UsageRow>
    const rowMap = new Map<string, UsageRow>()

    for (const row of rows) {
      totals.requests += 1
      if (row.success === 1) totals.success += 1
      totals.prompt += row.prompt_tokens || 0
      totals.completion += row.completion_tokens || 0
      totals.cost += row.cost || 0

      // 解析 models 列；null/空/损坏则跳过明细（仅计入 totals）
      let models: Array<{ modelId: string; providerId?: string; prompt: number; completion: number; cost: number }> | null = null
      try {
        models = row.models ? JSON.parse(row.models) : null
      } catch {
        models = null
      }
      if (!models || models.length === 0) {
        // 无明细行（网关 stats 模式写 models='[]'）：按行级字段补一条分组，保证 rows 合计与 totals 可对账
        const noDetailKey = groupBy === 'mode'
          ? (row.source === 'title' ? '标题' : (MODE_LABELS[row.moa_mode] || row.moa_mode || 'direct'))
          : '（仅统计·无明细）'
        const noDetail = rowMap.get(noDetailKey) || { key: noDetailKey, requests: 0, success: 0, prompt: 0, completion: 0, cost: 0 }
        noDetail.requests += 1
        noDetail.success += row.success === 1 ? 1 : 0
        noDetail.prompt += row.prompt_tokens || 0
        noDetail.completion += row.completion_tokens || 0
        noDetail.cost += row.cost || 0
        rowMap.set(noDetailKey, noDetail)
        continue
      }

      // 按 groupBy 归组：model→modelId；provider→真实厂商名（providerId 缺失时兜底 modelId）；mode→中文模式标签
      for (const m of models) {
        let key: string
        if (groupBy === 'model') {
          key = m.modelId
        } else if (groupBy === 'provider') {
          // providerId 缺失或厂商已删除 → 兜底显示模型名，避免 UUID
          key = m.providerId ? (providerNameMap.get(m.providerId) ?? m.modelId) : m.modelId
        } else {
          // 标题生成日志（source='title'）单独归组，避免污染「直通」模式
          key = row.source === 'title' ? '标题' : (MODE_LABELS[row.moa_mode] || row.moa_mode || 'direct')
        }
        const agg = rowMap.get(key) || { key, requests: 0, success: 0, prompt: 0, completion: 0, cost: 0 }
        agg.requests += 1
        agg.success += row.success === 1 ? 1 : 0
        agg.prompt += m.prompt || 0
        agg.completion += m.completion || 0
        agg.cost += m.cost || 0
        rowMap.set(key, agg)
      }
    }

    return {
      range,
      groupBy,
      totals,
      rows: Array.from(rowMap.values())
    } satisfies UsageSummary
  })

  handleIpc(IPC.USAGE_GET_TODAY, () => {
    // today 范围：当天 0 点起
    const since = new Date().setHours(0, 0, 0, 0)
    const rows = getDatabase().query<RequestLogRow>('SELECT * FROM request_logs WHERE timestamp >= ?', [since])
    let prompt = 0
    let completion = 0
    let cost = 0
    for (const row of rows) {
      prompt += row.prompt_tokens || 0
      completion += row.completion_tokens || 0
      cost += row.cost || 0
    }
    return { prompt, completion, cost, running: moaRunning } satisfies UsageToday
  })

  // ── Cloud Usage Monitoring (Command Code / MiMo / DeepSeek) ──
  handleIpc(IPC.MONITOR_GET_STATUS, (_e, source: RemoteUsageSource) =>
    source.type === 'deepseek' ? getDeepSeekStatus(source.id) : getMonitorStatus(source.id)
  )

  handleIpc(IPC.MONITOR_LOGIN, (_e, source: RemoteUsageSource) =>
    source.type === 'mimo'
      ? loginToMimo(source, mainWindow)
      : source.type === 'deepseek'
        ? loginToDeepSeek(source, mainWindow)
        : loginToCommandCode(source, mainWindow)
  )

  handleIpc(IPC.MONITOR_LOGOUT, (_e, sourceId: string) => {
    logoutCommandCode(sourceId)
    logoutDeepSeek(sourceId)
    // 登出即清该源本地累计：同一 sourceId 换账号后不得混入旧账号的用量记录
    clearCumulativeUsage(sourceId)
  })

  handleIpc(IPC.MONITOR_SET_API_KEY, (_e, sourceId: string, apiKey: string) => {
    saveUsageCredential(usageApiKeyKey(sourceId), apiKey)
  })

  // 本地累计（Command Code）：多次采集去重累积的按模型用量
  handleIpc(IPC.MONITOR_GET_CUMULATIVE, (_e, sourceId: string) => getCumulativeUsage(sourceId))

  // 后台采集器状态（是否启用 / 间隔 / 上次采集时间 / 上次错误）
  handleIpc(IPC.MONITOR_COLLECTOR_STATUS, () => getCollectorStatus())

  handleIpcRaw(IPC.MONITOR_REFRESH, async (_e, source: RemoteUsageSource) => {
    // 页面刷新与后台采集共用同一「自动刷新间隔」：这里先占位，
    // 采集器据此跳过同一间隔内的重复拉取（见 collector.markUsageCollected）
    if (source.type === 'commandcode') markUsageCollected()
    const result =
      source.type === 'mimo'
        ? await refreshMimoUsage(source)
        : source.type === 'deepseek'
          ? await refreshDeepSeekUsage(source)
          : await refreshCommandCodeUsage(source)
    if (result.ok) {
      return { success: true, data: result.data }
    }
    return { success: false, error: result.error, code: result.code }
  })

  // ── 定价探查（LLM 自动更新官方定价）──
  handleIpcRaw(IPC.PRICING_PROBE_RUN, async (_e, sources?: PricingProbeSource[], force?: boolean) => {
    if (pricingProbeRunning) return { success: false, error: '探查进行中' }
    pricingProbeRunning = true
    try {
      // 直接探查调用方传入的源对象（已配置 key 的厂商可自动派生，无需持久化源）
      const valid = (Array.isArray(sources) ? sources : []).filter(
        (s) => s && s.enabled !== false && sourceHasConfiguredKey(s)
      )
      if (valid.length === 0) return { success: true, data: { results: [] } }
      const model = resolveProbeModel()
      if (!model) {
        return { success: false, error: '未配置可用的大模型（请先配置带 API Key 的厂商，或在「定价探查」指定探查模型）' }
      }
      // 探查过程中向渲染进程实时推送进度事件
      const emitProgress = (p: ProbeProgressEvent) => {
        safeSendMain(IPC_EVENT.PRICING_PROBE_PROGRESS, p)
      }
      const results = await probeSources(valid, model, emitProgress, force === true)
      return { success: true, data: { results } }
    } finally {
      pricingProbeRunning = false
    }
  })
}

/** 定价探查自动刷新定时器句柄（模块级，设置变更时可重置） */
let pricingAutoRefreshTimer: NodeJS.Timeout | null = null
/** 调度世代：每次重新调度 +1，丢弃旧一轮仍在运行的任务对定时器的覆盖 */
let pricingAutoRefreshEpoch = 0

/**
 * 定价探查自动刷新：先探查一次，之后严格按 autoRefreshSeconds（秒）轮回；默认关闭（>0 时启用）。
 * 可重复调用以按最新配置重新调度（设置变更时由 reschedulePricingAutoRefresh 触发）。
 */
function schedulePricingAutoRefresh(initialDelayMs = 10_000): void {
  const epoch = ++pricingAutoRefreshEpoch
  if (pricingAutoRefreshTimer) {
    clearTimeout(pricingAutoRefreshTimer)
    pricingAutoRefreshTimer = null
  }

  const runOnce = async () => {
    if (epoch !== pricingAutoRefreshEpoch) return
    try {
      const { autoRefreshSeconds, sources } = getPricingProbeConfig()
      if (autoRefreshSeconds <= 0) return
      const enabled = sources.filter((s) => s.enabled && sourceHasConfiguredKey(s))
      if (enabled.length === 0) return

      const probed = readAppSettings().probedPricing

      const cutoff = Date.now() - autoRefreshSeconds * 1000
      const stale = enabled.filter((s) => {
        const last = probed.filter((e) => e.sourceId === s.id).reduce((max, e) => Math.max(max, e.fetchedAt), 0)
        return last < cutoff
      })
      if (stale.length === 0) return

      const model = resolveProbeModel()
      if (!model) {
        console.warn('[PricingProbe] auto-refresh skipped: no probe model available')
        return
      }
      console.log(`[PricingProbe] auto-refresh ${stale.length} stale source(s)`)
      // 执行前预警：后台自动刷新定价同样会调用大模型，弹悬浮通知告知。
      // 模型需显示「厂商名 · 模型ID」而非只显示模型 ID（模型 ID 可能与官方同名，如 deepseek/deepseek-v4-flash 实际走 Command Code 中转端点）
      const probeProviderName =
        getAllProviders().find((p) => p.id === model.providerId)?.name ?? model.baseUrl
      sendToastToRenderer({
        type: 'warning',
        title: '定价自动刷新将消耗 Token',
        message: `将对 ${stale.length} 个过期定价源调用 ${probeProviderName} · ${model.modelId} 探查，产生 Token 消耗`
      })
      pricingProbeRunning = true
      try {
        await probeSources(stale, model)
      } finally {
        pricingProbeRunning = false
      }
    } catch (err) {
      console.error('[PricingProbe] auto-refresh failed:', err)
    } finally {
      if (epoch === pricingAutoRefreshEpoch) scheduleNext()
    }
  }

  const scheduleNext = () => {
    if (pricingAutoRefreshTimer) {
      clearTimeout(pricingAutoRefreshTimer)
      pricingAutoRefreshTimer = null
    }
    const { autoRefreshSeconds } = getPricingProbeConfig()
    if (autoRefreshSeconds <= 0) return
    pricingAutoRefreshTimer = setTimeout(runOnce, autoRefreshSeconds * 1000)
  }

  // 首次探查：启动后 10s（或设置变更后 5s），之后按设置的间隔轮回
  pricingAutoRefreshTimer = setTimeout(runOnce, initialDelayMs)
}

/** 定价探查设置变更后重新调度：清旧定时器，约 5s 后先探查一次，再按最新间隔轮回 */
function reschedulePricingAutoRefresh(): void {
  schedulePricingAutoRefresh(5_000)
}

app.whenReady().then(async () => {
  // Init database
  const db = getDatabase()
  try {
    await db.init()
    console.log('[Main] Database initialized')
  } catch (err) {
    console.error('[Main] Database init failed:', err)
  }

  // Load MoA config from DB
  try {
    loadMoaConfigFromDb()
  } catch (err) {
    console.error('[Main] MoA config load failed:', err)
  }

  // Seed built-in providers on first launch
  try {
    seedBuiltInProviders()
  } catch (err) {
    console.error('[Main] Failed to seed providers:', err)
  }

  // Register IPC handlers
  registerIpcHandlers()

  // 定价探查自动刷新（默认关闭，autoRefreshSeconds>0 时启用）
  schedulePricingAutoRefresh()

  // Command Code 用量后台采集（本地累计的数据来源；间隔从设置读取，0 = 关闭）
  startUsageCollector()

  // Set up Chinese application menu
  createApplicationMenu()

  // UI 广播桥注入：网关等模块经 broadcastToUi 推送直播事件（窗口未创建/销毁时静默）
  initUiBridge(safeSendMain)

  // Create window
  createWindow()

  // 用量悬浮窗：注册「打开用量页」回调；若设置已启用则创建
  setOpenUsageHandler(() => {
    mainWindow?.show()
    mainWindow?.focus()
    safeSendMain(IPC_EVENT.USAGE_OPEN)
  })
  maybeCreateUsageOverlay()

  // Start MoA gateway server（仅当设置启用；端口占用时自动顺延）
  try {
    const actualPort = await applyGatewayServer()
    if (actualPort !== null) {
      const { port } = readAppSettings().gateway
      console.log(`[Main] Gateway running on port ${actualPort}${actualPort !== port ? ` (requested ${port})` : ''}`)
      if (actualPort !== port) {
        sendToastToRenderer({
          type: 'warning',
          title: '网关端口被占用',
          message: `网关端口 ${port} 被占用，实际监听 ${actualPort}`
        })
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Main] Gateway server failed to start:', msg)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      maybeCreateUsageOverlay()
    }
  })
})

// ── 退出时等待进行中的 MoA 执行完成（防丢结果）──
// 首次退出：执行中则拦下等待（toast 提示；再次退出 = 强制放行）；
// 等待结束后 app.quit() 重入本回调走正常清理；兜底超时 120s 强退
let quitWaitStarted = false

app.on('before-quit', (e) => {
  if (moaRunning && !quitWaitStarted) {
    e.preventDefault()
    quitWaitStarted = true
    sendToastToRenderer({
      type: 'info',
      title: '等待 MoA 执行完成',
      message: '当前回复生成中，完成后将自动退出；再次退出可强制关闭',
      duration: 6000
    })
    const waitTimer = setInterval(() => {
      if (!moaRunning) {
        clearInterval(waitTimer)
        app.quit()
      }
    }, 250)
    setTimeout(() => {
      clearInterval(waitTimer)
      app.quit()
    }, 120_000)
    return
  }
  stopUsageCollector()
  stopGatewayServer()
  // 退出前清掉定价自动刷新定时器：避免退出流程中仍有探查任务在跑
  if (pricingAutoRefreshTimer) {
    clearTimeout(pricingAutoRefreshTimer)
    pricingAutoRefreshTimer = null
  }
  getDatabase().flush()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
