import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'

export type ConversationSessionId = SessionSummary['sessionId']

/** The lifetime that owns every in-memory session row, cursor, and selection. */
export interface SessionScope {
  /** Stable authenticated user identity; null is the unauthenticated scope. */
  readonly accountId: string | null
  /** Exact host path selected for this DSH session view. */
  readonly workspaceDirectory: string | null
  /** Incremented by the DSH connection owner whenever its logical connection is replaced. */
  readonly connectionGeneration: number
}

/** UI projection of one authoritative DSH list summary. */
export interface ConversationListItem extends SessionSummary {
  readonly title: string
}

/** Cursor state owned by one session and one SessionScope. */
export interface SessionHistoryCursor {
  /** Inclusive log cut returned by the matching DSH follow opening. */
  readonly throughSeq: number
  /** Backward page boundary supplied to the DSH page endpoint, when present. */
  readonly beforeSeq?: number
  readonly hasMore: boolean
}

export type SessionListStatus = 'idle' | 'loading' | 'ready' | 'error'

/** Immutable external-store snapshot, suitable for React useSyncExternalStore. */
export interface SessionStoreSnapshot {
  readonly scope: SessionScope | null
  readonly listStatus: SessionListStatus
  readonly listError: unknown | null
  readonly sessions: readonly ConversationListItem[]
  readonly activeSessionId: ConversationSessionId | null
  readonly historyCursors: Readonly<Record<string, SessionHistoryCursor>>
}

const EMPTY_SESSIONS: readonly ConversationListItem[] = Object.freeze([])
const EMPTY_CURSORS: Readonly<Record<string, SessionHistoryCursor>> = Object.freeze({})

function freezeScope(scope: SessionScope): SessionScope {
  if (scope.accountId !== null && scope.accountId.length === 0) {
    throw new TypeError('Session scope accountId must be non-empty or null')
  }
  if (scope.workspaceDirectory !== null && scope.workspaceDirectory.length === 0) {
    throw new TypeError('Session scope workspaceDirectory must be non-empty or null')
  }
  if (!Number.isSafeInteger(scope.connectionGeneration) || scope.connectionGeneration < 0) {
    throw new TypeError('Session scope connectionGeneration must be a non-negative safe integer')
  }
  return Object.freeze({
    accountId: scope.accountId,
    workspaceDirectory: scope.workspaceDirectory,
    connectionGeneration: scope.connectionGeneration,
  })
}

export function sameSessionScope(left: SessionScope | null, right: SessionScope | null): boolean {
  return left === right || (left !== null && right !== null
    && left.accountId === right.accountId
    && left.workspaceDirectory === right.workspaceDirectory
    && left.connectionGeneration === right.connectionGeneration)
}

function titleFor(summary: SessionSummary): string {
  const projectedTitle = summary.projections?.values.title
  if (typeof projectedTitle === 'string' && projectedTitle.trim().length > 0) {
    return projectedTitle
  }
  return summary.blank ? '新对话' : '未命名会话'
}

function projectSummary(summary: SessionSummary): ConversationListItem {
  return Object.freeze({ ...summary, title: titleFor(summary) })
}

/**
 * In-memory UI projection only. DSH remains the source of truth for sessions;
 * changing any scope component clears rows, cursors, and active selection.
 */
export class SessionStore {
  private snapshot: SessionStoreSnapshot = Object.freeze({
    scope: null,
    listStatus: 'idle',
    listError: null,
    sessions: EMPTY_SESSIONS,
    activeSessionId: null,
    historyCursors: EMPTY_CURSORS,
  })

  private readonly listeners = new Set<() => void>()

  readonly getSnapshot = (): SessionStoreSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setScope(scope: SessionScope | null): void {
    const nextScope = scope === null ? null : freezeScope(scope)
    if (sameSessionScope(this.snapshot.scope, nextScope)) return
    this.publish({
      scope: nextScope,
      listStatus: 'idle',
      listError: null,
      sessions: EMPTY_SESSIONS,
      activeSessionId: null,
      historyCursors: EMPTY_CURSORS,
    })
  }

