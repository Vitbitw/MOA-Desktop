import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import type { LiveSubOutput } from '../store/conversationStore'

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

export default function SubModelPanel({ output }: { output: LiveSubOutput }) {
  const isRunningOrPending = output.status === 'running' || (output.status === 'pending' && output.modelId === '...')
  const shortModelName = output.modelId.length > 30
    ? output.modelId.slice(0, 27) + '…'
    : output.modelId

  return (
    <div className={`
      rounded-lg border bg-card text-sm overflow-hidden
      ${output.status === 'error' ? 'border-red-500/30' : 'border-border'}
      ${isRunningOrPending ? 'ring-1 ring-blue-500/20' : ''}
    `}>
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-muted/30">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`font-mono text-xs ${STATUS_COLOR[output.status]}`}>
            {STATUS_ICON[output.status]}
          </span>
          <span className="text-xs font-medium text-foreground truncate" title={output.modelId}>
            #{output.index + 1} {shortModelName}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
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
        {output.status === 'error' ? (
          <div className="text-xs text-red-400 font-mono whitespace-pre-wrap">{output.error}</div>
        ) : output.content ? (
          <div className="prose prose-sm dark:prose-invert max-w-none text-xs">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
              {output.content}
            </ReactMarkdown>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            {output.status === 'pending' ? '等待调度...' : output.status === 'running' ? '接收中...' : '无输出内容'}
          </div>
        )}
      </div>

      {output.tokenUsage && (
        <div className="px-3 py-1 border-t border-border text-xs text-muted-foreground">
          ↑{output.tokenUsage.prompt} ↓{output.tokenUsage.completion}
        </div>
      )}
    </div>
  )
}
