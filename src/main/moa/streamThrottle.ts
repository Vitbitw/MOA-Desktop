// 节流推送器（纯 Node，零依赖）：把高频 push 合并成每 intervalMs 一波的 emit
// 固定窗口语义（throttle，非 debounce）：首个 push 启动计时器；窗口内多次 push 只保留最新值（覆盖）；
// 窗口到点若有 pending → emit 并清空；之后再有新值 → 起下一窗口（持续流时每 intervalMs 一波）；
// 无 pending 时计时器停止（不空转）。
// 调用约定（终态）：终态事件到达时调用 flush(终态值)——旧 pending 直接丢弃、计时器取消，
// 保证终态值之后绝不会再补发旧文本（否则 UI 会被打回旧内容）；终态用法 = flush(终值) + dispose()。
// 设计说明见 .hermes/plans/2026-09-18-moa-live-streaming.md §4.2

/** 默认推送间隔（毫秒）；app 内 IPC 与网关广播共用 */
export const STREAM_PUSH_INTERVAL_MS = 50

export interface ThrottledEmitter<T> {
  /** 记录最新值（覆盖旧 pending）；若计时器未运行，则安排 intervalMs 后的一次推送 */
  push(value: T): void
  /**
   * 立即推送并取消计时器（不自动重启，由调用方控制）：
   * - 传 value：emit(value)，旧 pending 丢弃（value 优先）
   * - 不传：有 pending 就 emit pending，没有则什么都不做
   */
  flush(value?: T): void
  /** 取消计时器、清空 pending；此后 push / flush 均为无操作 */
  dispose(): void
}

export function createThrottledEmitter<T>(intervalMs: number, emit: (value: T) => void): ThrottledEmitter<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  // 用对象包一层：T 可能包含 undefined，不能拿 undefined 当"无 pending"哨兵
  let pending: { value: T } | null = null
  let disposed = false

  const cancelTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const sendPending = (): void => {
    if (pending === null) return
    const value = pending.value
    pending = null
    emit(value)
  }

  return {
    push(value: T): void {
      if (disposed) return
      pending = { value }
      // 计时器只在"没有在跑"时启动：窗口内多次 push 合并成一次推送，且无 pending 时不会空转
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null
          sendPending()
        }, intervalMs > 0 ? intervalMs : 0)
      }
    },
    flush(value?: T): void {
      if (disposed) return
      const hasValue = arguments.length > 0 // 区分 flush() 与 flush(undefined)
      cancelTimer()
      if (hasValue) {
        pending = null // value 优先：旧 pending 丢弃，终态后不得补发
        emit(value as T)
        return
      }
      sendPending()
    },
    dispose(): void {
      disposed = true
      cancelTimer()
      pending = null
    }
  }
}