  isCurrentScope(scope: SessionScope): boolean {
    return sameSessionScope(this.snapshot.scope, scope)
  }

  hasSession(scope: SessionScope, sessionId: ConversationSessionId): boolean {
    return this.isCurrentScope(scope)
      && this.snapshot.sessions.some(session => session.sessionId === sessionId)
  }

  setListLoading(scope: SessionScope): void {
    if (!this.isCurrentScope(scope)) return
    this.publish({ ...this.snapshot, listStatus: 'loading', listError: null })
  }

  replaceSessions(scope: SessionScope, summaries: readonly SessionSummary[]): void {
    if (!this.isCurrentScope(scope)) return
    const sessions = Object.freeze(summaries.map(projectSummary))
    const visibleIds = new Set(sessions.map(session => session.sessionId))
    const historyCursors = Object.fromEntries(
      Object.entries(this.snapshot.historyCursors)
        .filter(([sessionId]) => visibleIds.has(sessionId as ConversationSessionId)
          || sessionId === this.snapshot.activeSessionId),
    ) as Readonly<Record<string, SessionHistoryCursor>>
    this.publish({
      ...this.snapshot,
      listStatus: 'ready',
      listError: null,
      sessions,
      historyCursors: Object.freeze(historyCursors),
    })
  }

  setListError(scope: SessionScope, error: unknown): void {
    if (!this.isCurrentScope(scope)) return
    this.publish({ ...this.snapshot, listStatus: 'error', listError: error })
  }

  /** Selects an authoritative listed session or the id returned by DSH create. */
  setActiveSession(scope: SessionScope, sessionId: ConversationSessionId | null): void {
    if (!this.isCurrentScope(scope) || this.snapshot.activeSessionId === sessionId) return
    this.publish({ ...this.snapshot, activeSessionId: sessionId })
  }

  /** Apply the normalized title returned by the DSH rename Remote. */
  setSessionTitle(scope: SessionScope, sessionId: ConversationSessionId, title: string): void {
    if (!this.isCurrentScope(scope)) return
    const sessions = this.snapshot.sessions.map(session => session.sessionId === sessionId
      ? Object.freeze({ ...session, title })
      : session)
    if (sessions.every((session, index) => session === this.snapshot.sessions[index])) return
    this.publish({ ...this.snapshot, sessions: Object.freeze(sessions) })
  }

  /** Store the follow/page cursors supplied by the DSH event-stream owner. */
  setHistoryCursor(
    scope: SessionScope,
    sessionId: ConversationSessionId,
    cursor: SessionHistoryCursor | null,
  ): void {
    if (!this.isCurrentScope(scope)) return
    if (cursor !== null && (!Number.isSafeInteger(cursor.throughSeq) || cursor.throughSeq < -1
      || (cursor.beforeSeq !== undefined
        && (!Number.isSafeInteger(cursor.beforeSeq) || cursor.beforeSeq < 0)))) {
      throw new TypeError('Session history cursor must use valid DSH sequence numbers')
    }
    const historyCursors = { ...this.snapshot.historyCursors }
    if (cursor === null) delete historyCursors[sessionId]
    else historyCursors[sessionId] = Object.freeze({ ...cursor })
    this.publish({ ...this.snapshot, historyCursors: Object.freeze(historyCursors) })
  }

  /** Search loaded DSH titles only; this does not search message content or fetch more rows. */
  searchLoadedTitles(scope: SessionScope, query: string): readonly ConversationListItem[] {
    if (!this.isCurrentScope(scope)) return EMPTY_SESSIONS
    const normalizedQuery = query.trim().toLowerCase()
    if (normalizedQuery.length === 0) return this.snapshot.sessions
    return this.snapshot.sessions.filter(session =>
      session.title.toLowerCase().includes(normalizedQuery))
  }

  private publish(next: SessionStoreSnapshot): void {
    this.snapshot = Object.freeze(next)
    for (const listener of this.listeners) listener()
  }
}
