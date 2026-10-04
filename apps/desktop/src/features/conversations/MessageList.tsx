import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { joinAssistantStreamText } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { Button } from '../../components/ui/controls'
import { MessageBody } from './MessageBody'
import type { ConversationMessageProjection, MessageStore } from './message-store'
import './conversation.css'

export interface MessageListProps {
  readonly store: MessageStore
  readonly onLoadOlder: () => void | Promise<void>
  /** The caller renders pinned DSH tool events through the U07 tool presentation. */
  readonly renderToolEvent?: (entry: SessionEventLikeEntry) => ReactNode
}

interface ViewportPosition {
  readonly target: string
  readonly firstSeq: number | null
  readonly lastSeq: number | null
  readonly eventCount: number
  readonly activeAttempt: string | null
  readonly scrollHeight: number
  readonly scrollTop: number
  readonly atBottom: boolean
}

type ViewportContext = Pick<ViewportPosition, 'target' | 'firstSeq' | 'lastSeq' | 'eventCount' | 'activeAttempt'>

const BOTTOM_THRESHOLD = 80

/** Renders the current DSH durable window and its one live assistant attempt. */
export function MessageList({ store, onLoadOlder, renderToolEvent }: MessageListProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const viewportRef = useRef<HTMLDivElement>(null)
  const viewportPositionRef = useRef<ViewportPosition | null>(null)
  const followLatestRef = useRef(true)
  const [showLatest, setShowLatest] = useState(false)
  const target = JSON.stringify([
    snapshot.scope?.accountId ?? null,
    snapshot.scope?.workspaceDirectory ?? null,
    snapshot.scope?.connectionGeneration ?? null,
    snapshot.sessionId ?? null,
  ])
  const firstSeq = snapshot.events.find(entry => entry.type === 'event')?.event.seq ?? null
  const lastSeq = [...snapshot.events].reverse().find(entry => entry.type === 'event')?.event.seq ?? null
  const activeAttempt = snapshot.activeAssistant === null
    ? `running:${snapshot.running}`
    : `${snapshot.activeAssistant.attemptId}:${snapshot.activeAssistant.nextIndex}:${snapshot.running}`
  const viewportContextRef = useRef<ViewportContext>({
    target,
    firstSeq,
    lastSeq,
    eventCount: snapshot.events.length,
    activeAttempt,
  })
  viewportContextRef.current = {
    target,
    firstSeq,
    lastSeq,
    eventCount: snapshot.events.length,
    activeAttempt,
  }

  const messagesBySeq = useMemo(
    () => new Map(snapshot.messages.map(message => [message.seq, message] as const)),
    [snapshot.messages],
  )

  const timeline: ReactNode[] = []
  for (const entry of snapshot.events) {
    if (entry.type !== 'event') continue
    const event = entry.event
    const message = messagesBySeq.get(event.seq)
    if (message !== undefined) {
      const text = visibleText(message)
      if (message.role === 'assistant' && text.length === 0 && message.status !== 'interrupted') {
        continue
      }
      timeline.push(
        <article
          aria-label={message.role === 'user' ? '用户消息' : '助手消息'}
          className={`conversation-message conversation-message--${message.role}`}
          data-seq={message.seq}
          key={message.id}
        >
          <span className="conversation-message__role">
            {message.role === 'user' ? '你' : '助手'}
          </span>
          <div className="conversation-message__body">
            <MessageBody
              interrupted={message.status === 'interrupted'}
              role={message.role}
              text={text || (message.role === 'user' && message.message.content.length > 0
                ? '（此消息包含附件或其他非文本内容）'
                : '')}
            />
          </div>
        </article>,
      )
      continue
    }

    if ((event.type === 'tool/call' || event.type === 'tool/result') && renderToolEvent !== undefined) {
      timeline.push(
        <div className="conversation-message__tool-slot" data-seq={event.seq} key={`tool:${event.seq}`}>
          {renderToolEvent(entry)}
        </div>,
      )
    }
  }

  const activeText = snapshot.activeAssistant === null
    ? ''
    : joinAssistantStreamText(snapshot.activeAssistant.stream)
  if (snapshot.activeAssistant !== null) {
    timeline.push(
      <article
        aria-label="助手正在生成的消息"
        className="conversation-message conversation-message--assistant"
        key={`active:${snapshot.activeAssistant.attemptId}`}
      >
        <span className="conversation-message__role">助手</span>
        <div className="conversation-message__body">
          <MessageBody
            role="assistant"
            streaming={snapshot.activeAssistant.status === 'streaming'}
            text={activeText}
          />
        </div>
      </article>,
    )
  } else if (snapshot.running) {
    timeline.push(
      <p className="conversation-message__status" key="running" role="status">正在运行…</p>,
    )
  }

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (viewport === null) return

    const previous = (viewportPositionRef.current ?? null)
    const changedTarget = previous === null || previous.target !== target
    const prepended = previous !== null
      && previous.target === target
      && previous.firstSeq !== null
      && firstSeq !== null
      && firstSeq < previous.firstSeq
      && snapshot.events.length > previous.eventCount
    const contentChanged = previous === null
      || previous.target !== target
      || previous.firstSeq !== firstSeq
      || previous.lastSeq !== lastSeq
      || previous.eventCount !== snapshot.events.length
      || previous.activeAttempt !== activeAttempt

    if (changedTarget) {
      viewport.scrollTop = viewport.scrollHeight
      followLatestRef.current = true
      setShowLatest(false)
    } else if (prepended && previous !== null) {
      const heightDelta = viewport.scrollHeight - previous.scrollHeight
      viewport.scrollTop = Math.max(0, previous.scrollTop + heightDelta)
      const atBottom = distanceFromBottom(viewport) <= BOTTOM_THRESHOLD
      followLatestRef.current = atBottom
      setShowLatest(!atBottom)
    } else if (contentChanged && previous !== null) {
      if (previous.atBottom && followLatestRef.current) {
        viewport.scrollTop = viewport.scrollHeight
        setShowLatest(false)
      } else {
        viewport.scrollTop = previous.scrollTop
        setShowLatest(true)
      }
    }

    rememberViewport(viewportPositionRef, viewport, viewportContextRef.current)
  }, [activeAttempt, firstSeq, lastSeq, snapshot.events, target])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (viewport === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (followLatestRef.current) {
        viewport.scrollTop = viewport.scrollHeight
        setShowLatest(false)
      }
      rememberViewport(viewportPositionRef, viewport, viewportContextRef.current)
    })
    observer.observe(viewport)
    if (viewport.firstElementChild !== null) observer.observe(viewport.firstElementChild)
    return () => observer.disconnect()
  }, [])

  function handleScroll(): void {
    const viewport = viewportRef.current
    if (viewport === null) return
    const atBottom = distanceFromBottom(viewport) <= BOTTOM_THRESHOLD
    followLatestRef.current = atBottom
    setShowLatest(!atBottom)
    rememberViewport(viewportPositionRef, viewport, viewportContextRef.current)
  }

  function goToLatest(): void {
    const viewport = viewportRef.current
    if (viewport === null) return
    followLatestRef.current = true
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' })
    setShowLatest(false)
  }

  const empty = timeline.length === 0
  const loadingInitialHistory = snapshot.historyStatus === 'opening' && snapshot.events.length === 0

  return (
    <section aria-label="对话内容" className="conversation-message-list">
      <div
        aria-label="消息记录"
        className="conversation-message-list__viewport"
        onScroll={handleScroll}
        ref={viewportRef}
        role="region"
      >
        <div className="conversation-message-list__timeline">
          {snapshot.hasOlder && (
            <Button
              disabled={snapshot.loadingOlder}
              onClick={() => { void onLoadOlder() }}
              variant="quiet"
            >
              {snapshot.loadingOlder ? '正在加载…' : '加载更早消息'}
            </Button>
          )}
          {snapshot.historyStatus === 'reconnecting' && (
            <p className="conversation-message-list__notice" role="status">正在重新连接并同步对话…</p>
          )}
          {snapshot.historyStatus === 'error' && (
            <p className="conversation-message-list__notice" role="alert">无法加载对话记录，请检查桌面服务连接后重试。</p>
          )}
          {snapshot.historyStatus === 'ready' && snapshot.error !== null && (
            <p className="conversation-message-list__notice" role="status">加载更早的消息失败，请稍后重试。</p>
          )}
          {loadingInitialHistory && (
            <p className="conversation-message-list__notice" role="status">正在加载对话记录…</p>
          )}
          {empty && !loadingInitialHistory && snapshot.historyStatus !== 'error' && (
            <p className="conversation-message-list__notice" role="status">
              {snapshot.sessionId === null
                ? '选择会话后，这里会显示消息。'
                : '这段对话还没有可显示的文本消息。'}
            </p>
          )}
          {timeline}
        </div>
      </div>
      {showLatest && (
        <Button
          className="conversation-message-list__latest"
          onClick={goToLatest}
          variant="secondary"
        >
          回到最新
        </Button>
      )}
    </section>
  )

}

function visibleText(message: ConversationMessageProjection): string {
  return message.message.content
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('')
}

function distanceFromBottom(viewport: HTMLDivElement): number {
  return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
}

function rememberViewport(
  positionRef: { current: ViewportPosition | null },
  viewport: HTMLDivElement,
  context: ViewportContext,
): void {
  positionRef.current = {
    ...context,
    scrollHeight: viewport.scrollHeight,
    scrollTop: viewport.scrollTop,
    atBottom: distanceFromBottom(viewport) <= BOTTOM_THRESHOLD,
  }
}
