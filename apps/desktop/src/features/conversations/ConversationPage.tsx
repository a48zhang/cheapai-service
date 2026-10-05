import { useMemo, useState, useSyncExternalStore } from 'react'
import { Button } from '../../components/ui/controls'
import { Sidebar } from '../../components/layout/Sidebar'
import type { DesktopAccountProblem, DesktopPublicAccountState } from '@sub2api/desktop-contracts'
import { DesktopAccountAdapterError } from '../../adapters/native/account'
import type { DesktopAuthStore } from '../auth/auth-store'
import type { DshClient } from '../../adapters/dsh/client'
import type { WorkspaceDirectoryAdapter } from '../../adapters/native/directories'
import { createWorkspaceDirectoryAdapter } from '../../adapters/native/directories'
import { Composer } from './Composer'
import type { ComposerController } from './composer-controller'
import { ConversationEventProjection } from './event-projection'
import { MessageList } from './MessageList'
import type { MessageStore } from './message-store'
import { ToolCall } from './ToolCall'
import type { SessionService } from './session-service'
import { SessionStore, type ConversationSessionId } from './session-store'
import { WorkspacePicker } from '../workspace/WorkspacePicker'

export interface ConversationPageProps {
  readonly accountLabel: string
  readonly authStore: DesktopAuthStore
  readonly client: DshClient
  readonly service: SessionService
  readonly sessions: SessionStore
  readonly messages: MessageStore
  readonly projection: ConversationEventProjection
  readonly composer: ComposerController
  readonly onOpenSettings: () => void
  readonly onOpenAccountSettings: () => void
  readonly onDirectorySelected: (directory: string) => void | Promise<void>
  readonly onCreateSessionAtDirectory: (directory: string) => void | Promise<void>
  readonly onOpenInteraction: (callId: string) => void
  readonly activityError?: string | null
}

