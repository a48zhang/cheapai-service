/** In-memory conversation projection; DSH remains the durable history owner. */

import type {
  SessionAssistantStreamBaseline,
  SessionAssistantStreamFrame,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  SessionEventLike,
  SessionEventLikeEntry,
  SessionJournalChange,
} from '@deepseek-ai/dsh-api-session-controller/client'
import {
  AssistantStreamAccumulator,
  expandAssistantStream,
  type AssistantStreamRecord,
  type TimedStreamChunk,
} from '@deepseek-ai/dsh-llm/assistant-stream'
import {
  sameSessionScope,
  type ConversationSessionId,
  type SessionScope,
} from './session-store'

type DurableSessionEvent = Extract<SessionEventLikeEntry, { readonly type: 'event' }>['event']
type UserMessageEvent = Extract<DurableSessionEvent, { readonly type: 'user/message' }>
type AssistantMessageEvent = Extract<DurableSessionEvent, { readonly type: 'assistant/message' }>
type AssistantAttemptId = Extract<SessionAssistantStreamFrame, { readonly type: 'start' }>['attemptId']
type AssistantSettlementType = 'assistant/message' | 'assistant/attempt'

export interface UserMessageProjection {
  readonly id: string
  readonly seq: number
  readonly role: 'user'
  readonly status: 'complete'
  readonly event: UserMessageEvent
  readonly message: UserMessageEvent['data']
}

export interface AssistantMessageProjection {
  readonly id: string
  readonly seq: number
  readonly role: 'assistant'
  readonly status: 'complete' | 'interrupted'
  readonly event: AssistantMessageEvent
  readonly message: AssistantMessageEvent['data']['message']
}

export type ConversationMessageProjection = UserMessageProjection | AssistantMessageProjection

/** One Host-owned Assistant attempt while its durable settlement is pending. */
export interface ActiveAssistantProjection {
  readonly attemptId: AssistantAttemptId
  readonly turn: number
  readonly step: number
  readonly nextIndex: number
  readonly status: 'streaming' | 'settling'
  readonly settlement: {
    readonly eventType: AssistantSettlementType
    readonly seq: number
  } | null
  /** Compact public DSH LLM records; chunk boundaries and timestamps are retained. */
  readonly stream: readonly AssistantStreamRecord[]
  /** Expanded timed DSH chunks for a renderer that assembles the live body. */
  readonly chunks: readonly TimedStreamChunk[]
}

export type MessageHistoryStatus = 'idle' | 'opening' | 'ready' | 'reconnecting' | 'error'

/** Cached immutable external-store value for one selected Session. */
export interface MessageStoreSnapshot {
  readonly scope: SessionScope | null
  readonly sessionId: ConversationSessionId | null
  readonly historyStatus: MessageHistoryStatus
  readonly error: unknown | null
  /** Original pinned DSH event entries, including every tool and lifecycle event. */
  readonly events: readonly SessionEventLikeEntry[]
  /** Convenience rows for real durable user/assistant message events. */
  readonly messages: readonly ConversationMessageProjection[]
  /** Exact durable tool events for U07 grouping and interaction rendering. */
  readonly toolEvents: readonly SessionEventLikeEntry[]
  /** Current DSH active attempt; kept apart from committed message rows. */
  readonly activeAssistant: ActiveAssistantProjection | null
  /** Tail cursor of the published durable window; transient chunks never advance it. */
  readonly durableCursor: number
  readonly hasOlder: boolean
  readonly loadingOlder: boolean
  /** Authoritative DSH SessionSummary.running value when present. */
  readonly running: boolean
  /** Draft is scoped to account, workspace, and Session identity, not Runtime generation. */
  readonly draft: string
}

const EMPTY_EVENTS: readonly SessionEventLikeEntry[] = Object.freeze([])
const EMPTY_MESSAGES: readonly ConversationMessageProjection[] = Object.freeze([])
const EMPTY_TOOL_EVENTS: readonly SessionEventLikeEntry[] = Object.freeze([])

interface MutableAssistantAttempt {
  readonly attemptId: AssistantAttemptId
  readonly turn: number
  readonly step: number
  readonly startedAfterSeq: number
  readonly accumulator: AssistantStreamAccumulator
  nextIndex: number
  settlement: ActiveAssistantProjection['settlement']
}

/**
 * Owns only renderer-facing memory. Snapshot/follow/page reconciliation remains
 * in DSH's SessionEventStream and assistant chunks use DSH's LLM accumulator.
 */
