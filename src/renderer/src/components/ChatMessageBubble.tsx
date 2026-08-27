import React, { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import type { ChatMessage, MoAMode, SubModelOutput } from '../../../shared/types'

/** 单条子模型输出的统一渲染（对比模式平铺 / 聚合模式折叠共用） */
function SubOutputItem({ out, index }: { out: SubModelOutput; index: number }) {
  return (
    <div className="text-xs p-2 rounded bg-background/50 border border-border/30">
      <div className="font-medium text-muted-foreground mb-1">
        #{index + 1} {out.modelId}
        {out.durationMs ? ` · ${out.durationMs}ms` : ''}
        <span className={`ml-1 ${out.status === 'success' ? 'text-green-500' : 'text-red-500'}`}>
          {out.status === 'success' ? '✓' : '✗'}
        </span>
      </div>
      {out.status === 'success' ? (
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
          {out.content.slice(0, 500)}
        </ReactMarkdown>
      ) : (
        <span className="text-red-400">{out.error}</span>
      )}
    </div>
  )
}

function ChatMessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user'
  // 模式跟随消息创建时的 mode，而非全局当前模式——全局切换模式时历史消息展示不会错乱
  const effectiveMode: MoAMode = msg.mode || 'aggregate'
  const subOutputs = msg.subModelOutputs || []
  const hasSub = subOutputs.length > 0

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm leading-relaxed ${
          isUser
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-foreground'
        }`}
      >
        {isUser ? (
          <pre className="whitespace-pre-wrap font-sans m-0">{msg.content}</pre>
        ) : (
          <>
            {/* 正文：聚合/直通模式渲染正文；对比模式由下方子模型展开区承载全部信息 */}
            {effectiveMode !== 'compare' || !hasSub ? (
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                  {msg.content}
                </ReactMarkdown>
              </div>
            ) : null}

            {/* 子模型输出：聚合模式折叠，对比/直通模式平铺 */}
            {hasSub && (
              effectiveMode === 'aggregate' ? (
                <details className="mt-2 pt-2 border-t border-border/50">
                  <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground select-none">
                    查看子模型输出 ({subOutputs.length})
                  </summary>
                  <div className="mt-1 space-y-2">
                    {subOutputs.map((out, i) => (
                      <SubOutputItem key={i} out={out} index={i} />
                    ))}
                  </div>
                </details>
              ) : (
                <div className="mt-2 pt-2 border-t border-border/50">
                  <p className="text-xs text-muted-foreground mb-2">
                    以下是 {subOutputs.length} 条模型输出的内容
                  </p>
                  <div className="space-y-2">
                    {subOutputs.map((out, i) => (
                      <SubOutputItem key={i} out={out} index={i} />
                    ))}
                  </div>
                </div>
              )
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default memo(ChatMessageBubble)