import crypto from 'node:crypto'
import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'path'
import { getDatabase } from './db/database'
import { IPC } from '../shared/ipc-channels'
import type { AppSettings } from '../shared/types'
import { DEFAULT_SETTINGS, DEFAULT_HOST, DEFAULT_PORT } from '../shared/defaults'
import { createProxyServer, startProxyServer, stopProxyServer } from './proxy/server'
import { getAllProviders, addProvider, removeProvider, fetchAndCacheModels, seedBuiltInProviders } from './providers/providerManager'
import { getMoaConfig, setMoaConfig, loadMoaConfigFromDb } from './moa/moaConfig'
import { executeMoA } from './moa/moaEngine'

let mainWindow: BrowserWindow | null = null

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
    return { success: true, data: DEFAULT_SETTINGS }
  })

  ipcMain.handle(IPC.SETTINGS_SET, (_e, key: string, value: unknown) => {
    try {
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
    try {
      const db = getDatabase()
      let convId = msg.conversationId
      const now = Date.now()

      // Auto-create conversation if none
      if (!convId) {
        convId = crypto.randomUUID()
        const title = msg.title || (msg.content.length > 30 ? msg.content.slice(0, 30) + '…' : msg.content)
        db.exec(
          'INSERT INTO conversations (id, title, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          [convId, title, msg.mode, now, now]
        )
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

      // Execute MoA with full history (history doesn't include the just-saved message)
      const config = getMoaConfig()
      const moaResult = await executeMoA({
        messages: [...historyMessages, { role: 'user', content: msg.content }],
        subModels: config.subModels,
        aggregator: config.aggregator || undefined,
        mode: (msg.mode === 'aggregate' ? 'aggregate' : 'compare') as 'aggregate' | 'compare' | 'direct',
        aggregationPromptVariant: config.aggregationPromptVariant
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
      const totalPT = moaResult.subOutputs.reduce((sum, o) => sum + (o.tokenUsage?.prompt || 0), 0)
      const totalCT = moaResult.subOutputs.reduce((sum, o) => sum + (o.tokenUsage?.completion || 0), 0)
      db.exec(
        `INSERT INTO request_logs (request_id, timestamp, client_ip, source, moa_mode, sub_count, prompt_tokens, completion_tokens, cost, duration_ms, success, error_detail)
         VALUES (?, ?, '127.0.0.1', 'chat', ?, ?, ?, ?, 0, ?, ?, ?)`,
        [logId, now, msg.mode, moaResult.subOutputs.length, totalPT, totalCT, logDuration, moaResult.success ? 1 : 0, moaResult.success ? null : (moaResult.error || null)]
      )

      // Fetch updated conversation list
      const conversations = db.query('SELECT * FROM conversations ORDER BY updated_at DESC')

      return { success: true, data: { conversationId: convId, moaResult, conversations } }
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

  // Create window
  createWindow()

  // Start proxy server
  const proxyApp = createProxyServer()
  try {
    await startProxyServer(proxyApp, DEFAULT_PORT, DEFAULT_HOST)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Main] Proxy server failed to start:', msg)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  stopProxyServer()
  getDatabase().flush()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