export class MessageStore {
  private snapshot: MessageStoreSnapshot = Object.freeze({
    scope: null,
    sessionId: null,
    historyStatus: 'idle',
    error: null,
    events: EMPTY_EVENTS,
    messages: EMPTY_MESSAGES,
    toolEvents: EMPTY_TOOL_EVENTS,
    activeAssistant: null,
    durableCursor: -1,
    hasOlder: false,
    loadingOlder: false,
    running: false,
    draft: '',
  })

  private readonly listeners = new Set<() => void>()
  private readonly drafts = new Map<string, string>()
  private activeAttempt: MutableAssistantAttempt | null = null

  readonly getSnapshot = (): MessageStoreSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Select one UI projection scope. Generation changes clear history but retain that Session's draft. */
  activate(scope: SessionScope | null, sessionId: ConversationSessionId | null, running = false): void {
    const nextScope = scope === null ? null : Object.freeze({ ...scope })
    if (sameSessionScope(this.snapshot.scope, nextScope)
      && this.snapshot.sessionId === sessionId) {
      if (this.snapshot.running !== running) this.publish({ ...this.snapshot, running })
      return
    }
    this.activeAttempt = null
    const draft = nextScope === null ? '' : this.readDraft(nextScope, sessionId)
    this.publish({
      scope: nextScope,
      sessionId,
      historyStatus: sessionId === null ? 'idle' : 'opening',
      error: null,
      events: EMPTY_EVENTS,
      messages: EMPTY_MESSAGES,
      toolEvents: EMPTY_TOOL_EVENTS,
      activeAssistant: null,
      durableCursor: -1,
      hasOlder: false,
      loadingOlder: false,
      running,
      draft,
    })
  }

  isCurrent(scope: SessionScope, sessionId: ConversationSessionId): boolean {
    return sameSessionScope(this.snapshot.scope, scope) && this.snapshot.sessionId === sessionId
  }

  setRunning(scope: SessionScope, sessionId: ConversationSessionId, running: boolean): void {
    if (!this.isCurrent(scope, sessionId) || this.snapshot.running === running) return
    this.publish({ ...this.snapshot, running })
  }

  setDraft(value: string): void {
    this.setDraftFor(this.snapshot.scope, this.snapshot.sessionId, value)
  }

  setDraftFor(
    scope: SessionScope | null,
    sessionId: ConversationSessionId | null,
    value: string,
  ): void {
    if (typeof value !== 'string') throw new TypeError('Conversation draft must be a string')
    if (scope !== null) {
      this.drafts.set(draftKey(scope, sessionId), value)
    }
    if (sameSessionScope(scope, this.snapshot.scope)
      && sessionId === this.snapshot.sessionId
      && value !== this.snapshot.draft) {
      this.publish({ ...this.snapshot, draft: value })
    }
  }

  /** Clear one draft only when it still equals the value captured by an accepted send. */
  clearDraftFor(
    scope: SessionScope | null,
    sessionId: ConversationSessionId | null,
    expectedValue: string,
  ): boolean {
    if (typeof expectedValue !== 'string') throw new TypeError('Expected conversation draft must be a string')
    if (scope === null) return false
    const key = draftKey(scope, sessionId)
    if (this.drafts.get(key) !== expectedValue) return false
    this.drafts.delete(key)
    if (sameSessionScope(scope, this.snapshot.scope)
      && sessionId === this.snapshot.sessionId
      && this.snapshot.draft === expectedValue) {
      this.publish({ ...this.snapshot, draft: '' })
    }
    return true
  }

  /** Delete in-memory draft references for an account after a confirmed account switch. */
  clearDraftsForAccount(accountId: string): void {
    if (typeof accountId !== 'string' || accountId.length === 0) {
      throw new TypeError('Account id must be non-empty')
    }
    for (const key of this.drafts.keys()) {
      try {
        const decoded: unknown = JSON.parse(key)
        if (Array.isArray(decoded) && decoded[0] === accountId) this.drafts.delete(key)
      } catch {
        // Keys are internal JSON tuples; ignore only any corrupted private entry.
      }
    }
    if (this.snapshot.scope?.accountId === accountId) this.activate(null, null)
  }

  setHistoryStatus(
    scope: SessionScope,
    sessionId: ConversationSessionId,
    historyStatus: MessageHistoryStatus,
    error: unknown | null = null,
  ): void {
    if (!this.isCurrent(scope, sessionId)) return
    this.publish({ ...this.snapshot, historyStatus, error })
  }

