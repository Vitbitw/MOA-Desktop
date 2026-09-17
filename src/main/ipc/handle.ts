import { ipcMain, type IpcMainInvokeEvent } from 'electron'

/**
 * IPC handler 统一注册（防御边界规范 R2）。
 *
 * 边界职责收敛在此：捕获 handler 抛出的任何错误，转译成 `{ success: false, error }`
 * 返回渲染进程并统一记日志；handler 内部不再重复写 try/catch 模板。
 */

/** 标准包装：handler 返回裸数据 → `{ success: true, data }`。 */
export function handleIpc(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: any[]) => unknown
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { success: true, data: await fn(event, ...args) }
    } catch (err) {
      console.error(`[IPC] ${channel}:`, err)
      return { success: false, error: String(err) }
    }
  })
}

/**
 * 透传包装：handler 自行返回 `{ success, ... }` 特化形态（业务错误码 / 附加字段，
 * 如 title / conversations / code），包装器仅统一补错误兜底。
 */
export function handleIpcRaw(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: any[]) => unknown
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...args)
    } catch (err) {
      console.error(`[IPC] ${channel}:`, err)
      return { success: false, error: String(err) }
    }
  })
}
