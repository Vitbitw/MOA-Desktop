import crypto from 'node:crypto'
import { app, BrowserWindow, ipcMain, Menu, shell, clipboard } from 'electron'
import path from 'path'
import { getDatabase } from './db/database'
import { IPC, IPC_EVENT } from '../shared/ipc-channels'
import type { AppSettings, SubOutputUpdate, AggregationChunk, UsageSummary, UsageRange, UsageGroupBy, UsageToday, UsageRow } from '../shared/types'
import { DEFAULT_SETTINGS, DEFAULT_HOST, DEFAULT_PORT } from '../shared/defaults'
import { createProxyServer, startProxyServer, stopProxyServer } from './proxy/server'
import { getAllProviders, addProvider, removeProvider, fetchAndCacheModels, seedBuiltInProviders } from './providers/providerManager'
import { getMoaConfig, setMoaConfig, loadMoaConfigFromDb } from './moa/moaConfig'
import { executeMoA, executeMoAWithEvents } from './moa/moaEngine'
import { generateTitle } from './title/titleGenerator'
import { buildUsageEntries, sumUsage } from './moa/usage'
import { createUsageWindow, destroyUsageWindow, setOpenUsageHandler, syncUsageWindow } from './usage/usageWindow'
import { detectLocalEngines, probeCustomBaseUrl } from './local/engineDetector'
import { upsertDetectedEngine, listLocalEngines, removeEngine } from './local/localManager'

let mainWindow: BrowserWindow | null = null

// ── 用量监控状态 ──
// MoA 任务是否正在执行（用于今日用量悬浮窗的 running 状态）
let moaRunning = false

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
  mainWindow?.webContents.send(IPC_EVENT.USAGE_UPDATED)
  syncUsageWindow()
}

/**
 * 读取设置；若已启用桌面用量悬浮窗则创建（app.whenReady / activate 时调用）。
 */
function maybeCreateUsageOverlay() {
  try {
    const row = getDatabase().queryOne<{ value: string }>(
      "SELECT value FROM moa_config WHERE key = 'app_settings'"
    )
    const saved = row?.value ? JSON.parse(row.value) : {}
    const settings = { ...DEFAULT_SETTINGS, ...saved } as AppSettings
    if (settings.display?.usageOverlay) {
      createUsageWindow(settings)
    }
  } catch (err) {
    console.error('[Main] 创建用量悬浮窗失败:', err)
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

  // 主窗口关闭时销毁悬浮窗，保证 window-all-closed 能正常退出应用
  mainWindow.on('closed', () => {
    destroyUsageWindow()
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
            mainWindow?.webContents.send(IPC_EVENT.MENU_NEW_CONVERSATION)
          }
        },
        { type: 'separator' as const },
        {
          label: '设置',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            mainWindow?.webContents.send(IPC_EVENT.MENU_OPEN_SETTINGS)
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
          label: 'API 代理地址',
          click: () => {
            const settings = DEFAULT_SETTINGS.proxy
            const url = `http://${settings.host}:${settings.port}`
            clipboard.writeText(url)
            mainWindow?.webContents.send(IPC_EVENT.MENU_COPY_PROXY_URL, url)
          }
        },
        { type: 'separator' as const },
        {
          label: '项目 GitHub',
          click: () => shell.openExternal('https://github.com/')
        }
      ]
    }
  ]
  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