  setOlderLoading(scope: SessionScope, sessionId: ConversationSessionId, loadingOlder: boolean): void {
    if (!this.isCurrent(scope, sessionId) || this.snapshot.loadingOlder === loadingOlder) return
    this.publish({ ...this.snapshot, loadingOlder })
  }

  /** Consume only changes already validated and cursor-ordered by DSH SessionEventStream. */
  applyJournalChange(
    scope: SessionScope,
    sessionId: ConversationSessionId,
    change: SessionJournalChange,
  ): 'applied' | 'reopen' {
    if (!this.isCurrent(scope, sessionId)) return 'applied'
    switch (change.type) {
      case 'replace': {
        const entries = Object.freeze([...change.entries])
        try {
          this.activeAttempt = restoreAttempt(change.page.assistantStream)
        } catch (error: unknown) {
          this.activeAttempt = null
          this.publish({
            ...this.snapshot,
            historyStatus: 'reconnecting',
            error,
          })
          return 'reopen'
        }
        const durableCursor = Math.max(
          tailCursor(entries),
          this.activeAttempt?.startedAfterSeq ?? -1,
        )
        this.publish({
          ...this.snapshot,
          historyStatus: 'ready',
          error: null,
          events: entries,
          messages: projectMessages(sessionId, entries),
          toolEvents: projectToolEvents(entries),
          activeAssistant: projectAttempt(this.activeAttempt),
          durableCursor,
          hasOlder: change.hasMore,
          loadingOlder: false,
        })
        return 'applied'
      }
      case 'prepend': {
        const entries = Object.freeze([...change.entries, ...this.snapshot.events])
        this.publish({
          ...this.snapshot,
          historyStatus: 'ready',
          error: null,
          events: entries,
          messages: projectMessages(sessionId, entries),
          toolEvents: projectToolEvents(entries),
          hasOlder: change.hasMore,
          loadingOlder: false,
        })
        return 'applied'
      }
      case 'append': {
        const entry = change.entry
        const seq = entry.event.seq
        if (this.snapshot.events.some(existing => existing.event.seq === seq)) return 'applied'
        const entries = Object.freeze([...this.snapshot.events, entry])
        if (isSettledActiveAttempt(this.activeAttempt, entry)) this.activeAttempt = null
        this.publish({
          ...this.snapshot,
          historyStatus: 'ready',
          error: null,
          events: entries,
          messages: projectMessages(sessionId, entries),
          toolEvents: projectToolEvents(entries),
          activeAssistant: projectAttempt(this.activeAttempt),
          durableCursor: Math.max(this.snapshot.durableCursor, seq),
        })
        return 'applied'
      }
      case 'assistant-stream':
        return this.applyAssistantFrame(change.frame)
    }
  }

  private applyAssistantFrame(
    frame: SessionAssistantStreamFrame,
  ): 'applied' | 'reopen' {
    const current = this.activeAttempt
    switch (frame.type) {
      case 'start':
        if (current !== null) {
          this.activeAttempt = null
          this.publish({ ...this.snapshot, activeAssistant: null, historyStatus: 'reconnecting' })
          return 'reopen'
        }
        this.activeAttempt = {
          attemptId: frame.attemptId,
          turn: frame.turn,
          step: frame.step,
          startedAfterSeq: frame.startedAfterSeq,
          accumulator: new AssistantStreamAccumulator(),
          nextIndex: 0,
          settlement: null,
        }
        break
      case 'chunk': {
        if (current === null || current.attemptId !== frame.attemptId) return 'applied'
        if (frame.index !== current.nextIndex || current.settlement !== null) {
          this.activeAttempt = null
          this.publish({ ...this.snapshot, activeAssistant: null, historyStatus: 'reconnecting' })
          return 'reopen'
        }
        try {
          current.accumulator.push({
            time: frame.time,
            chunk: frame.chunk as unknown as TimedStreamChunk['chunk'],
          })
        } catch (error: unknown) {
          this.activeAttempt = null
          this.publish({ ...this.snapshot, activeAssistant: null, historyStatus: 'reconnecting', error })
          return 'reopen'
        }
        current.nextIndex += 1
        break
      }
      case 'end':
        if (current === null || current.attemptId !== frame.attemptId) return 'applied'
        if (frame.index !== current.nextIndex) {
          this.activeAttempt = null
          this.publish({ ...this.snapshot, activeAssistant: null, historyStatus: 'reconnecting' })
          return 'reopen'
        }
        if (frame.outcome.kind === 'abandoned') {
          this.activeAttempt = null
          break
        }
        current.settlement = Object.freeze({
          eventType: frame.outcome.eventType,
          seq: frame.outcome.seq,
        })
        break
    }
    this.publish({
      ...this.snapshot,
      historyStatus: 'ready',
      error: null,
      activeAssistant: projectAttempt(this.activeAttempt),
    })
    return 'applied'
  }

