/** Selected-Session owner for DSH snapshot/follow and older-page projection. */

import type { DshClient } from '../../adapters/dsh/client'
import type { SessionEventStream } from '../../adapters/dsh/client'
import type {
  ConversationSessionId,
  SessionStore,
  SessionScope,
} from './session-store'
import { MessageStore } from './message-store'

const OPENING_WINDOW = Object.freeze({
  maxMessages: 500,
  turnWindow: Object.freeze({ minMessages: 50, minTurns: 2 }),
})

/** Owns one SessionEventStream; all writes are fenced by SessionStore scope and generation. */
export class ConversationEventProjection {
  private readonly stopSessionStore: () => void
  private stream: SessionEventStream | undefined
  private generation = 0
  private disposed = false
  private activeScope: SessionScope | null = null
  private activeSessionId: ConversationSessionId | null = null

  constructor(
    private readonly client: DshClient,
    private readonly sessions: SessionStore,
    readonly messages: MessageStore,
  ) {
    this.stopSessionStore = sessions.subscribe(() => this.sync())
    this.sync()
  }

  /** Open older durable history through DSH's existing stream/page cursor owner. */
  async loadOlder(): Promise<void> {
    const stream = this.stream
    const scope = this.activeScope
    const sessionId = this.activeSessionId
    const snapshot = this.messages.getSnapshot()
    if (stream === undefined || scope === null || sessionId === null
      || !snapshot.hasOlder || snapshot.loadingOlder) return
    const first = snapshot.events.find(entry => entry.type === 'event')
    if (first === undefined) return

    const generation = this.generation
    this.messages.setOlderLoading(scope, sessionId, true)
    try {
      await stream.prepend({ beforeSeq: first.event.seq, ...OPENING_WINDOW })
    } catch (error: unknown) {
      if (this.isCurrent(generation, scope, sessionId)) {
        this.messages.setHistoryStatus(scope, sessionId, 'ready', error)
      }
    } finally {
      if (this.isCurrent(generation, scope, sessionId)) {
        this.messages.setOlderLoading(scope, sessionId, false)
      }
    }
  }

  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.disposed = true
    this.stopSessionStore()
    this.generation += 1
    const stream = this.stream
    this.stream = undefined
    this.activeScope = null
    this.activeSessionId = null
    this.messages.activate(null, null)
    return stream?.dispose() ?? Promise.resolve()
  }

  private sync(): void {
    if (this.disposed) return
    const snapshot = this.sessions.getSnapshot()
    const scope = snapshot.scope
    const sessionId = snapshot.activeSessionId
    const sameTarget = this.activeSessionId === sessionId
      && this.activeScope?.accountId === scope?.accountId
      && this.activeScope?.workspaceDirectory === scope?.workspaceDirectory
      && this.activeScope?.connectionGeneration === scope?.connectionGeneration
    if (sameTarget) {
      if (scope !== null && sessionId !== null) {
        const running = snapshot.sessions.find(item => item.sessionId === sessionId)?.running ?? false
        this.messages.setRunning(scope, sessionId, running)
      }
      return
    }

    const previous = this.stream
    this.stream = undefined
    const generation = ++this.generation
    this.activeScope = scope
    this.activeSessionId = sessionId
    void previous?.dispose()
    this.messages.activate(scope, sessionId,
      scope !== null && sessionId !== null
        ? snapshot.sessions.find(item => item.sessionId === sessionId)?.running ?? false
        : false)
    if (scope === null || sessionId === null) return

    const currentScope = scope
    const currentSessionId = sessionId
    const stream = this.client.createEventStream(
      { kind: 'session', sessionId },
      {
        publish: change => {
          if (!this.isCurrent(generation, currentScope, currentSessionId)) return
          if (this.messages.applyJournalChange(currentScope, currentSessionId, change) === 'reopen') {
            stream.restart()
          }
        },
        carrierFailed: () => {
          if (this.isCurrent(generation, currentScope, currentSessionId)) {
            this.messages.setHistoryStatus(currentScope, currentSessionId, 'reconnecting')
          }
        },
        failed: error => {
          if (this.isCurrent(generation, currentScope, currentSessionId)) {
            this.messages.setHistoryStatus(currentScope, currentSessionId, 'error', error)
          }
        },
      },
    )
    this.stream = stream
    this.messages.setHistoryStatus(currentScope, currentSessionId, 'opening')
    void stream.open(OPENING_WINDOW).catch(error => {
      if (this.isCurrent(generation, currentScope, currentSessionId)) {
        this.messages.setHistoryStatus(currentScope, currentSessionId, 'error', error)
      }
    })
  }

  private isCurrent(
    generation: number,
    scope: SessionScope,
    sessionId: ConversationSessionId,
  ): boolean {
    if (this.disposed || generation !== this.generation
      || this.activeSessionId !== sessionId
      || this.activeScope?.accountId !== scope.accountId
      || this.activeScope?.workspaceDirectory !== scope.workspaceDirectory
      || this.activeScope?.connectionGeneration !== scope.connectionGeneration) return false
    const current = this.sessions.getSnapshot()
    return current.activeSessionId === sessionId
      && current.scope?.accountId === scope.accountId
      && current.scope.workspaceDirectory === scope.workspaceDirectory
      && current.scope.connectionGeneration === scope.connectionGeneration
  }
}
