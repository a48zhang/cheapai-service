import { MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'

export type DisplayMessageRole = 'user' | 'assistant'

/** Minimal presentation input; the owner maps the pinned DSH projection into these fields. */
export interface MessageBodyProps {
  readonly role: DisplayMessageRole
  readonly text: string
  readonly streaming?: boolean
  readonly interrupted?: boolean
}

export const markdownLabels: MarkdownLabels = Object.freeze({
  code: {
    copyLabel: '复制代码',
    copiedLabel: '已复制',
  },
  footnotes: '脚注',
})

/** Render user text literally and assistant text with the pinned safe Markdown renderer. */
export function MessageBody({ role, text, streaming = false, interrupted = false }: MessageBodyProps) {
  if (role === 'user') {
    return <p className="conversation-message__plain-text">{text}</p>
  }

  return (
    <div className="conversation-message__assistant-content">
      {text.length > 0 && (
        <div className="conversation-message__markdown">
          <MarkdownText labels={markdownLabels} streaming={streaming} text={text} />
        </div>
      )}
      {streaming && text.length === 0 && (
        <p className="conversation-message__status" role="status">正在生成回答…</p>
      )}
      {interrupted && (
        <p className="conversation-message__status" role="status">此回复在完成前中断。</p>
      )}
    </div>
  )
}
