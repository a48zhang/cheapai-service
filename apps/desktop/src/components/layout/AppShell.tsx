import { Context } from '@deepseek-ai/cordis'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { NativeRuntimeClient } from '../../adapters/native/runtime'
import { installDshConnection } from '../../adapters/dsh/connection'
import { installDshClient, sessionIdForDshOwner } from '../../adapters/dsh/client'
import type { DesktopAuthStore } from '../../features/auth/auth-store'
import type { SignedInAccountState } from '../../features/auth/LoginPage'
import { Button } from '../../components/ui/controls'
import { AccountPanel } from '../../features/settings/AccountPanel'
import { SettingsPage } from '../../features/settings/SettingsPage'
import { readPreferences } from '../../features/settings/preferences'
import type { DirectoryOptionSource, ModelOptionSource } from '../../features/settings/GeneralPanel'
import { ComposerController, getComposerModelOptions } from '../../features/conversations/composer-controller'
import { ConversationPage } from '../../features/conversations/ConversationPage'
import { ConversationEventProjection } from '../../features/conversations/event-projection'
import { DshInteraction, type DshInteractionHandle } from '../../features/conversations/DshInteraction'
import { MessageStore } from '../../features/conversations/message-store'
import { SessionActivityMonitor } from '../../features/conversations/session-monitor'
import { SessionService } from '../../features/conversations/session-service'
import { sameSessionScope, SessionStore, type ConversationSessionId, type SessionScope } from '../../features/conversations/session-store'
import type { DshClient } from '../../adapters/dsh/client'

type AppRoute = 'workspace' | 'settings' | 'account'

interface ClientBundle {
  readonly id: number
  readonly client: DshClient
  readonly projection: ConversationEventProjection
  readonly composer: ComposerController
}

interface ServiceOwner {
  readonly key: string
  readonly service: SessionService
}

export interface AppShellProps {
  readonly runtime: NativeRuntimeClient
  readonly authStore: DesktopAuthStore
  readonly account: SignedInAccountState
  readonly sessions: SessionStore
  readonly messages: MessageStore
}

