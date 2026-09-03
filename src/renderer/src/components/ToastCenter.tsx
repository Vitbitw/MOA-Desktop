// ─── 全局悬浮通知容器（右下角堆叠）───
import React from 'react'
import { Info, AlertTriangle, CheckCircle2, AlertCircle, X } from 'lucide-react'
import { useNotificationStore } from '../store/notificationStore'
import type { ToastType } from '../store/notificationStore'

const ICON_CLASS: Record<ToastType, string> = {
  info: 'text-primary',
  warning: 'text-amber-500',
  success: 'text-emerald-500',
  error: 'text-destructive'
}

function ToastIcon({ type }: { type: ToastType }) {
  if (type === 'warning') return <AlertTriangle className="shrink-0" />
  if (type === 'success') return <CheckCircle2 className="shrink-0" />
  if (type === 'error') return <AlertCircle className="shrink-0" />
  return <Info className="shrink-0" />
}

export default function ToastCenter() {
  const toasts = useNotificationStore((s) => s.toasts)
  const dismiss = useNotificationStore((s) => s.dismiss)

  if (toasts.length === 0) return null

  return (
    // 用内联 style 精确控制右间距（21px = 原 right-4 16px 向左 5px，避开滚动条）
    <div className="fixed bottom-4 z-[100] flex flex-col items-end gap-2 pointer-events-none" style={{ right: 21 }}>
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className="toast-item pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-card/95 px-3.5 py-2.5 shadow-xl backdrop-blur max-w-xs"
        >
          <span className={`mt-0.5 ${ICON_CLASS[t.type]}`}>
            <ToastIcon type={t.type} />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground leading-snug">{t.title}</div>
            {t.message && (
              <div className="text-xs text-muted-foreground mt-0.5 leading-snug">{t.message}</div>
            )}
          </div>
          <button
            onClick={() => dismiss(t.id)}
            className="p-0.5 -m-1 rounded text-muted-foreground hover:text-foreground shrink-0"
            title="关闭提示"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}