  private readDraft(scope: SessionScope, sessionId: ConversationSessionId | null): string {
    return this.drafts.get(draftKey(scope, sessionId)) ?? ''
  }

  private publish(next: MessageStoreSnapshot): void {
    this.snapshot = Object.freeze(next)
    for (const listener of this.listeners) listener()
  }
}

function restoreAttempt(baseline: SessionAssistantStreamBaseline | undefined): MutableAssistantAttempt | null {
  const opening = baseline?.activeAttempt
  if (opening === undefined) return null
  if (!Number.isSafeInteger(opening.nextIndex) || opening.nextIndex < 0) {
    throw new TypeError('DSH assistant opening baseline has an invalid chunk cursor')
  }
  const accumulator = new AssistantStreamAccumulator()
  const chunks = expandAssistantStream(opening.stream as readonly AssistantStreamRecord[])
  if (chunks.length !== opening.nextIndex) {
    throw new TypeError('DSH assistant opening baseline does not match its chunk cursor')
  }
  for (const chunk of chunks) accumulator.push(chunk)
  return {
    attemptId: opening.attemptId,
    turn: opening.turn,
    step: opening.step,
    startedAfterSeq: opening.startedAfterSeq,
    accumulator,
    nextIndex: opening.nextIndex,
    settlement: null,
  }
}

function projectAttempt(attempt: MutableAssistantAttempt | null): ActiveAssistantProjection | null {
  if (attempt === null) return null
  const stream = attempt.accumulator.snapshot()
  return Object.freeze({
    attemptId: attempt.attemptId,
    turn: attempt.turn,
    step: attempt.step,
    nextIndex: attempt.nextIndex,
    status: attempt.settlement === null ? 'streaming' : 'settling',
    settlement: attempt.settlement,
    stream,
    chunks: expandAssistantStream(stream),
  })
}

function isSettledActiveAttempt(
  attempt: MutableAssistantAttempt | null,
  entry: Extract<SessionEventLikeEntry, { readonly type: 'event' }>,
): boolean {
  if (attempt === null) return false
  const event = entry.event
  if ((event.type === 'assistant/message' || event.type === 'assistant/attempt')
    && attempt.turn === event.data.turn
    && attempt.step === event.data.step) return true
  return attempt.settlement !== null
    && attempt.settlement.seq === event.seq
    && attempt.settlement.eventType === event.type
}

function projectMessages(
  sessionId: ConversationSessionId,
  entries: readonly SessionEventLikeEntry[],
): readonly ConversationMessageProjection[] {
  const messages: ConversationMessageProjection[] = []
  for (const entry of entries) {
    if (entry.type !== 'event') continue
    const event = entry.event
    if (event.type === 'user/message') {
      messages.push(Object.freeze({
        id: `${sessionId}:${String(event.seq)}`,
        seq: event.seq,
        role: 'user',
        status: 'complete',
        event,
        message: event.data,
      }))
    } else if (event.type === 'assistant/message') {
      messages.push(Object.freeze({
        id: `${sessionId}:${String(event.seq)}`,
        seq: event.seq,
        role: 'assistant',
        status: event.data.interrupted === true ? 'interrupted' : 'complete',
        event,
        message: event.data.message,
      }))
    }
  }
  return Object.freeze(messages)
}

function projectToolEvents(entries: readonly SessionEventLikeEntry[]): readonly SessionEventLikeEntry[] {
  return Object.freeze(entries.filter(entry => entry.type === 'event'
    && (entry.event.type === 'tool/call' || entry.event.type === 'tool/result')))
}

function tailCursor(entries: readonly SessionEventLikeEntry[]): number {
  let cursor = -1
  for (const entry of entries) {
    if (entry.type === 'event') cursor = Math.max(cursor, entry.event.seq)
  }
  return cursor
}

function draftKey(scope: SessionScope, sessionId: ConversationSessionId | null): string {
  return JSON.stringify([scope.accountId, scope.workspaceDirectory, sessionId])
}