/** Owns one authenticated DSH client generation and its workspace-scoped views. */
export function AppShell({ runtime, authStore, account, sessions, messages }: AppShellProps) {
  const runtimeSnapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot)
  const [workspaceDirectory, setWorkspaceDirectory] = useState<string | null>(() => {
    return initialWorkspaceDirectory(sessions, account.account.user.id)
  })
  const [route, setRoute] = useState<AppRoute>('workspace')
  const [clientBundle, setClientBundle] = useState<ClientBundle | null>(null)
  const [clientFailure, setClientFailure] = useState<string | null>(null)
  const [connectionRetry, setConnectionRetry] = useState(0)
  const [serviceOwner, setServiceOwner] = useState<ServiceOwner | null>(null)
  const [activityError, setActivityError] = useState<string | null>(null)
  const interactionRef = useRef<DshInteractionHandle | null>(null)
  const currentService = useRef<SessionService | null>(null)
  const bundleSequence = useRef(0)

  const connectionGeneration = runtimeSnapshot.connectionGeneration
  const scope = useMemo<SessionScope>(() => Object.freeze({
    accountId: account.account.user.id,
    workspaceDirectory,
    connectionGeneration,
  }), [account.account.user.id, connectionGeneration, workspaceDirectory])
  const scopeKey = JSON.stringify([
    scope.accountId,
    scope.workspaceDirectory,
    scope.connectionGeneration,
  ])

  useEffect(() => {
    let live = true
    let ownerCleanup: (() => void) | undefined
    const ownerId = ++bundleSequence.current
    const ownerEpoch = runtime.getSnapshot().connectionGeneration
    const isCurrentOwner = (): boolean => live && runtime.getSnapshot().connectionGeneration === ownerEpoch
    const rootContext = new Context()
    const fiber = rootContext.plugin({
      name: 'cheapai-desktop-renderer-dsh-client',
      apply: async context => {
        try {
          installDshConnection(context, runtime.createRpc())
          const client = await installDshClient(context)
          if (!live) return

          const connectionLifetime = {
            getEpoch: () => runtime.getSnapshot().connectionGeneration,
            isCurrent: (candidateScope: SessionScope, epoch: number) => {
              const latest = runtime.getSnapshot()
              const status = latest.status
              return latest.mode === 'native'
                && latest.connectionGeneration === epoch
                && status?.process === 'ready'
                && status.dsh.state === 'ready'
                && status.connection !== null
                && candidateScope.accountId === account.account.user.id
                && candidateScope.connectionGeneration === epoch
            },
            subscribe: runtime.subscribe,
          }
          const projection = new ConversationEventProjection(client, sessions, messages)
          const composer = new ComposerController(client, sessions, messages, connectionLifetime)
          const monitor = new SessionActivityMonitor(client, {
            activity: count => {
              if (!isCurrentOwner()) return
              setActivityError(null)
              void runtime.setTaskActivity(count).catch(() => {
                if (isCurrentOwner()) setActivityError('暂时无法同步 DSH 的运行状态。')
              })
            },
            sessionsChanged: () => {
              if (!live) return
              void currentService.current?.refreshSessions().catch(() => undefined)
            },
            failed: () => {
              if (!isCurrentOwner()) return
              setActivityError('暂时无法同步所有会话的运行状态。')
              void runtime.setTaskActivity(0, false).catch(() => undefined)
            },
          })
          let disposed = false
          const disposeOwner = (): void => {
            if (disposed) return
            disposed = true
            monitor.dispose()
            composer.dispose()
            void projection.dispose()
            setClientBundle(current => current?.id === ownerId ? null : current)
          }
          ownerCleanup = disposeOwner
          setClientFailure(null)
          setClientBundle({ id: ownerId, client, projection, composer })
          void monitor.refresh()
        } catch (error: unknown) {
          if (live) setClientFailure(error instanceof Error ? error.message : 'DSH 客户端初始化失败。')
        }
      },
    })

    void Promise.resolve(fiber).catch(error => {
      if (live) setClientFailure(error instanceof Error ? error.message : 'DSH 客户端初始化失败。')
    })

    return () => {
      live = false
      ownerCleanup?.()
      setClientBundle(current => current?.id === ownerId ? null : current)
      void fiber.dispose().catch(() => undefined)
    }
  }, [account.account.user.id, connectionRetry, messages, runtime, sessions])

  useEffect(() => {
    if (clientBundle === null) return
    const service = new SessionService(clientBundle.client, sessions, scope, createDraftBridge(
      clientBundle.composer, messages, authStore, runtime,
    ))
    currentService.current = service
    setServiceOwner({ key: scopeKey, service })
    return () => {
      service.dispose()
      if (currentService.current === service) currentService.current = null
      setServiceOwner(current => current?.service === service ? null : current)
    }
  }, [authStore, clientBundle, messages, runtime, scope, scopeKey, sessions])

  const service = serviceOwner?.key === scopeKey ? serviceOwner.service : null
  const accountLabel = account.account.user.email_normalized || account.account.user.id

  async function selectDirectory(directory: string): Promise<void> {
    const current = sessions.getSnapshot()
    const currentAccount = authStore.getSnapshot().accountState
    if (current.activeSessionId !== null
      || runtime.getSnapshot().connectionGeneration !== connectionGeneration
      || currentAccount.status !== 'signedIn'
      || currentAccount.account.user.id !== account.account.user.id) {
      throw new Error('Workspace scope changed before the directory was selected')
    }
    setWorkspaceDirectory(directory)
  }

  async function createSessionAtDirectory(directory: string): Promise<void> {
    if (clientBundle === null) throw new Error('The DSH connection is not ready')
    const currentStatus = runtime.getSnapshot().status
    const currentAccount = authStore.getSnapshot().accountState
    if (runtime.getSnapshot().connectionGeneration !== connectionGeneration
      || currentStatus?.process !== 'ready' || currentStatus.dsh.state !== 'ready'
      || currentAccount.status !== 'signedIn'
      || currentAccount.account.user.id !== account.account.user.id) {
      throw new Error('The DSH connection changed before the workspace was applied')
    }

    const nextScope: SessionScope = Object.freeze({
      accountId: account.account.user.id,
      workspaceDirectory: directory,
      connectionGeneration,
    })
    const temporaryStore = new SessionStore()
    const temporaryService = new SessionService(clientBundle.client, temporaryStore, nextScope, createDraftBridge(
      clientBundle.composer, messages, authStore, runtime,
    ))
    const assertWorkspaceContext = (): void => {
      const latestStatus = runtime.getSnapshot().status
      const latestAccount = authStore.getSnapshot().accountState
      if (runtime.getSnapshot().connectionGeneration !== connectionGeneration
        || latestStatus?.process !== 'ready' || latestStatus.dsh.state !== 'ready'
        || latestAccount.status !== 'signedIn'
        || latestAccount.account.user.id !== account.account.user.id) {
        throw new Error('The DSH connection changed while creating the workspace session')
      }
    }
    const activateCreatedSession = (sessionId: ConversationSessionId): void => {
      assertWorkspaceContext()
      // DSH owns the new Session. Select it only after creation succeeds, leaving
      // the old Session and its running task untouched if this operation fails.
      sessions.setScope(nextScope)
      sessions.setActiveSession(nextScope, sessionId)
      setWorkspaceDirectory(directory)
    }
    try {
      const created = await temporaryService.createSession()
      activateCreatedSession(created.sessionId)
    } catch (error: unknown) {
      // A default-model failure happens after DSH created the Session. Publish
      // that real Session so it remains visible, while propagating the failure
      // to keep the first prompt from being sent automatically.
      assertWorkspaceContext()
      const createdSessionId = temporaryStore.getSnapshot().activeSessionId
      if (createdSessionId !== null) activateCreatedSession(createdSessionId)
      throw error
    } finally {
      temporaryService.dispose()
    }
  }

  function openInteraction(callId: string): void {
    interactionRef.current?.reveal(callId)
  }

  return (
    <>
      {clientBundle !== null && (
        <DshInteraction
          ref={interactionRef}
          remote={clientBundle.client.remote}
          sessionIdForOwner={sessionIdForDshOwner}
        />
      )}
      {clientFailure !== null && clientBundle === null ? (
        <main className="desktop-page" aria-label="桌面服务连接">
          <section className="workspace-empty" role="alert">
            <h1>无法连接 DSH</h1>
            <p>桌面服务已连接，但 DSH 会话客户端未能启动。</p>
            <Button onClick={() => setConnectionRetry(value => value + 1)} variant="primary">重试连接</Button>
          </section>
        </main>
      ) : clientBundle === null || service === null ? (
        <main className="desktop-page" aria-label="工作区准备中">
          <section className="workspace-empty" role="status">
            <h1>正在准备工作区</h1>
            <p>正在连接 DSH 并载入当前工作目录的会话。</p>
          </section>
        </main>
      ) : route === 'workspace' ? (
        <ConversationPage
          accountLabel={accountLabel}
          authStore={authStore}
          client={clientBundle.client}
          composer={clientBundle.composer}
          onCreateSessionAtDirectory={createSessionAtDirectory}
          onDirectorySelected={selectDirectory}
          onOpenAccountSettings={() => setRoute('account')}
          onOpenInteraction={openInteraction}
          onOpenSettings={() => setRoute('settings')}
          projection={clientBundle.projection}
          service={service}
          sessions={sessions}
          messages={messages}
          activityError={activityError}
        />
      ) : (
        <main className="desktop-page" data-page={route} style={{ display: 'grid', alignContent: 'start', justifyItems: 'center', gap: 'var(--space-4)', overflow: 'auto' }}>
          <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-4)', width: 'min(100%, 44rem)', padding: 'var(--space-6) var(--space-6) 0' }}>
            <h1 style={{ margin: 0, color: 'var(--color-ink)', fontSize: 'var(--font-size-xl)' }}>
              {route === 'settings' ? '设置' : '账号'}
            </h1>
            <Button onClick={() => setRoute('workspace')} variant="quiet">返回对话</Button>
          </header>
          {route === 'settings'
            ? <ConnectedSettings
                authStore={authStore}
                composer={clientBundle.composer}
                expectedScope={scope}
                sessions={sessions}
                userId={account.account.user.id}
                workspaceDirectory={workspaceDirectory}
              />
            : <section style={{ width: 'min(100%, 44rem)', padding: '0 var(--space-6) var(--space-6)' }}><AccountPanel store={authStore} /></section>}
        </main>
      )}
    </>
  )
}

