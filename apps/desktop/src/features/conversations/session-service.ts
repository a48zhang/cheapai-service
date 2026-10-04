import type {
  SessionCreateRequest,
  SessionCreateValue,
  SessionListValue,
  ModelCatalog,
  ModelSelection,
  SessionPage,
  SessionPageRequest,
  SessionRenameRequest,
  SessionRenameValue,
  SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { DshClient } from '../../adapters/dsh/client'
import { getComposerModelOptions } from './composer-controller'
import { readPreferences } from '../settings/preferences'
import {
  SessionStore,
  type ConversationSessionId,
  type SessionScope,
} from './session-store'

type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown }

function unwrapRemoteResult<T>(response: T | RemoteResult<T>): T {
  if (typeof response === 'object' && response !== null && 'ok' in response) {
    const result = response as RemoteResult<T>
    if (result.ok) return result.value
    throw result.error
  }
  return response as T
}

export type SessionServiceErrorCode =
  | 'scope-changed'
  | 'workspace-required'
  | 'session-not-found'
  | 'unsupported'

export class SessionServiceError extends Error {
  constructor(readonly code: SessionServiceErrorCode, message: string) {
    super(message)
    this.name = 'SessionServiceError'
  }
}

export interface SessionCreateOptions {
  readonly agentPreset?: SessionCreateRequest['agentPreset']
}

/** DSH page arguments bound to a matching SessionEventStream opening cursor. */
export type SessionHistoryPageOptions = Omit<SessionPageRequest, 'address'>

interface RequestLifetime {
  readonly controller: AbortController
  readonly signal: AbortSignal
  release(): void
}

/** Optional bridge for preserving a first-prompt draft if model selection fails after create. */
export interface SessionCreationDraftBridge {
  captureUncreatedSessionDraft(scope: SessionScope): string | null
  preserveForCreatedSession(scope: SessionScope, sessionId: ConversationSessionId, draft: string): void
}

/**
 * Thin owner of typed pinned DSH session calls. It keeps one explicit scope;
 * scope changes dispose outstanding reads and all late results are discarded.
 */
export class SessionService {
  private readonly scope: SessionScope
  private readonly pending = new Set<AbortController>()
  private readonly unsubscribeStore: () => void
  private listController: AbortController | null = null
  private disposed = false

