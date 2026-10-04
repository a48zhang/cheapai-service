import { describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import type { DshClient } from '../../apps/desktop/src/adapters/dsh/client'
import {
  ConversationEventProjection,
} from '../../apps/desktop/src/features/conversations/event-projection'
import { MessageStore } from '../../apps/desktop/src/features/conversations/message-store'
import {
  SessionStore,
  type ConversationSessionId,
  type SessionScope,
} from '../../apps/desktop/src/features/conversations/session-store'
import {
  appendJournalChange,
  prependJournalChange,
  replaceJournalChange,
  userMessageEntry,
} from './helpers/dsh-events'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

type EventStreamOptions = Parameters<DshClient['createEventStream']>[1]
type EventStreamAddress = Parameters<DshClient['createEventStream']>[0]

interface FakeEventStream {
  readonly address: EventStreamAddress
  readonly options: EventStreamOptions
  readonly open: ReturnType<typeof vi.fn>
  readonly prepend: ReturnType<typeof vi.fn>
  readonly restart: ReturnType<typeof vi.fn>
  readonly dispose: ReturnType<typeof vi.fn>
  readonly pendingPrepend: Deferred<void> | undefined
}

function fakeDshClient() {
  const streams: FakeEventStream[] = []
  const client = {
    createEventStream: (address: EventStreamAddress, options: EventStreamOptions) => {
      let pendingPrepend: Deferred<void> | undefined
      const stream: FakeEventStream = {
        address,
        options,
        open: vi.fn(async () => undefined),
        prepend: vi.fn(() => {
          const pending = deferred<void>()
          pendingPrepend = pending
          return pending.promise
        }),
        restart: vi.fn(),
        dispose: vi.fn(async () => undefined),
        get pendingPrepend() { return pendingPrepend },
      }
      streams.push(stream)
      return stream
    },
  } as unknown as DshClient
  return { client, streams }
}

function streamAt(streams: readonly FakeEventStream[], index: number): FakeEventStream {
  const stream = streams[index]
  if (stream === undefined) throw new Error(`Expected DSH event stream ${String(index)}`)
  return stream
}

function sessionSummary(sessionId: ConversationSessionId, cwd: string): SessionSummary {
  return {
    agentAvailable: true,
    sessionId,
    updatedAt: 1,
    running: false,
    blank: false,
    cwd,
  }
}

const sessionOne = 'fixture-session-one' as ConversationSessionId
const sessionTwo = 'fixture-session-two' as ConversationSessionId
const workspaceOne = '/fixture/workspace-one'
const workspaceTwo = '/fixture/workspace-two'

describe('desktop DSH conversation event projection', () => {
  it('keeps stable subscribed snapshots and drafts isolated by account, workspace, and Session', () => {
    const messages = new MessageStore()
    const scope: SessionScope = {
      accountId: 'fixture-account',
      workspaceDirectory: workspaceOne,
      connectionGeneration: 1,
    }
    const notifications: unknown[] = []
    const stop = messages.subscribe(() => notifications.push(messages.getSnapshot()))

    messages.activate(scope, sessionOne)
    const activated = messages.getSnapshot()
    expect(messages.getSnapshot()).toBe(activated)
    messages.setDraft('draft for session one')
    expect(messages.getSnapshot()).not.toBe(activated)
    expect(messages.getSnapshot().draft).toBe('draft for session one')
    expect(notifications).toHaveLength(2)

    messages.activate(scope, sessionTwo)
    expect(messages.getSnapshot().draft).toBe('')
    messages.setDraft('draft for session two')
    messages.activate(scope, sessionOne)
    expect(messages.getSnapshot().draft).toBe('draft for session one')

    messages.activate({ ...scope, workspaceDirectory: workspaceTwo }, sessionOne)
    expect(messages.getSnapshot().draft).toBe('')
    messages.activate(scope, sessionOne)
    expect(messages.getSnapshot().draft).toBe('draft for session one')

    messages.activate({ ...scope, connectionGeneration: 2 }, sessionOne)
    expect(messages.getSnapshot().draft).toBe('draft for session one')

    stop()
    const notificationCount = notifications.length
    messages.setDraft('after unsubscribe')
    expect(notifications).toHaveLength(notificationCount)
    expect(messages.getSnapshot().draft).toBe('after unsubscribe')
  })

  it('fences late old-session and old-generation callbacks, including an older-page completion', async () => {
    const scope: SessionScope = {
      accountId: 'fixture-account',
      workspaceDirectory: workspaceOne,
      connectionGeneration: 7,
    }
    const sessions = new SessionStore()
    sessions.setScope(scope)
    sessions.replaceSessions(scope, [
      sessionSummary(sessionOne, workspaceOne),
      sessionSummary(sessionTwo, workspaceOne),
    ])
    sessions.setActiveSession(scope, sessionOne)

    const messages = new MessageStore()
    const { client, streams } = fakeDshClient()
    const projection = new ConversationEventProjection(client, sessions, messages)
    const first = streamAt(streams, 0)
    expect(first.address).toMatchObject({ kind: 'session', sessionId: sessionOne })
    expect(first.open).toHaveBeenCalledTimes(1)

    first.options.publish(replaceJournalChange([userMessageEntry(40, 'session one')], true))
    expect(messages.getSnapshot().messages.map(message => message.message.content)).toEqual([
      [{ type: 'text', text: 'session one' }],
    ])
    expect(messages.getSnapshot().durableCursor).toBe(40)

    const olderPage = projection.loadOlder()
    expect(messages.getSnapshot().loadingOlder).toBe(true)
    const pendingPage = first.pendingPrepend
    if (pendingPage === undefined) throw new Error('The DSH page request did not start')

    sessions.setActiveSession(scope, sessionTwo)
    const second = streamAt(streams, 1)
    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(messages.getSnapshot()).toMatchObject({ sessionId: sessionTwo, events: [], loadingOlder: false })

    first.options.publish(appendJournalChange(userMessageEntry(41, 'late session one event')))
    first.options.publish(prependJournalChange([userMessageEntry(20, 'late older page')], false))
    pendingPage.resolve()
    await olderPage
    expect(messages.getSnapshot()).toMatchObject({ sessionId: sessionTwo, events: [], loadingOlder: false })

    second.options.publish(replaceJournalChange([userMessageEntry(90, 'session two')]))
    expect(messages.getSnapshot().messages.map(message => message.message.content)).toEqual([
      [{ type: 'text', text: 'session two' }],
    ])

    const nextGeneration: SessionScope = { ...scope, connectionGeneration: scope.connectionGeneration + 1 }
    sessions.setScope(nextGeneration)
    expect(messages.getSnapshot()).toMatchObject({ scope: nextGeneration, sessionId: null, events: [] })
    second.options.publish(appendJournalChange(userMessageEntry(91, 'late old generation')))
    expect(messages.getSnapshot().events).toEqual([])

    sessions.replaceSessions(nextGeneration, [sessionSummary(sessionTwo, workspaceOne)])
    sessions.setActiveSession(nextGeneration, sessionTwo)
    const third = streamAt(streams, 2)
    third.options.publish(replaceJournalChange([userMessageEntry(100, 'new generation')]))
    expect(messages.getSnapshot().messages.map(message => message.message.content)).toEqual([
      [{ type: 'text', text: 'new generation' }],
    ])

    await projection.dispose()
    expect(third.dispose).toHaveBeenCalledTimes(1)
  })
})