function registerIpcHandlers() {
  // ── Config / Providers ──
  ipcMain.handle(IPC.CONFIG_GET_PROVIDERS, () => {
    try {
      return { success: true, data: getAllProviders() }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.CONFIG_ADD_PROVIDER, (_e, data: { name: string; baseUrl: string; apiKey: string }) => {
    try {
      const { name, baseUrl, apiKey } = data
      const result = addProvider(name, baseUrl, apiKey)
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.CONFIG_REMOVE_PROVIDER, (_e, id: string) => {
    try {
      removeProvider(id)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.CONFIG_GET_MODELS, async (_e, providerId: string) => {
    try {
      const models = await fetchAndCacheModels(providerId)
      return { success: true, data: models }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── Conversations ──
  ipcMain.handle(IPC.DB_GET_CONVERSATIONS, () => {
    try {
      const convs = getDatabase().query('SELECT * FROM conversations ORDER BY updated_at DESC')
      return { success: true, data: convs }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.DB_CREATE_CONVERSATION, (_e, data: { title: string; mode: string }) => {
    try {
      const id = crypto.randomUUID()
      const now = Date.now()
      getDatabase().exec(
        'INSERT INTO conversations (id, title, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [id, data.title, data.mode, now, now]
      )
      return { success: true, data: { id, ...data, createdAt: now } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.DB_DELETE_CONVERSATION, (_e, id: string) => {
    try {
      getDatabase().exec('DELETE FROM messages WHERE conversation_id = ?', [id])
      getDatabase().exec('DELETE FROM conversations WHERE id = ?', [id])
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.DB_GET_MESSAGES, (_e, conversationId: string) => {
    try {
      const msgs = getDatabase().query(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp',
        [conversationId]
      )
      return { success: true, data: msgs }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.DB_ADD_MESSAGE, (_e, msg: {
    conversationId: string; role: string; content: string; mode: string; subOutputs?: string; tokenUsage?: string
  }) => {
    try {
      const id = crypto.randomUUID()
      getDatabase().exec(
        `INSERT INTO messages (id, conversation_id, role, content, mode, sub_outputs, token_usage, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, msg.conversationId, msg.role, msg.content, msg.mode, msg.subOutputs || null, msg.tokenUsage || null, Date.now()]
      )
      getDatabase().exec('UPDATE conversations SET message_count = message_count + 1, updated_at = ? WHERE id = ?', [Date.now(), msg.conversationId])
      return { success: true, data: { id } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── Settings ──
  ipcMain.handle(IPC.SETTINGS_GET_ALL, () => {
    try {
      const row = getDatabase().queryOne<{ value: string }>(
        "SELECT value FROM moa_config WHERE key = 'app_settings'"
      )
      if (row?.value) {
        const saved = JSON.parse(row.value)
        return { success: true, data: { ...DEFAULT_SETTINGS, ...saved } }
      }
      return { success: true, data: DEFAULT_SETTINGS }
    } catch (err) {
      return { success: true, data: DEFAULT_SETTINGS }
    }
  })

  ipcMain.handle(IPC.SETTINGS_SET, (_e, key: string, value: unknown) => {
    try {
      // Load current, update, save
      const row = getDatabase().queryOne<{ value: string }>(
        "SELECT value FROM moa_config WHERE key = 'app_settings'"
      )
      const current = row?.value ? JSON.parse(row.value) : {}
      current[key] = value
      getDatabase().exec(
        'INSERT OR REPLACE INTO moa_config (key, value, updated_at) VALUES (\'app_settings\', ?, ?)',
        [JSON.stringify(current), Date.now()]
      )

      // ── 桌面用量悬浮窗开关联动 ──
      if (key === 'display') {
        const display = (value as Partial<AppSettings['display']>) ?? {}
        if (display.usageOverlay === true) {
          createUsageWindow({ ...DEFAULT_SETTINGS, ...current } as AppSettings)
        } else if (display.usageOverlay === false) {
          destroyUsageWindow()
        }
      }

      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── App ──
  ipcMain.handle(IPC.APP_GET_VERSION, () => {
    return app.getVersion()
  })

  // ── MoA Config ──
  ipcMain.handle(IPC.MOA_GET_CONFIG, () => {
    return getMoaConfig()
  })

  ipcMain.handle(IPC.MOA_SET_CONFIG, (_e, config) => {
    return setMoaConfig(config)
  })

  // ── MoA Send Message ──
  ipcMain.handle(IPC.MOA_SEND_MESSAGE, async (_e, msg: {
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
        const title = msg.title || (msg.content.length > 30 ? msg.content.slice(0, 30) + '…' : msg.content)
        db.exec(
          'INSERT INTO conversations (id, title, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          [convId, title, msg.mode, now, now]
        )

        // ── Fire-and-forget: first_message auto title generation ──
        ;(async () => {
          try {
            const settingsRow = db.queryOne<{ value: string }>("SELECT value FROM moa_config WHERE key = 'app_settings'")
            if (!settingsRow?.value) return
            const appSettings = JSON.parse(settingsRow.value)
            const ts = appSettings?.title
            if (!ts?.providerId || !ts?.modelId) return
            if (ts.autoMode !== 'first_message' && ts.autoMode !== 'first_and_manual') return
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
              if (genResult.tokenUsage) {
                const titleEntries = buildUsageEntries([{
                  modelId: ts.modelId,
                  providerId: ts.providerId,
                  role: 'title',
                  prompt: genResult.tokenUsage.prompt,
                  completion: genResult.tokenUsage.completion
                }])
                db.exec(
                  `INSERT INTO request_logs (request_id, timestamp, client_ip, source, moa_mode, sub_count, prompt_tokens, completion_tokens, cost, duration_ms, success, error_detail, models)
                   VALUES (?, ?, '127.0.0.1', 'title', 'direct', 1, ?, ?, ?, 0, 1, NULL, ?)`,
                  [
                    crypto.randomUUID(),
                    Date.now(),
                    genResult.tokenUsage.prompt,
                    genResult.tokenUsage.completion,
                    titleEntries[0].cost,
                    JSON.stringify(titleEntries)
                  ]
                )
                // 用量更新广播（悬浮窗同步由后续任务接入）
                broadcastUsageUpdate()
              }
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

      // Execute MoA with event emission
      const win = BrowserWindow.fromWebContents(_e.sender)
      const moaResult = await executeMoAWithEvents({
        messages: [...historyMessages, { role: 'user', content: msg.content }],
        subModels: config.subModels,
        aggregator: config.aggregator || undefined,
        mode: msg.mode as 'aggregate' | 'compare' | 'direct',
        aggregationPromptVariant: config.aggregationPromptVariant,
        emitSubOutput: (output, index) => {
          if (win) {
            win.webContents.send(IPC_EVENT.MOA_SUB_OUTPUT_UPDATE, {
              index,
              modelId: output.modelId,
              providerId: output.providerId,
              content: output.content,
              status: output.status,
              error: output.error,
              durationMs: output.durationMs,
              tokenUsage: output.tokenUsage
            } satisfies SubOutputUpdate)
          }
        },
        emitAggregationStart: () => {
          if (win) {
            win.webContents.send(IPC_EVENT.MOA_AGGREGATION_START)
          }
        },
        emitAggregationChunk: (text, done) => {
          if (win) {
            win.webContents.send(IPC_EVENT.MOA_AGGREGATION_CHUNK, { text, done } satisfies AggregationChunk)
          }
        }
      })

      // Save assistant response
      const asstMsgId = crypto.randomUUID()
      const responseContent = moaResult.success ? moaResult.content : (moaResult.error || '处理失败')
      db.exec(
        `INSERT INTO messages (id, conversation_id, role, content, mode, sub_outputs, timestamp)
         VALUES (?, ?, 'assistant', ?, ?, ?, ?)`,
        [
          asstMsgId, convId, responseContent, msg.mode,
          JSON.stringify(moaResult.subOutputs || []), Date.now()
        ]
      )

      // Update conversation
      db.exec('UPDATE conversations SET message_count = message_count + 2, updated_at = ? WHERE id = ?', [Date.now(), convId])

      // Log request
      const logId = crypto.randomUUID()
      const logDuration = Date.now() - now
      // 组装用量明细：成功且有 tokenUsage 的子模型（role='sub'）+ 聚合器（role='agg'，有则记）
      // 注意：SubModelOutput.providerId 存的是 baseUrl（见 subModelCaller），不是厂商 ID；
      // 厂商 ID 必须从 config.subModels 的 SubModelConfig.providerId 映射取。
      const subProviderMap = new Map(config.subModels.map((sm) => [sm.modelId, sm.providerId]))
      const usageInputs: Array<{ modelId: string; providerId?: string; role: 'sub' | 'agg' | 'title'; prompt: number; completion: number }> = []
      for (const o of (moaResult.subOutputs || [])) {
        if (o.status === 'success' && o.tokenUsage) {
          usageInputs.push({
            modelId: o.modelId,
            providerId: subProviderMap.get(o.modelId),
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
      const usageEntries = buildUsageEntries(usageInputs)
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
      if (win) {
        win.webContents.send(IPC_EVENT.MOA_ALL_DONE, {
          conversationId: convId,
          conversations
        })
      }

      return { success: true, data: { conversationId: convId, moaResult, conversations } }
    } catch (err) {
      return { success: false, error: String(err) }
    } finally {
      moaRunning = false
    }
  })

  // ── Title Generate ──
  ipcMain.handle(IPC.TITLE_GENERATE, async (_e, data: {
    conversationId: string
    messages: Array<{ role: string; content: string }>
    providerId: string
    modelId: string
    maxLength: number
    language: 'auto' | 'zh' | 'en'
  }) => {
    try {
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
      return { success: true, title: result.title }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── Update Conversation Title ──
  ipcMain.handle(IPC.DB_UPDATE_CONVERSATION_TITLE, (_e, conversationId: string, title: string, titleEdited?: boolean) => {
    try {
      const db = getDatabase()
      // Only update title & title_edited — never touch updated_at;
      // sort order must reflect real activity, not metadata changes.
      db.exec(
        'UPDATE conversations SET title = ?, title_edited = ? WHERE id = ?',
        [title, titleEdited ? 1 : 0, conversationId]
      )
      const conversations = db.query('SELECT * FROM conversations ORDER BY updated_at DESC')
      return { success: true, conversations }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── Usage Monitoring ──
  ipcMain.handle(IPC.USAGE_GET_SUMMARY, (_e, params: { range: UsageRange; groupBy: UsageGroupBy }) => {
    try {
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
        direct: '直通'
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
        if (!models || models.length === 0) continue

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
        success: true,
        data: {
          range,
          groupBy,
          totals,
          rows: Array.from(rowMap.values())
        } satisfies UsageSummary
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.USAGE_GET_TODAY, () => {
    try {
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
      return {
        success: true,
        data: { prompt, completion, cost, running: moaRunning } satisfies UsageToday
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── Local Model Deployment ──
  ipcMain.handle(IPC.LOCAL_DETECT_ENGINES, async () => {
    try {
      const detected = await detectLocalEngines()
      for (const d of detected) upsertDetectedEngine(d)
      return { success: true, data: detected }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.LOCAL_LIST_ENGINES, () => {
    try {
      return { success: true, data: listLocalEngines() }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.LOCAL_ADD_MANUAL_ENGINE, async (_e, baseUrl: string) => {
    try {
      const detected = await probeCustomBaseUrl(baseUrl)
      if (!detected) return { success: false, error: '无法连接该地址的 /models 端点' }
      const { id, created } = upsertDetectedEngine(detected)
      return { success: true, data: { id, created, detected } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.LOCAL_REMOVE_ENGINE, (_e, id: string) => {
    try {
      removeEngine(id)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
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

  // Set up Chinese application menu
  createApplicationMenu()

  // Create window
  createWindow()

  // 后台探测本地引擎（不阻塞启动，失败静默）
  detectLocalEngines().then((detected) => {
    for (const d of detected) {
      try { upsertDetectedEngine(d) } catch { /* 静默 */ }
    }
    mainWindow?.webContents.send(IPC_EVENT.LOCAL_ENGINE_STATUS_CHANGED, detected)
  }).catch(() => { /* 静默 */ })

  // 用量悬浮窗：注册「打开用量页」回调；若设置已启用则创建
  setOpenUsageHandler(() => {
    mainWindow?.show()
    mainWindow?.focus()
    mainWindow?.webContents.send(IPC_EVENT.USAGE_OPEN)
  })
  maybeCreateUsageOverlay()

  // Start proxy server (auto-finds next available port if DEFAULT_PORT is busy)
  const proxyApp = createProxyServer()
  try {
    const actualPort = await startProxyServer(proxyApp, DEFAULT_PORT, DEFAULT_HOST)
    if (actualPort !== DEFAULT_PORT) {
      console.log(`[Main] Proxy running on port ${actualPort} (requested ${DEFAULT_PORT})`)
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Main] Proxy server failed to start:', msg)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      maybeCreateUsageOverlay()
    }
  })
})

app.on('before-quit', () => {
  stopProxyServer()
  getDatabase().flush()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
