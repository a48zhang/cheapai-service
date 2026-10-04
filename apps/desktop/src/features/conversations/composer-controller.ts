import type {
  ModelCatalog,
  ModelSelection,
  SessionProjectionsValue,
  SessionRequestId,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { DshClient } from '../../adapters/dsh/client'
import {
  sameSessionScope,
  type ConversationSessionId,
  type SessionScope,
  type SessionStore,
} from './session-store'
import type { MessageStore } from './message-store'

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

/** The owner of one logical DSH client generation, including native reconnects. */
export interface ComposerConnectionLifetime {
  getEpoch(): number
  isCurrent(scope: SessionScope, epoch: number): boolean
  subscribe(listener: () => void): () => void
}

export type ComposerModelSelection = ModelSelection

export interface ComposerModelOption {
  readonly key: string
  readonly label: string
  readonly selection: ComposerModelSelection
}

export type ComposerModelCatalog = ModelCatalog

/** Keeps the original rejection available to diagnostics without guessing its meaning. */
export interface ComposerFailure {
  readonly operation: 'catalog' | 'selection' | 'selection-read' | 'prompt' | 'stop'
  readonly cause: unknown
}

export interface ComposerControllerSnapshot {
  readonly scope: SessionScope | null
  readonly sessionId: ConversationSessionId | null
  readonly connectionReady: boolean
  readonly connectionEpoch: number
  readonly projectionReady: boolean
  readonly draft: string
  readonly running: boolean
  readonly sending: boolean
  readonly stopping: boolean
  readonly selectingModel: boolean
  readonly selectedModel: ComposerModelSelection | null
  readonly catalog: ComposerModelCatalog | null
  readonly catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  readonly selectionStatus: 'idle' | 'loading' | 'ready' | 'error'
  readonly error: string | null
  readonly failure: ComposerFailure | null
}

/** Binding captured before a host creates the first Session for a draft. */
export interface ComposerSessionCreationContext {
  readonly scope: SessionScope
  readonly epoch: number
}

/** Expected Session identity returned by the matching host create callback. */
export interface ComposerCreatedSessionTarget extends ComposerSessionCreationContext {
  readonly sessionId: ConversationSessionId
}

interface ComposerTarget {
  readonly scope: SessionScope
  readonly sessionId: ConversationSessionId
  readonly epoch: number
  readonly revision: number
  readonly key: string
  readonly stableKey: string
}

const INITIAL_SNAPSHOT: ComposerControllerSnapshot = Object.freeze({
  scope: null,
  sessionId: null,
  connectionReady: false,
  connectionEpoch: -1,
  projectionReady: false,
  draft: '',
  running: false,
  sending: false,
  stopping: false,
  selectingModel: false,
  selectedModel: null,
  catalog: null,
  catalogStatus: 'idle',
  selectionStatus: 'idle',
  error: null,
  failure: null,
})

/**
 * Owns the non-idempotent prompt boundary and per-session model selection.
 * DSH remains authoritative for execution; message/running/draft data is read
 * from the U05 stores and late Remote results are fenced by scope, session,
 * controller revision, and Runtime client epoch.
 */
export class ComposerController {
  private snapshot = INITIAL_SNAPSHOT
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: (() => void)[] = []
  private targetRevision = 0
  private observedIdentity = ''
  private catalogEpoch: number | null = null
  private catalogRequestRevision = 0
  private catalogPromise: Promise<void> | null = null
  private selectionRequestRevision = 0
  private projectedSelection: ModelSelection | null = null
  private selectionLoaded = false
  private readonly pendingPromptKeys = new Set<string>()
  private readonly pendingStopKeys = new Set<string>()
  private readonly acceptedStopKeys = new Set<string>()
  private readonly pendingModelKeys = new Set<string>()
  private actionError: string | null = null
  private actionFailure: ComposerFailure | null = null
  private catalogFailure: ComposerFailure | null = null
  private disposed = false

  constructor(
    private readonly client: DshClient,
    private readonly sessions: SessionStore,
    private readonly messages: MessageStore,
    private readonly connectionLifetime: ComposerConnectionLifetime,
  ) {
    this.unsubscribe.push(
      sessions.subscribe(() => this.reconcile()),
      messages.subscribe(() => this.reconcile()),
    )
    this.unsubscribe.push(connectionLifetime.subscribe(() => this.reconcile()))
    this.reconcile()
  }

  readonly getSnapshot = (): ComposerControllerSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.targetRevision += 1
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe()
    this.listeners.clear()
  }

  /** Save into U05's scope/session keyed draft store, including before a new Session is created. */
  setDraft(value: string): void {
    if (this.disposed) return
    const session = this.sessions.getSnapshot()
    const scope = session.scope
    if (scope === null || !this.isConnectionCurrent(scope, this.safeEpoch())) return
    this.messages.setDraftFor(scope, session.activeSessionId, value)
  }

  /** Reload the catalog only on explicit user action; failed reads are never retried automatically. */
  async reloadModelCatalog(): Promise<void> {
    const scope = this.sessions.getSnapshot().scope
    const epoch = this.safeEpoch()
    if (scope === null || !this.isConnectionCurrent(scope, epoch)) return
    await this.loadModelCatalog(epoch, true)
  }

  /** Capture account/workspace/connection before an asynchronous first-Session flow. */
  captureSessionCreationContext(): ComposerSessionCreationContext | null {
    const current = this.sessions.getSnapshot()
    const scope = current.scope
    const epoch = this.safeEpoch()
    if (scope === null || current.activeSessionId !== null || !this.isConnectionCurrent(scope, epoch)) return null
    return Object.freeze({ scope: Object.freeze({ ...scope }), epoch })
  }

  /** Apply one explicit Session-local DSH model selection. */
  async selectModel(selection: ComposerModelSelection): Promise<void> {
    const target = this.currentTarget()
    if (target === null || !this.isTargetCurrent(target)) return
    const option = this.snapshot.catalog === null
      ? undefined
      : getComposerModelOptions(this.snapshot.catalog).find(candidate =>
        candidate.selection.provider === selection.provider
        && candidate.selection.model === selection.model
        && candidate.selection.reasoningEffort === selection.reasoningEffort)
    if (option === undefined || this.snapshot.catalogStatus !== 'ready') return

    const activeKey = target.key
    if (this.pendingModelKeys.has(activeKey) || this.snapshot.running) return
    this.pendingModelKeys.add(activeKey)
    this.actionError = null
    this.actionFailure = null
    this.publishSnapshot()
    try {
      const response = await this.client.session.selectModel({
        sessionId: target.sessionId,
        ...option.selection,
      })
      const result = unwrapRemoteResult<{ readonly selected: ModelSelection }>(response)
      if (!this.isTargetCurrent(target)) return
      this.projectedSelection = normalizeForCatalog(result.selected, this.catalog)
      this.selectionLoaded = true
      this.selectedModel = this.projectedSelection
      this.selectionStatus = 'ready'
      this.actionError = null
    } catch (cause: unknown) {
      if (this.isTargetCurrent(target)) {
        this.actionError = '模型切换失败，当前选择未更改。'
        this.actionFailure = Object.freeze({ operation: 'selection', cause })
      }
    } finally {
      this.pendingModelKeys.delete(activeKey)
      if (this.isTargetCurrent(target)) this.publishSnapshot()
    }
  }

  /** Send exactly one prompt request. The draft is cleared only after acceptance and only if unchanged. */
  async send(scopedDraft?: string, expectedTarget?: ComposerCreatedSessionTarget): Promise<void> {
    const target = this.currentTarget()
    if (target === null || !this.isTargetCurrent(target)) return
    if (expectedTarget !== undefined && (!sameSessionScope(expectedTarget.scope, target.scope)
      || expectedTarget.epoch !== target.epoch || expectedTarget.sessionId !== target.sessionId)) return

    if (scopedDraft !== undefined) this.messages.setDraftFor(target.scope, target.sessionId, scopedDraft)
    const messageSnapshot = this.messages.getSnapshot()
    const hasCurrentProjection = sameSessionScope(messageSnapshot.scope, target.scope)
      && messageSnapshot.sessionId === target.sessionId
    const draft = scopedDraft ?? (hasCurrentProjection ? messageSnapshot.draft : '')
    if (draft.trim().length === 0) return

    const catalog = this.snapshot.catalog
    if (this.snapshot.catalogStatus !== 'ready' || catalog === null) {
      return
    }
    if (getComposerModelOptions(catalog).length === 0) {
      return
    }
    if (this.pendingPromptKeys.has(target.stableKey) || this.snapshot.running
      || this.pendingModelKeys.has(target.key)) return

    this.pendingPromptKeys.add(target.stableKey)
    this.actionError = null
    this.actionFailure = null
    this.publishSnapshot()
    const requestId = crypto.randomUUID() as SessionRequestId
    try {
      const response = await this.client.session.prompt({
        requestId,
        sessionId: target.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: draft }],
      })
      unwrapRemoteResult<{ readonly accepted: true }>(response)
      if (!this.isTargetCurrent(target)) return
      const latest = this.messages.getSnapshot()
      if (sameSessionScope(latest.scope, target.scope)
        && latest.sessionId === target.sessionId && latest.draft === draft) {
        this.messages.setDraftFor(target.scope, target.sessionId, '')
      }
      // The first prompt starts from a null-session draft. Clear that captured
      // copy only if it is still unchanged; edits made while sending survive.
      if (expectedTarget !== undefined) {
        this.messages.clearDraftFor(expectedTarget.scope, null, draft)
      }
    } catch (cause: unknown) {
      if (this.isTargetCurrent(target)) {
        this.actionError = '发送失败，输入已保留；请检查连接后手动重试。'
        this.actionFailure = Object.freeze({ operation: 'prompt', cause })
      }
    } finally {
      this.pendingPromptKeys.delete(target.stableKey)
      if (this.isTargetCurrent(target)) this.publishSnapshot()
    }
  }

  /** Request DSH to cancel the active Agent; running remains projection-owned until it changes. */
  async stop(): Promise<void> {
    const target = this.currentTarget()
    if (target === null || !this.isTargetCurrent(target) || !this.snapshot.running) return
    if (this.pendingStopKeys.has(target.stableKey) || this.acceptedStopKeys.has(target.stableKey)) return

    this.pendingStopKeys.add(target.stableKey)
    this.actionError = null
    this.actionFailure = null
    this.publishSnapshot()
    try {
      const response = await this.client.session.cancel({ sessionId: target.sessionId })
      unwrapRemoteResult<{ readonly accepted: true }>(response)
      this.acceptedStopKeys.add(target.stableKey)
      if (this.isTargetCurrent(target)) this.actionError = null
    } catch (cause: unknown) {
      if (this.isTargetCurrent(target)) {
        this.actionError = '停止请求失败；任务状态未改变，请稍后重试。'
        this.actionFailure = Object.freeze({ operation: 'stop', cause })
      }
    } finally {
      this.pendingStopKeys.delete(target.stableKey)
      if (this.isTargetCurrent(target)) this.publishSnapshot()
    }
  }

  private reconcile(): void {
    if (this.disposed) return
    const session = this.sessions.getSnapshot()
    const epoch = this.safeEpoch()
    const scope = session.scope
    const sessionId = session.activeSessionId
    const connectionCurrent = scope !== null && this.isConnectionCurrent(scope, epoch)
    const identity = scope === null || sessionId === null || !connectionCurrent
      ? JSON.stringify([scope, sessionId, epoch, connectionCurrent])
      : targetKey(scope, sessionId, epoch)

    if (identity !== this.observedIdentity) {
      this.observedIdentity = identity
      this.targetRevision += 1
      this.projectedSelection = null
      this.selectionLoaded = false
      this.actionError = null
      this.actionFailure = null
      this.selectionRequestRevision += 1
      if (this.catalogEpoch !== epoch) {
        this.catalogEpoch = epoch
        this.catalogRequestRevision += 1
        this.catalogPromise = null
        this.catalog = null
        this.catalogStatus = 'idle'
        this.catalogError = null
        this.catalogFailure = null
      }
      if (connectionCurrent && scope !== null) {
        void this.loadModelCatalog(epoch, false)
        const target = this.currentTarget()
        if (target !== null) void this.loadSelection(target)
      }
    }

    const target = this.currentTarget()
    if (target !== null && !this.messageStoreIsCurrent(target)) return this.publishSnapshot()
    if (target !== null && !this.readRunning(target)) this.acceptedStopKeys.delete(target.stableKey)
    this.publishSnapshot()
  }

  private async loadModelCatalog(epoch: number, force: boolean): Promise<void> {
    if (this.disposed || epoch !== this.safeEpoch()) return
    if (!force && this.catalogEpoch === epoch && this.catalogStatus !== 'idle') {
      if (this.catalogPromise !== null) await this.catalogPromise
      return
    }
    if (this.catalogPromise !== null && this.catalogEpoch === epoch) {
      await this.catalogPromise
      if (!force) return
    }

    const requestRevision = ++this.catalogRequestRevision
    this.catalogEpoch = epoch
    this.catalogStatus = 'loading'
    this.catalogError = null
    this.catalogFailure = null
    this.publishSnapshot()
    const request = (async (): Promise<void> => {
      try {
        const response = await this.client.session.modelCatalog()
        const result = unwrapRemoteResult<ModelCatalog>(response)
        if (this.disposed || requestRevision !== this.catalogRequestRevision
          || epoch !== this.safeEpoch()) return
        this.catalog = result
        this.catalogStatus = 'ready'
        if (this.selectionLoaded) {
          this.selectedModel = this.projectedSelection === null
            ? normalizeForCatalog(result.default, result)
            : normalizeForCatalog(this.projectedSelection, result)
        }
        this.publishSnapshot()
      } catch (cause: unknown) {
        if (this.disposed || requestRevision !== this.catalogRequestRevision
          || epoch !== this.safeEpoch()) return
        this.catalog = null
        this.catalogStatus = 'error'
        this.catalogError = '无法读取可用模型。请检查 DSH 连接与模型配置。'
        this.catalogFailure = Object.freeze({ operation: 'catalog', cause })
        this.publishSnapshot()
      } finally {
        if (requestRevision === this.catalogRequestRevision) this.catalogPromise = null
      }
    })()
    this.catalogPromise = request
    await request
  }

  private async loadSelection(target: ComposerTarget): Promise<void> {
    const requestRevision = ++this.selectionRequestRevision
    this.selectionStatus = 'loading'
    this.selectedModel = null
    this.publishSnapshot()
    try {
      const response = await this.client.session.projections({ sessionId: target.sessionId })
      const result = unwrapRemoteResult<SessionProjectionsValue>(response)
      if (!this.isTargetCurrent(target) || requestRevision !== this.selectionRequestRevision) return
      this.projectedSelection = result?.values.modelSelection?.next ?? null
      this.selectionLoaded = true
      this.selectedModel = this.projectedSelection === null
        ? this.catalog === null ? null : normalizeForCatalog(this.catalog.default, this.catalog)
        : normalizeForCatalog(this.projectedSelection, this.catalog)
      this.selectionStatus = 'ready'
    } catch (cause: unknown) {
      if (!this.isTargetCurrent(target) || requestRevision !== this.selectionRequestRevision) return
      this.projectedSelection = null
      this.selectionLoaded = false
      this.selectedModel = null
      this.selectionStatus = 'error'
      this.actionFailure = Object.freeze({ operation: 'selection-read', cause })
    }
    this.publishSnapshot()
  }

  private currentTarget(): ComposerTarget | null {
    const session = this.sessions.getSnapshot()
    const scope = session.scope
    const sessionId = session.activeSessionId
    const epoch = this.safeEpoch()
    if (scope === null || sessionId === null || !this.isConnectionCurrent(scope, epoch)) return null
    return {
      scope,
      sessionId,
      epoch,
      revision: this.targetRevision,
      key: targetKey(scope, sessionId, epoch),
      stableKey: stableTargetKey(scope, sessionId),
    }
  }

  private isTargetCurrent(target: ComposerTarget): boolean {
    if (this.disposed || target.revision !== this.targetRevision
      || target.epoch !== this.safeEpoch() || !this.isConnectionCurrent(target.scope, target.epoch)) return false
    const session = this.sessions.getSnapshot()
    return session.activeSessionId === target.sessionId
      && sameSessionScope(session.scope, target.scope)
  }

  private isConnectionCurrent(scope: SessionScope, epoch: number): boolean {
    if (epoch !== this.safeEpoch()) return false
    try {
      return this.sessions.isCurrentScope(scope) && this.connectionLifetime.isCurrent(scope, epoch)
    } catch {
      return false
    }
  }

  private messageStoreIsCurrent(target: ComposerTarget): boolean {
    const message = this.messages.getSnapshot()
    return sameSessionScope(message.scope, target.scope) && message.sessionId === target.sessionId
  }

  private readRunning(target: ComposerTarget): boolean {
    if (!this.messageStoreIsCurrent(target)) return false
    const message = this.messages.getSnapshot()
    return message.running
  }

  private safeEpoch(): number {
    try {
      const epoch = this.connectionLifetime.getEpoch()
      return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : -1
    } catch {
      return -1
    }
  }

  private publishSnapshot(): void {
    if (this.disposed) return
    const session = this.sessions.getSnapshot()
    const scope = session.scope
    const sessionId = session.activeSessionId
    const epoch = this.safeEpoch()
    const currentScope = scope !== null && this.isConnectionCurrent(scope, epoch)
    const target = currentScope ? this.currentTarget() : null
    const message = this.messages.getSnapshot()
    const projectionReady = scope !== null && sameSessionScope(message.scope, scope)
      && message.sessionId === sessionId
    const targetKeyValue = target?.key
    const running = target !== null && projectionReady ? message.running : false
    if (target !== null && !running) this.acceptedStopKeys.delete(target.stableKey)
    const next: ComposerControllerSnapshot = Object.freeze({
      scope,
      sessionId,
      connectionReady: currentScope,
      connectionEpoch: epoch,
      projectionReady,
      draft: projectionReady ? message.draft : '',
      running,
      sending: target !== null && this.pendingPromptKeys.has(target.stableKey),
      stopping: target !== null && running
        && (this.pendingStopKeys.has(target.stableKey) || this.acceptedStopKeys.has(target.stableKey)),
      selectingModel: targetKeyValue !== undefined && this.pendingModelKeys.has(targetKeyValue),
      selectedModel: targetKeyValue === undefined ? null : this.selectedModel,
      catalog: this.catalog,
      catalogStatus: this.catalogStatus,
      selectionStatus: targetKeyValue === undefined ? 'idle' : this.selectionStatus,
      error: this.actionError ?? (this.catalogStatus === 'error' && currentScope
        ? this.catalogError : this.selectionStatus === 'error' && target !== null
          ? '无法读取会话当前模型；选择模型可更新。' : null),
      failure: this.actionFailure ?? (this.catalogStatus === 'error' && currentScope ? this.catalogFailure : null),
    })
    if (sameSnapshot(this.snapshot, next)) return
    this.snapshot = next
    for (const listener of [...this.listeners]) {
      try { listener() } catch { /* Isolate external-store observers. */ }
    }
  }

  private catalog: ModelCatalog | null = null
  private catalogStatus: ComposerControllerSnapshot['catalogStatus'] = 'idle'
  private catalogError: string | null = null
  private selectionStatus: ComposerControllerSnapshot['selectionStatus'] = 'idle'
  private selectedModel: ModelSelection | null = null
}