function initialWorkspaceDirectory(sessions: SessionStore, accountId: string): string | null {
  const previousScope = sessions.getSnapshot().scope
  if (previousScope?.accountId === accountId && isAbsoluteDirectory(previousScope.workspaceDirectory)) {
    return previousScope.workspaceDirectory
  }
  const preference = readPreferences(accountId).defaultDirectory
  return isAbsoluteDirectory(preference) ? preference : null
}

function createDraftBridge(
  composer: ComposerController,
  messages: MessageStore,
  authStore: DesktopAuthStore,
  runtime: NativeRuntimeClient,
) {
  return {
    captureUncreatedSessionDraft(scope: SessionScope): string | null {
      const snapshot = composer.getSnapshot()
      return snapshot.sessionId === null
        && snapshot.scope !== null
        && snapshot.scope.accountId === scope.accountId
        && snapshot.scope.connectionGeneration === scope.connectionGeneration
        ? snapshot.draft
        : null
    },
    preserveForCreatedSession(scope: SessionScope, sessionId: ConversationSessionId, draft: string): void {
      const accountState = authStore.getSnapshot().accountState
      if (runtime.getSnapshot().connectionGeneration !== scope.connectionGeneration
        || accountState.status !== 'signedIn'
        || accountState.account.user.id !== scope.accountId) return
      messages.setDraftFor(scope, sessionId, draft)
    },
  }
}