/** The selected DSH Session's complete desktop workspace and input surface. */
export function ConversationPage({
  accountLabel,
  authStore,
  client,
  service,
  sessions,
  messages,
  projection,
  composer,
  onOpenSettings,
  onOpenAccountSettings,
  onDirectorySelected,
  onCreateSessionAtDirectory,
  onOpenInteraction,
  activityError = null,
}: ConversationPageProps) {
  const sessionSnapshot = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot, sessions.getSnapshot)
  const authSnapshot = useSyncExternalStore(authStore.subscribe, authStore.getSnapshot, authStore.getSnapshot)
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false)
  const [accountActionError, setAccountActionError] = useState('')
  const [accountActionPending, setAccountActionPending] = useState(false)
  const directory = sessionSnapshot.scope?.workspaceDirectory ?? null
  const activeSessionId = sessionSnapshot.activeSessionId
  const activeSession = sessionSnapshot.sessions.find(session => session.sessionId === activeSessionId)
  const workspaceAdapter: WorkspaceDirectoryAdapter = useMemo(() => createWorkspaceDirectoryAdapter({
    workspaceFiles: client.remote.workspaceFiles,
    existingSession: activeSessionId !== null && directory !== null
      ? { sessionId: activeSessionId, cwd: directory }
      : null,
  }), [activeSessionId, client, directory])

  async function createSessionForFirstPrompt(): Promise<ConversationSessionId | null> {
    if (directory === null) {
      setWorkspacePickerOpen(true)
      return null
    }
    return (await service.createSession()).sessionId
  }

  async function recoverAccount(problem: DesktopAccountProblem): Promise<void> {
    setAccountActionError('')
    setAccountActionPending(true)
    try {
      if (problem === 'sessionExpired') await authStore.logout()
      else if (problem === 'insufficientBalance' || problem === 'groupUnavailable') await authStore.refresh()
      else await authStore.restore()
    } catch (cause: unknown) {
      setAccountActionError(accountProblemMessage(cause instanceof DesktopAccountAdapterError
        ? cause.problem : 'serviceUnavailable'))
    } finally {
      setAccountActionPending(false)
    }
  }

  const accountProblem = authSnapshot.accountState.status === 'unavailable'
    ? authSnapshot.accountState.problem : null
  const publicAccount = publicAccountFromState(authSnapshot.accountState)
  const exactZeroBalance = publicAccount !== null && isZeroBalance(publicAccount.balance.balance_units)

  return (
    <div className="desktop-layout" style={{ height: '100%' }}>
      <Sidebar
        accountLabel={accountLabel}
        authStore={authStore}
        onChooseWorkspace={() => setWorkspacePickerOpen(true)}
        onOpenAccountSettings={onOpenAccountSettings}
        onOpenSettings={onOpenSettings}
        service={service}
        store={sessions}
      />
      <main
        aria-label="对话工作区"
        className="desktop-workspace"
        style={{ display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr) auto', placeItems: 'stretch', minWidth: 0, padding: 0 }}
      >
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-4)', minWidth: 0, padding: 'var(--space-4) var(--space-6)', borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface)' }}>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ margin: 0, overflow: 'hidden', color: 'var(--color-ink)', fontSize: 'var(--font-size-lg)', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {activeSession?.title ?? (activeSessionId === null ? '开始新的对话' : '新对话')}
            </h1>
            <p style={{ margin: 'var(--space-1) 0 0', overflow: 'hidden', color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-xs)', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {directory ?? '尚未选择工作目录'}
            </p>
            {activityError !== null && (
              <p role="status" style={{ margin: 'var(--space-1) 0 0', color: 'var(--color-danger)', fontSize: 'var(--font-size-xs)' }}>
                暂时无法同步所有会话的运行状态；当前对话仍可使用。
              </p>
            )}
            {exactZeroBalance && (
              <p role="status" style={{ margin: 'var(--space-1) 0 0', color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-xs)' }}>
                账号余额为 0；余额信息与模型服务的实际响应分别显示。
              </p>
            )}
            {accountProblem !== null && (
              <div role="alert" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                <span style={{ color: 'var(--color-danger)', fontSize: 'var(--font-size-xs)' }}>{accountProblemMessage(accountProblem)}</span>
                <Button disabled={accountActionPending || authSnapshot.pendingOperation !== null}
                  onClick={() => { void recoverAccount(accountProblem) }} variant="quiet">
                  {accountActionPending ? '正在处理…' : accountProblem === 'sessionExpired' ? '返回登录' : '重试账号恢复'}
                </Button>
                {accountActionError !== '' && <span style={{ color: 'var(--color-danger)', fontSize: 'var(--font-size-xs)' }}>{accountActionError}</span>}
              </div>
            )}
          </div>
          <Button onClick={() => setWorkspacePickerOpen(true)} variant="quiet">
            {directory === null ? '选择目录' : '更改目录'}
          </Button>
        </header>

        <MessageList
          onLoadOlder={() => projection.loadOlder()}
          renderToolEvent={entry => (
            <ToolCall
              entry={entry}
              events={messages.getSnapshot().toolEvents}
              onOpenInteraction={onOpenInteraction}
            />
          )}
          store={messages}
        />
        <Composer
          controller={composer}
          onCreateSession={createSessionForFirstPrompt}
        />
      </main>

      {workspacePickerOpen && (
        <div
          aria-label="工作目录选择"
          aria-modal="true"
          role="dialog"
          style={{ position: 'fixed', inset: 0, zIndex: 10, display: 'grid', placeItems: 'center', overflow: 'auto', padding: 'var(--space-6)', background: 'var(--color-overlay)' }}
        >
          <section style={{ display: 'grid', gap: 'var(--space-4)', width: 'min(100%, 38rem)', maxHeight: 'min(90vh, 54rem)', overflow: 'auto', padding: 'var(--space-5)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)', boxShadow: 'var(--shadow-panel)' }}>
            <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
              <h2 style={{ margin: 0, fontSize: 'var(--font-size-lg)' }}>选择工作目录</h2>
              <Button onClick={() => setWorkspacePickerOpen(false)} variant="quiet">关闭</Button>
            </header>
            <WorkspacePicker
              activeSessionId={activeSessionId}
              adapter={workspaceAdapter}
              currentDirectory={directory}
              onCreateSessionAtDirectory={onCreateSessionAtDirectory}
              onDirectorySelected={onDirectorySelected}
            />
          </section>
        </div>
      )}
    </div>
  )
}

function publicAccountFromState(state: DesktopPublicAccountState) {
  if (state.status === 'signedIn') return state.account
  return state.status === 'unavailable' ? state.account : null
}

function isZeroBalance(value: string): boolean {
  if (!/^-?\d+$/u.test(value)) return false
  try { return BigInt(value) === 0n } catch { return false }
}

function accountProblemMessage(problem: DesktopAccountProblem): string {
  switch (problem) {
    case 'network': return '网络暂时不可用，账号状态尚未确认。'
    case 'serviceUnavailable': return '本地账号服务暂时不可用。'
    case 'noModels': return '账号已恢复，但当前没有可用模型。'
    case 'sessionExpired': return '桌面登录已过期或已撤销。'
    case 'keyRevoked': return '模型凭据已失效，桌面服务会重新恢复凭据。'
    case 'insufficientBalance': return '账号余额不足，模型服务拒绝了当前请求。'
    case 'groupUnavailable': return '账号所属服务分组暂不可用。'
  }
}