export function getComposerModelOptions(catalog: ModelCatalog): readonly ComposerModelOption[] {
  const options: ComposerModelOption[] = []
  for (const group of catalog.groups) {
    for (const model of group.models) {
      const efforts = model.reasoning?.efforts ?? []
      const defaultEffort = model.reasoning?.defaultEffort
      const effortIds: (string | undefined)[] = [...new Set([
        ...(defaultEffort === undefined ? [] : [defaultEffort]),
        ...efforts.map(effort => effort.id),
      ])]
      if (effortIds.length === 0 || defaultEffort === undefined) effortIds.unshift(undefined)
      const selections: readonly (string | undefined)[] = effortIds
      for (const effortId of selections) {
        const effort = efforts.find(entry => entry.id === effortId)
        const selection: ModelSelection = {
          provider: group.id,
          model: model.id,
          ...(effortId === undefined ? {} : { reasoningEffort: effortId }),
        }
        options.push(Object.freeze({
          key: selectionKey(selection),
          label: [group.name, model.name, effort?.name ?? (effortId === defaultEffort && effortId !== undefined ? '默认推理' : undefined)]
            .filter(Boolean)
            .join(' · '),
          selection: Object.freeze(selection),
        }))
      }
    }
  }
  return Object.freeze(options)
}

