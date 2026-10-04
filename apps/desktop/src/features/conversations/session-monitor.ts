import type { DshClient } from '../../adapters/dsh/client'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote-events'

interface GenerationToken {
  readonly generation: unknown
  readonly abort: AbortController
  readonly unsubscribe: Array<() => void>
  pendingEvents: Array<() => void> | null
  refreshing: Promise<void> | undefined
  baselineKnown: boolean
}

const UNKNOWN_ACTIVITY = 'Session activity is unknown until the current connection is synchronized.'

/** Observe all account-local sessions, including tasks in other directories.
 * The global list is ephemeral; DSH remains the owner of every session.
 */
export class SessionActivityMonitor {
  private readonly sessions = new Map<SessionSummary['sessionId'], SessionSummary>()
  private readonly unsubscribe: Array<() => void> = []
  private activeGeneration: GenerationToken | undefined
  private disposed = false

  constructor(
    private readonly client: DshClient,
    private readonly callbacks: {
      readonly activity: (count: number) => void
      readonly sessionsChanged: () => void
      readonly failed: (error: unknown) => void
    },
  ) {
    this.unsubscribe.push(
      client.connection.generation.subscribe(() => {
        this.syncGeneration()
      }),
    )
    this.syncGeneration()
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.syncGeneration()
    const token = this.activeGeneration
    if (token === undefined) return Promise.resolve()
    return this.refreshGeneration(token)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.invalidateGeneration()
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe()
    this.sessions.clear()
  }

  private syncGeneration(): void {
    if (this.disposed) return
    const generation = this.client.connection.generation.getSnapshot()
    if (generation === undefined) {
      // Keep the last known activity while disconnected. A temporary loss is
      // not evidence that every Session stopped.
      const hadGeneration = this.activeGeneration !== undefined
      this.invalidateGeneration()
      if (hadGeneration) this.callbacks.failed(new Error(UNKNOWN_ACTIVITY))
      return
    }
    if (this.activeGeneration?.generation === generation) return
    this.invalidateGeneration()

    const token: GenerationToken = {
      generation,
      abort: new AbortController(),
      unsubscribe: [],
      pendingEvents: null,
      refreshing: undefined,
      baselineKnown: false,
    }
    this.activeGeneration = token
    const update = (apply: () => void): void => this.update(token, apply)
    token.unsubscribe.push(
      this.client.remote.$on('api-session/added', summary => update(() => {
        this.sessions.set(summary.sessionId, summary)
      })),
      this.client.remote.$on('api-session/removed', sessionId => update(() => {
        this.sessions.delete(sessionId)
      })),
      this.client.remote.$on('api-session/status', (sessionId, running) => update(() => {
        const summary = this.sessions.get(sessionId)
        if (summary !== undefined) this.sessions.set(sessionId, { ...summary, running })
      })),
      this.client.remote.$on('api-session/activity', (sessionId, updatedAt) => update(() => {
        const summary = this.sessions.get(sessionId)
        if (summary !== undefined) this.sessions.set(sessionId, { ...summary, updatedAt })
      })),
    )
    this.callbacks.failed(new Error(UNKNOWN_ACTIVITY))
    // Establish a fresh baseline immediately for every new Connection
    // generation. A previous generation's in-flight request is independent.
    void this.refreshGeneration(token)
  }

  private invalidateGeneration(): void {
    const token = this.activeGeneration
    if (token === undefined) return
    this.activeGeneration = undefined
    token.baselineKnown = false
    token.pendingEvents = null
    token.abort.abort()
    for (const unsubscribe of token.unsubscribe.splice(0)) unsubscribe()
  }

  private update(token: GenerationToken, apply: () => void): void {
    if (!this.isCurrent(token)) return
    if (token.pendingEvents !== null) {
      token.pendingEvents.push(apply)
      if (!token.baselineKnown) {
        // Keep the workspace/session projection responsive while the first
        // complete baseline is unavailable; never derive global activity from
        // this partial set.
        apply()
        this.callbacks.sessionsChanged()
      }
      return
    }
    apply()
    if (token.baselineKnown) this.publish()
    else this.callbacks.sessionsChanged()
  }

  private refreshGeneration(token: GenerationToken): Promise<void> {
    if (!this.isCurrent(token)) return Promise.resolve()
    if (token.refreshing !== undefined) return token.refreshing
    if (token.baselineKnown) {
      // A new full read may replace the current Session set. Stop advertising
      // its count as authoritative until that baseline settles.
      token.baselineKnown = false
      this.callbacks.failed(new Error(UNKNOWN_ACTIVITY))
    }
    const events: Array<() => void> = []
    token.pendingEvents = events
    const task = Promise.resolve().then(async () => {
      try {
        const result = await this.client.session.list({}, token.abort.signal)
        if (!this.isCurrent(token)) return
        if (!result.ok) throw result.error
        this.sessions.clear()
        for (const summary of result.value.items) this.sessions.set(summary.sessionId, summary)
        // Events received while the list was pending remain authoritative.
        for (const apply of events) apply()
        token.baselineKnown = true
        this.publish()
      } catch (error) {
        if (this.isCurrent(token)) {
          const hadKnownBaseline = token.baselineKnown
          token.baselineKnown = false
          if (hadKnownBaseline) {
            for (const apply of events) apply()
            if (events.length > 0) this.callbacks.sessionsChanged()
          }
          this.callbacks.failed(error)
        }
      } finally {
        if (token.pendingEvents === events) token.pendingEvents = null
        if (token.refreshing === task) token.refreshing = undefined
      }
    })
    token.refreshing = task
    return task
  }

  private isCurrent(token: GenerationToken): boolean {
    return !this.disposed
      && this.activeGeneration === token
      && this.client.connection.generation.getSnapshot() === token.generation
  }

  private publish(): void {
    if (this.disposed) return
    this.callbacks.activity([...this.sessions.values()].filter(summary => summary.running).length)
    this.callbacks.sessionsChanged()
  }
}
