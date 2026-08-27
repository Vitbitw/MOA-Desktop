import { app, BrowserWindow, Menu, screen } from 'electron'
import path from 'path'
import { getDatabase } from '../db/database'
import { IPC_EVENT } from '../../shared/ipc-channels'
import type { AppSettings } from '../../shared/types'

// ── 桌面用量悬浮窗（极简数字徽章）──
// 无边框、透明、置顶、不占任务栏；显示今日/总计的 ↑/↓ tokens 与费用。
// 数据策略：主进程广播 USAGE_UPDATED（无参信号）后，悬浮窗渲染端自行
// 调用 getUsageToday() / getUsageSummary() 拉取数据，复用现有 IPC 通道。

const OVERLAY_WIDTH = 96
const OVERLAY_HEIGHT = 104
const EDGE_MARGIN = 16

let usageWin: BrowserWindow | null = null

// 「打开用量页」回调：由 index.ts 注入（避免 usageWindow 反向 import index.ts 造成循环依赖）
let openUsageHandler: (() => void) | null = null

/** 设置「打开用量页」回调（聚焦主窗口并通知渲染进程切换视图） */
export function setOpenUsageHandler(handler: (() => void) | null): void {
  openUsageHandler = handler
}

/** 获取悬浮窗引用（可能为 null） */
export function getUsageWindow(): BrowserWindow | null {
  return usageWin
}

/** 读取当前 app_settings（DB 最新值，避免读到旧快照）。 */
function readAppSettings(): Record<string, unknown> {
  try {
    const db = getDatabase()
    const row = db.queryOne<{ value: string }>("SELECT value FROM moa_config WHERE key = 'app_settings'")
    return row?.value ? JSON.parse(row.value) : {}
  } catch {
    return {}
  }
}

/** 原子 patch app_settings 的 display 段（读最新 → 合并 → 写回），避免与 SETTINGS_SET 并发互相覆盖。 */
function patchDisplay(patch: Record<string, unknown>): void {
  try {
    const db = getDatabase()
    const current = readAppSettings()
    const display = { ...(current.display as Record<string, unknown> | undefined), ...patch }
    db.exec(
      "INSERT OR REPLACE INTO moa_config (key, value, updated_at) VALUES ('app_settings', ?, ?)",
      [JSON.stringify({ ...current, display }), Date.now()]
    )
  } catch (err) {
    console.error('[UsageOverlay] 保存设置失败:', err)
  }
}

/** 保存悬浮窗位置到 app_settings（与 SETTINGS_SET handler 相同的持久化方式） */
function saveUsageOverlayPos(pos: { x: number; y: number }): void {
  patchDisplay({ usageOverlayPos: pos })
}

/** 设置 usageOverlay=false（隐藏悬浮窗时同步，用户可通过设置开关恢复） */
function saveUsageOverlayDisabled(): void {
  patchDisplay({ usageOverlay: false })
}

/** 悬浮窗是否完整落在某个显示器的 workArea 内（越界判断） */
function isInsideSomeDisplay(pos: { x: number; y: number }): boolean {
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea
    return (
      pos.x >= wa.x &&
      pos.y >= wa.y &&
      pos.x + OVERLAY_WIDTH <= wa.x + wa.width &&
      pos.y + OVERLAY_HEIGHT <= wa.y + wa.height
    )
  })
}

/** 计算悬浮窗位置：优先恢复记忆位置，越界或缺失则回退主显示器右下角 */
function computePosition(settings: AppSettings): { x: number; y: number } {
  const saved = settings.display?.usageOverlayPos
  if (saved && isInsideSomeDisplay(saved)) {
    return saved
  }
  const wa = screen.getPrimaryDisplay().workArea
  return {
    x: wa.x + wa.width - OVERLAY_WIDTH - EDGE_MARGIN,
    y: wa.y + wa.height - OVERLAY_HEIGHT - EDGE_MARGIN
  }
}

/**
 * 创建悬浮窗。若已存在则直接显示（不重复创建）。
 */
export function createUsageWindow(settings: AppSettings): BrowserWindow | null {
  if (usageWin && !usageWin.isDestroyed()) {
    usageWin.show()
    return usageWin
  }

  const pos = computePosition(settings)

  usageWin = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 更强的置顶层级（macOS 生效；Windows 忽略 level 参数）
  if (process.platform === 'darwin') {
    usageWin.setAlwaysOnTop(true, 'screen-saver')
  }

  // 关闭时记录位置（destroy 不会触发 close 事件，退出菜单会先手动保存）
  usageWin.on('close', () => {
    if (usageWin && !usageWin.isDestroyed()) {
      const [x, y] = usageWin.getPosition()
      saveUsageOverlayPos({ x, y })
    }
    usageWin = null
  })

  // 右键菜单：打开用量页 / 隐藏悬浮窗 / 退出悬浮窗
  usageWin.webContents.on('context-menu', () => {
    const menu = Menu.buildFromTemplate([
      {
        label: '打开用量页',
        click: () => {
          openUsageHandler?.()
        }
      },
      {
        label: '隐藏悬浮窗',
        click: () => {
          hideUsageWindow()
        }
      },
      { type: 'separator' },
      {
        label: '退出悬浮窗',
        click: () => {
          // destroy 不触发 close 事件，先手动保存位置
          if (usageWin && !usageWin.isDestroyed()) {
            const [x, y] = usageWin.getPosition()
            saveUsageOverlayPos({ x, y })
          }
          destroyUsageWindow()
        }
      }
    ])
    menu.popup({ window: usageWin! })
  })

  // 加载页面：开发环境走 vite dev server，生产加载打包产物
  // 注：electron-vite 将主进程打包为 out/main/index.js 单文件，__dirname 即 out/main
  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    usageWin.loadURL('http://localhost:5173/usage.html')
  } else {
    usageWin.loadFile(path.join(__dirname, '../renderer/usage.html'))
  }

  return usageWin
}

/**
 * 隐藏悬浮窗（不销毁），并同步 usageOverlay=false 到设置。
 * 恢复途径：设置面板重新打开开关，或重启应用后开关仍为关闭需手动开启。
 */
export function hideUsageWindow(): void {
  usageWin?.hide()
  saveUsageOverlayDisabled()
}

/**
 * 销毁悬浮窗（触发 close 事件 → 保存位置）。
 */
export function destroyUsageWindow(): void {
  if (usageWin && !usageWin.isDestroyed()) {
    usageWin.close()
  }
  usageWin = null
}

/**
 * 同步用量更新：向悬浮窗发送 USAGE_UPDATED 无参信号，
 * 渲染端收到后自行重新拉取今日/总计数据。
 */
export function syncUsageWindow(): void {
  if (usageWin && !usageWin.isDestroyed()) {
    usageWin.webContents.send(IPC_EVENT.USAGE_UPDATED)
  }
}
