import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import type { LiveSubOutput } from '../store/conversationStore'
import { MOA_ROLE_LABELS } from '../../../shared/moaRoles'
import type { SubModelRole } from '../../../shared/types'

const STATUS_ICON: Record<string, string> = {
  pending: '○',
  running: '◐',
  success: '✓',
  error: '✗'
}

const STATUS_COLOR: Record<string, string> = {
  pending: 'text-muted-foreground',
  running: 'text-blue-500',
  success: 'text-green-500',
  error: 'text-red-500'
}

/**
 * 子模型输出面板（T5 流式化）：
 * - memo：单面板内容更新不重渲染其余面板（store 只替换变化的 index 对象）
 * - running 且 content 非空 → markdown + 闪烁光标（与 AggregatorPanel 光标样式一致）
 * - error 且 content 非空 → 展示已流出内容 + 错误行（流中途断开时保留已收文本）
 */
function SubModelPanel({ output }: { output: LiveSubOutput }) {
  const isRunningOrPending = output.status === 'running' || (output.status === 'pending' && output.modelId === '...')
  const shortModelName = output.modelId.length > 30
    ? output.modelId.slice(0, 27) + '…'
    : output.modelId
  const roleLabel = output.role ? MOA_ROLE_LABELS[output.role as SubModelRole] : ''

  return (
    <div className={`
      rounded-lg border bg-card text-base overflow-hidden
      ${output.status === 'error' ? 'border-red-500/30' : 'border-border'}
      ${isRunningOrPending ? 'ring-1 ring-blue-500/20' : ''}
    `}>
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-muted/30">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`font-mono text-sm ${STATUS_COLOR[output.status]}`}>
            {STATUS_ICON[output.status]}
          </span>
          <span className="text-sm font-medium text-foreground truncate" title={output.modelId}>
            #{output.index + 1} {shortModelName}
          </span>
          {roleLabel && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary shrink-0">
              {roleLabel}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground shrink-0">
          {output.durationMs != null && (
            <span>{(output.durationMs / 1000).toFixed(1)}s</span>
          )}
          {output.status === 'pending' && (
            <span className="animate-pulse">等待中</span>
          )}
          {output.status === 'running' && (
            <span className="animate-pulse">运行中</span>
          )}
        </div>
      </div>

      <div className="px-3 py-2 max-h-60 overflow-y-auto">
        {output.status === 'error' && !output.content ? (
          <div className="text-sm text-red-400 font-mono whitespace-pre-wrap">{output.error}</div>
        ) : output.content ? (
          <>
            <div className="prose dark:prose-invert max-w-none text-sm">
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                {output.content}
              </ReactMarkdown>
              {output.status === 'running' && (
                <span className="inline-block w-2 h-4 bg-foreground/60 ml-0.5 animate-pulse" />
              )}
            </div>
            {output.status === 'error' && output.error && (
              <div className="mt-1.5 text-sm text-red-400 font-mono whitespace-pre-wrap">{output.error}</div>
            )}
          </>
        ) : (
          <div className="text-sm text-muted-foreground">
            {output.status === 'pending' ? '等待调度...' : output.status === 'running' ? '接收中...' : '无输出内容'}
          </div>
        )}
      </div>

      {output.tokenUsage && (
        <div className="px-3 py-1 border-t border-border text-sm text-muted-foreground">
          ↑{output.tokenUsage.prompt} ↓{output.tokenUsage.completion}
        </div>
      )}
    </div>
  )
}

export default React.memo(SubModelPanel)
