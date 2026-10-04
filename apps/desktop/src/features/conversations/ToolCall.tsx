import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'

type DurableSessionEvent = Extract<SessionEventLikeEntry, { readonly type: 'event' }>['event']

/** Pinned DSH event emitted when the model dispatches a tool call. */
export type ToolCallEvent = Extract<DurableSessionEvent, { readonly type: 'tool/call' }>

/** Pinned DSH event emitted when a tool call settles. */
export type ToolResultEvent = Extract<DurableSessionEvent, { readonly type: 'tool/result' }>

type ToolEvent = ToolCallEvent | ToolResultEvent
type ToolEventEntry = Extract<SessionEventLikeEntry, { readonly type: 'event' }> & {
  readonly event: ToolEvent
}

export interface ToolCallProps {
  /** One unchanged durable DSH tool event from the selected Session journal. */
  readonly entry: SessionEventLikeEntry
  /** The current durable tool window, used to join a call to its result by DSH callId. */
  readonly events?: readonly SessionEventLikeEntry[]
  /** Reopen a currently pending DSH interaction correlated with this tool call. */
  readonly onOpenInteraction?: (callId: string) => void
}

function asToolEntry(entry: SessionEventLikeEntry): ToolEventEntry | undefined {
  if (entry.type !== 'event') return undefined
  return entry.event.type === 'tool/call' || entry.event.type === 'tool/result'
    ? entry as ToolEventEntry
    : undefined
}

function toolCallId(event: ToolEvent): string {
  return event.type === 'tool/call'
    ? String(event.data.callId)
    : String(event.data.message.source.callId)
}

function matchingResult(
  callId: string,
  entries: readonly SessionEventLikeEntry[] | undefined,
): ToolResultEvent | undefined {
  if (entries === undefined) return undefined
  for (const entry of entries) {
    const toolEntry = asToolEntry(entry)
    if (toolEntry?.event.type === 'tool/result' && toolCallId(toolEntry.event) === callId) {
      return toolEntry.event
    }
  }
  return undefined
}

function matchingCall(
  callId: string,
  entries: readonly SessionEventLikeEntry[] | undefined,
): ToolCallEvent | undefined {
  if (entries === undefined) return undefined
  for (const entry of entries) {
    const toolEntry = asToolEntry(entry)
    if (toolEntry?.event.type === 'tool/call' && toolCallId(toolEntry.event) === callId) {
      return toolEntry.event
    }
  }
  return undefined
}

function resultFailed(result: ToolResultEvent): boolean {
  return result.data.error !== undefined
    || result.data.message.isError === true
}

function detailText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Render the pinned DSH call/result pair with native disclosure semantics. */
export function ToolCall({ entry, events, onOpenInteraction }: ToolCallProps) {
  const toolEntry = asToolEntry(entry)
  if (toolEntry === undefined) return null

  const event = toolEntry.event
  const callId = toolCallId(event)
  const call = event.type === 'tool/call' ? event : matchingCall(callId, events)
  const result = event.type === 'tool/result' ? event : matchingResult(callId, events)

  // A matching result is rendered inside its call row. If the current window
  // starts after the call, keep the result visible with its genuine call id.
  if (event.type === 'tool/result' && call !== undefined) return null

  const name = call?.data.name ?? '工具结果'
  const state = result === undefined ? '运行中' : resultFailed(result) ? '失败' : '已完成'
  const summary = call === undefined
    ? `${name} · ${callId}`
    : `${name} · ${state}`

  return (
    <article
      aria-label={`工具调用 ${name}，${state}`}
      className="conversation-tool-call"
      data-call-id={callId}
      data-tool-name={name}
    >
      <details>
        <summary>
          <span>{name}</span>
          <span aria-label="状态">{state}</span>
          <span className="conversation-tool-call__summary">{summary}</span>
        </summary>
        <dl>
          <dt>调用 ID</dt>
          <dd><code>{callId}</code></dd>
          {call !== undefined && (
            <>
              <dt>输入</dt>
              <dd><pre><code>{call.data.arguments}</code></pre></dd>
            </>
          )}
          {result !== undefined && (
            <>
              <dt>输出</dt>
              <dd><pre><code>{detailText(result.data.message.content)}</code></pre></dd>
              {result.data.error?.reason !== undefined && (
                <>
                  <dt>错误</dt>
                  <dd>{result.data.error.reason}</dd>
                </>
              )}
              {result.data.meta !== undefined && (
                <>
                  <dt>工具详情</dt>
                  <dd><pre><code>{detailText(result.data.meta)}</code></pre></dd>
                </>
              )}
            </>
          )}
        </dl>
      </details>
      {onOpenInteraction !== undefined && call !== undefined && (
        <button
          type="button"
          onClick={() => onOpenInteraction(callId)}
        >
          查看待处理交互
        </button>
      )}
    </article>
  )
}

export default ToolCall