export function composerSelectionKey(
  selection: ModelSelection | null,
  catalog: ModelCatalog | null,
): string {
  return selection === null ? '' : selectionKey(normalizeForCatalog(selection, catalog))
}

function normalizeSelection(selection: ModelSelection): ModelSelection {
  return Object.freeze({ ...selection })
}

function normalizeForCatalog(
  selection: ModelSelection,
  catalog: ModelCatalog | null,
): ModelSelection {
  if (selection.reasoningEffort !== undefined || catalog === null) return normalizeSelection(selection)
  const model = catalog.groups.find(group => group.id === selection.provider)?.models
    .find(candidate => candidate.id === selection.model)
  const defaultEffort = model?.reasoning?.defaultEffort
  return Object.freeze({
    ...selection,
    ...(defaultEffort === undefined ? {} : { reasoningEffort: defaultEffort }),
  })
}

function selectionKey(selection: ModelSelection): string {
  return JSON.stringify([selection.provider, selection.model, selection.reasoningEffort ?? null])
}

function targetKey(scope: SessionScope, sessionId: ConversationSessionId, epoch: number): string {
  return JSON.stringify([
    scope.accountId,
    scope.workspaceDirectory,
    scope.connectionGeneration,
    sessionId,
    epoch,
  ])
}

function stableTargetKey(scope: SessionScope, sessionId: ConversationSessionId): string {
  return JSON.stringify([scope.accountId, scope.workspaceDirectory, sessionId])
}

function sameSnapshot(left: ComposerControllerSnapshot, right: ComposerControllerSnapshot): boolean {
  return left.scope === right.scope
    && left.sessionId === right.sessionId
    && left.connectionReady === right.connectionReady
    && left.connectionEpoch === right.connectionEpoch
    && left.projectionReady === right.projectionReady
    && left.draft === right.draft
    && left.running === right.running
    && left.sending === right.sending
    && left.stopping === right.stopping
    && left.selectingModel === right.selectingModel
    && left.selectedModel === right.selectedModel
    && left.catalog === right.catalog
    && left.catalogStatus === right.catalogStatus
    && left.selectionStatus === right.selectionStatus
    && left.error === right.error
    && left.failure === right.failure
}