  constructor(
    private readonly client: DshClient,
    private readonly store: SessionStore,
    scope: SessionScope,
    private readonly draftBridge?: SessionCreationDraftBridge,
  ) {
    this.scope = Object.freeze({ ...scope })
    this.store.setScope(this.scope)
    this.unsubscribeStore = this.store.subscribe(() => {
      if (!this.store.isCurrentScope(this.scope)) this.dispose()
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeStore()
    for (const controller of this.pending) controller.abort(new SessionServiceError(
      'scope-changed', 'The DSH session scope was replaced'))
    this.pending.clear()
    this.listController = null
  }

  /** Refresh the current directory's DSH summaries; the pinned list has no page cursor. */
  async refreshSessions(): Promise<readonly SessionSummary[]> {
    this.assertCurrentScope()
    const directory = this.scope.workspaceDirectory
    if (directory === null) {
      this.store.replaceSessions(this.scope, [])
      return []
    }

    this.listController?.abort(new DOMException('Superseded by a newer session list read', 'AbortError'))
    const lifetime = this.createRequestLifetime()
    this.listController = lifetime.controller
    this.store.setListLoading(this.scope)
    try {
      const result = unwrapRemoteResult<SessionListValue>(await this.client.session.list(
        {}, lifetime.signal))
      this.assertCurrentScope()
      if (this.listController !== lifetime.controller) {
        throw new DOMException('Superseded by a newer session list read', 'AbortError')
      }
      const sessions = result.items.filter(summary => summary.cwd === directory)
      this.store.replaceSessions(this.scope, sessions)
      return sessions
    } catch (error: unknown) {
      if (this.store.isCurrentScope(this.scope) && this.listController === lifetime.controller
        && !lifetime.signal.aborted) {
        this.store.setListError(this.scope, error)
      }
      throw error
    } finally {
      lifetime.release()
      if (this.listController === lifetime.controller) this.listController = null
    }
  }

  /** Create a real DSH Session in the selected directory; never fall back to process.cwd(). */
  async createSession(options: SessionCreateOptions = {}): Promise<SessionCreateValue> {
    this.assertCurrentScope()
    const cwd = this.scope.workspaceDirectory
    if (cwd === null) {
      throw new SessionServiceError('workspace-required', 'Choose a workspace directory before creating a session')
    }
    const request: SessionCreateRequest = {
      cwd,
      ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
    }

    let defaultSelection: ModelSelection | undefined
    const defaultModelId = this.scope.accountId === null
      ? null : readPreferences(this.scope.accountId).defaultModelId
    if (defaultModelId !== null) {
      try {
        const catalogResponse = await this.client.session.modelCatalog()
        this.assertCurrentScope()
        const catalog = unwrapRemoteResult<ModelCatalog>(catalogResponse)
        defaultSelection = getComposerModelOptions(catalog)
          .find(option => option.key === defaultModelId)?.selection
      } catch {
        // Catalog failures and stale preferences leave DSH's own default intact.
        this.assertCurrentScope()
      }
    }

    this.assertCurrentScope()
    const firstPromptDraft = this.draftBridge?.captureUncreatedSessionDraft(this.scope) ?? null
    let result: SessionCreateValue
    try {
      const createResponse = await this.client.session.create(request)
      this.assertCurrentScope()
      result = unwrapRemoteResult<SessionCreateValue>(createResponse)
    } catch (error: unknown) {
      this.assertCurrentScope()
      throw error
    }

    if (defaultSelection !== undefined) {
      try {
        const selectionResponse = await this.client.session.selectModel({
          sessionId: result.sessionId,
          ...defaultSelection,
        })
        this.assertCurrentScope()
        unwrapRemoteResult<{ readonly selected: ModelSelection }>(selectionResponse)
      } catch (error: unknown) {
        this.assertCurrentScope()
        this.store.setActiveSession(this.scope, result.sessionId)
        if (firstPromptDraft !== null) {
          this.draftBridge?.preserveForCreatedSession(this.scope, result.sessionId, firstPromptDraft)
        }
        // Session create is authoritative; the selected real Session remains visible.
        void this.refreshSessions().catch(() => undefined)
        throw error
      }
    }

    this.assertCurrentScope()
    this.store.setActiveSession(this.scope, result.sessionId)
    // Session create is authoritative even if this best-effort list refresh fails.
    void this.refreshSessions().catch(() => undefined)
    return result
  }

  /** Opening selects the DSH session; U05 owns its snapshot/follow stream. */
  openSession(sessionId: ConversationSessionId): { readonly kind: 'session'; readonly sessionId: ConversationSessionId } {
    this.assertCurrentScope()
    if (!this.isKnownSession(sessionId)) {
      throw new SessionServiceError('session-not-found', 'The session is not loaded in the current scope')
    }
    this.store.setActiveSession(this.scope, sessionId)
    return Object.freeze({ kind: 'session', sessionId })
  }

  async renameSession(sessionId: ConversationSessionId, title: string): Promise<SessionRenameValue> {
    this.assertCurrentScope()
    if (!this.isKnownSession(sessionId)) {
      throw new SessionServiceError('session-not-found', 'The session is not loaded in the current scope')
    }
    const request: SessionRenameRequest = { sessionId, title }
    const result = unwrapRemoteResult<SessionRenameValue>(await this.client.session.rename(request))
    this.assertCurrentScope()
    this.store.setSessionTitle(this.scope, sessionId, result.title)
    return result
  }

  /** Read one real DSH page using the follow opening cursor supplied by U05. */
  async loadHistoryPage(
    sessionId: ConversationSessionId,
    options: SessionHistoryPageOptions,
    signal?: AbortSignal,
  ): Promise<SessionPage> {
    this.assertCurrentScope()
    if (!this.isKnownSession(sessionId)) {
      throw new SessionServiceError('session-not-found', 'The session is not loaded in the current scope')
    }
    const lifetime = this.createRequestLifetime(signal)
    try {
      const request: SessionPageRequest = {
        address: { kind: 'session', sessionId },
        ...options,
      }
      const result = unwrapRemoteResult<SessionPage>(await this.client.session.page(
        request, lifetime.signal))
      this.assertCurrentScope()
      return result
    } finally {
      lifetime.release()
    }
  }

  /** Explicitly unsupported by the pinned Session Remote; no local hiding is performed. */
  async deleteSession(sessionId: ConversationSessionId): Promise<never> {
    this.assertCurrentScope()
    if (!this.isKnownSession(sessionId)) {
      throw new SessionServiceError('session-not-found', 'The session is not loaded in the current scope')
    }
    throw new SessionServiceError(
      'unsupported',
      'The pinned DSH Session Remote does not expose session deletion',
    )
  }

  searchLoadedTitles(query: string) {
    return this.store.searchLoadedTitles(this.scope, query)
  }

  private isKnownSession(sessionId: ConversationSessionId): boolean {
    return this.store.hasSession(this.scope, sessionId)
      || this.store.getSnapshot().activeSessionId === sessionId
  }

  private assertCurrentScope(): void {
    if (this.disposed || !this.store.isCurrentScope(this.scope)) {
      throw new SessionServiceError('scope-changed', 'The DSH session scope is no longer current')
    }
  }

  private createRequestLifetime(externalSignal?: AbortSignal): RequestLifetime {
    const controller = new AbortController()
    this.pending.add(controller)
    const forwardAbort = () => controller.abort(externalSignal?.reason)
    if (externalSignal?.aborted) forwardAbort()
    else externalSignal?.addEventListener('abort', forwardAbort, { once: true })
    return {
      controller,
      signal: controller.signal,
      release: () => {
        externalSignal?.removeEventListener('abort', forwardAbort)
        this.pending.delete(controller)
      },
    }
  }
}
