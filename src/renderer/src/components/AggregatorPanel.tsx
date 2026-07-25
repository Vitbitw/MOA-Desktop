import React, { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'

export default function AggregatorPanel({
  content,
  running,
  mode
}: {
  content: string
  running: boolean
  mode: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [content])

  const modeLabel =
    mode === 'aggregate' ? 'Aggregated' :
    mode === 'compare' ? 'Compare (D)' :
    'Direct'

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/20">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-foreground">
            {modeLabel}
          </span>
          {running && (
            <span className="flex items-center gap-1 text-xs text-blue-500">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
              生成中...
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {content.length > 0 && `${content.length} chars`}
        </div>
      </div>

      {/* Content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
        {content ? (
          <div className="prose prose-sm dark:prose-invert max-w-none leading-relaxed">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
              {content}
            </ReactMarkdown>
            {running && (
              <span className="inline-block w-2 h-4 bg-foreground/60 ml-0.5 animate-pulse" />
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
            {running ? (
              <span className="animate-pulse">等待子模型输出完成...</span>
            ) : (
              <span>聚合输出将在此显示</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