function ConnectedSettings({
  authStore,
  composer,
  expectedScope,
  sessions,
  userId,
  workspaceDirectory,
}: {
  readonly authStore: DesktopAuthStore
  readonly composer: ComposerController
  readonly expectedScope: SessionScope
  readonly sessions: SessionStore
  readonly userId: string
  readonly workspaceDirectory: string | null
}) {
  const composerSnapshot = useSyncExternalStore(composer.subscribe, composer.getSnapshot, composer.getSnapshot)
  const sessionSnapshot = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot, sessions.getSnapshot)
  const scopeIsCurrent = sameSessionScope(sessionSnapshot.scope, expectedScope)
    && sameSessionScope(composerSnapshot.scope, expectedScope)
  const modelSource: ModelOptionSource = !scopeIsCurrent
    ? { status: 'unavailable' }
    : composerSnapshot.catalogStatus === 'loading'
      ? { status: 'loading' }
      : composerSnapshot.catalogStatus === 'ready' && composerSnapshot.catalog !== null
        ? {
            status: 'ready',
            options: getComposerModelOptions(composerSnapshot.catalog).map(option => ({
              id: option.key,
              label: option.label,
            })),
          }
        : { status: 'unavailable' }

  const directoryOptions = new Map<string, { path: string; label: string }>()
  if (scopeIsCurrent && isAbsoluteDirectory(workspaceDirectory)) {
    directoryOptions.set(workspaceDirectory, { path: workspaceDirectory, label: workspaceDirectory })
  }
  if (scopeIsCurrent) {
    for (const session of sessionSnapshot.sessions) {
      if (isAbsoluteDirectory(session.cwd)) {
        directoryOptions.set(session.cwd, { path: session.cwd, label: session.cwd })
      }
    }
  }
  const directorySource: DirectoryOptionSource = !scopeIsCurrent
    ? { status: 'unavailable' }
    : directoryOptions.size > 0 || sessionSnapshot.listStatus === 'ready'
      ? { status: 'ready', options: [...directoryOptions.values()] }
      : sessionSnapshot.listStatus === 'loading'
        ? { status: 'loading' }
        : { status: 'unavailable' }

  return <SettingsPage
    authStore={authStore}
    directorySource={directorySource}
    modelSource={modelSource}
    userId={userId}
  />
}

function isAbsoluteDirectory(path: string | null | undefined): path is string {
  return typeof path === 'string'
    && path.trim().length > 0
    && (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path))
}
