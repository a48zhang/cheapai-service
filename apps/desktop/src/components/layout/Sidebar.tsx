import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button, TextInput } from '../ui/controls'
import { SessionMenu } from '../../features/conversations/SessionMenu'
import {
  SessionService,
  SessionServiceError,
} from '../../features/conversations/session-service'
import {
  SessionStore,
  type ConversationListItem,
} from '../../features/conversations/session-store'
import type { DesktopAuthStore } from '../../features/auth/auth-store'

export interface SidebarProps {
  readonly service: SessionService
  readonly store: SessionStore
  readonly onChooseWorkspace: () => void
  readonly onOpenAccountSettings: () => void
  readonly onOpenSettings: () => void
  readonly accountLabel?: string
  readonly authStore?: DesktopAuthStore
}

type TimeGroupKey = 'today' | 'yesterday' | 'week' | 'month' | 'older'

interface TimeGroup {
  readonly key: TimeGroupKey
  readonly label: string
  readonly sessions: readonly ConversationListItem[]
}

const timeGroupOrder: readonly { readonly key: TimeGroupKey; readonly label: string }[] = [
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨天' },
  { key: 'week', label: '最近 7 天' },
  { key: 'month', label: '最近 30 天' },
  { key: 'older', label: '更早' },
]

const sidebarStyle = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  padding: 'var(--space-4)',
  gap: 'var(--space-4)',
} as const

/** Session navigation over the scoped DSH service/store owned by AppShell. */
export function Sidebar({
  service,
  store,
  onChooseWorkspace,
  onOpenAccountSettings,
  onOpenSettings,
  accountLabel = '账号',
  authStore,
}: SidebarProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [query, setQuery] = useState('')
  const [actionError, setActionError] = useState('')
  const workspaceDirectory = snapshot.scope?.workspaceDirectory ?? null
  const visibleSessions = service.searchLoadedTitles(query)
  const groups = groupSessionsByTime(visibleSessions)

  useEffect(() => {
    void service.refreshSessions().catch(() => undefined)
  }, [service])

  async function createSession(): Promise<void> {
    setActionError('')
    if (workspaceDirectory === null) {
      onChooseWorkspace()
      return
    }
    try {
      await service.createSession()
    } catch (error: unknown) {
      if (error instanceof SessionServiceError && error.code === 'workspace-required') {
        onChooseWorkspace()
        setActionError('请先选择工作目录。')
      } else {
        setActionError('无法创建会话，请检查桌面服务连接后重试。')
      }
    }
  }

  function openSession(sessionId: ConversationListItem['sessionId']): void {
    setActionError('')
    try {
      service.openSession(sessionId)
    } catch {
      setActionError('会话已不在当前目录或连接中，请刷新列表。')
    }
  }

  return (
    <aside aria-label="会话导航" className="desktop-sidebar" style={sidebarStyle}>
      <header style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
          <strong style={{ color: 'var(--color-ink)', fontSize: 'var(--font-size-md)' }}>对话</strong>
          <span
            aria-label={workspaceDirectory === null ? '尚未选择工作目录' : `工作目录：${workspaceDirectory}`}
            title={workspaceDirectory ?? '尚未选择工作目录'}
            style={{ maxWidth: '9rem', overflow: 'hidden', color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-xs)', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {workspaceDirectory === null ? '未选目录' : workspaceDirectory}
          </span>
        </div>
        <Button onClick={() => { void createSession() }} variant="primary" style={{ width: '100%' }}>
          {workspaceDirectory === null ? '选择工作目录' : '＋ 新对话'}
        </Button>
        <TextInput
          aria-label="搜索已加载的会话标题"
          label="搜索标题"
          onChange={event => setQuery(event.currentTarget.value)}
          placeholder="仅搜索已加载标题"
          type="search"
          value={query}
        />
      </header>

      <nav aria-label="会话历史" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <p style={{ margin: '0 0 var(--space-3)', color: 'var(--color-ink-subtle)', fontSize: 'var(--font-size-xs)' }}>
          搜索范围：当前目录已加载的标题
        </p>
        {actionError && <p role="alert" style={{ margin: '0 0 var(--space-3)', color: 'var(--color-danger)', fontSize: 'var(--font-size-xs)' }}>{actionError}</p>}
        {workspaceDirectory === null ? (
          <p style={{ margin: 0, color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-sm)' }}>
            选择工作目录后，可查看该目录的会话并开始新对话。
          </p>
        ) : snapshot.listStatus === 'loading' && snapshot.sessions.length === 0 ? (
          <p role="status" style={{ margin: 0, color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-sm)' }}>正在加载会话…</p>
        ) : snapshot.listStatus === 'error' && snapshot.sessions.length === 0 ? (
          <div style={{ display: 'grid', gap: 'var(--space-2)', color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-sm)' }}>
            <p style={{ margin: 0 }}>会话列表暂时无法加载。</p>
            <Button onClick={() => { void service.refreshSessions().catch(() => undefined) }} variant="quiet">重试</Button>
          </div>
        ) : visibleSessions.length === 0 ? (
          <p role="status" style={{ margin: 0, color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-sm)' }}>
            {query.trim().length > 0 ? '没有匹配的已加载标题。' : '当前目录暂无会话。'}
          </p>
        ) : (
          <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
            {groups.map(group => (
              <section aria-label={group.label} key={group.key}>
                <h2 style={{ margin: '0 0 var(--space-2)', color: 'var(--color-ink-subtle)', fontSize: 'var(--font-size-xs)', fontWeight: 650 }}>
                  {group.label}
                </h2>
                <ul style={{ display: 'grid', gap: 'var(--space-1)', listStyle: 'none', margin: 0, padding: 0 }}>
                  {group.sessions.map(session => (
                    <li key={session.sessionId} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', minWidth: 0 }}>
                      <Button
                        aria-current={snapshot.activeSessionId === session.sessionId ? 'page' : undefined}
                        onClick={() => openSession(session.sessionId)}
                        style={{ flex: 1, minWidth: 0, justifyContent: 'space-between', paddingInline: 'var(--space-2)', textAlign: 'left' }}
                        title={session.title}
                        variant={snapshot.activeSessionId === session.sessionId ? 'primary' : 'quiet'}
                      >
                        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {session.title}
                        </span>
                        {session.running && (
                          <span
                            aria-label="运行中"
                            title="运行中"
                            style={{ flex: '0 0 auto', color: snapshot.activeSessionId === session.sessionId ? 'white' : 'var(--color-primary)', fontSize: 'var(--font-size-xs)' }}
                          >
                            ●
                          </span>
                        )}
                      </Button>
                      <SessionMenu
                        onRename={(sessionId, title) => service.renameSession(sessionId, title)}
                        session={session}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
        {snapshot.listStatus === 'error' && snapshot.sessions.length > 0 && (
          <p role="status" style={{ margin: 'var(--space-3) 0 0', color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-xs)' }}>
            刷新失败，当前显示上次加载的会话。
          </p>
        )}
      </nav>

      <footer style={{ display: 'grid', gap: 'var(--space-2)', borderTop: '1px solid var(--color-border)', paddingTop: 'var(--space-3)' }}>
        <AccountSettingsButton authStore={authStore} fallbackLabel={accountLabel} onClick={onOpenAccountSettings} />
        <Button onClick={onOpenSettings} style={{ justifyContent: 'flex-start', width: '100%' }} variant="quiet">
          设置
        </Button>
      </footer>
    </aside>
  )
}

function AccountSettingsButton({
  authStore,
  fallbackLabel,
  onClick,
}: {
  readonly authStore?: DesktopAuthStore
  readonly fallbackLabel: string
  readonly onClick: () => void
}) {
  if (!authStore) {
    return (
      <Button onClick={onClick} style={{ justifyContent: 'flex-start', width: '100%' }} variant="quiet">
        {fallbackLabel}
      </Button>
    )
  }
  return <BoundAccountSettingsButton authStore={authStore} onClick={onClick} />
}

function BoundAccountSettingsButton({ authStore, onClick }: { readonly authStore: DesktopAuthStore; readonly onClick: () => void }) {
  const snapshot = useSyncExternalStore(authStore.subscribe, authStore.getSnapshot, authStore.getSnapshot)
  const state = snapshot.accountState
  const account = state.status === 'signedIn'
    ? state.account
    : state.status === 'unavailable'
      ? state.account
      : null
  const label = account?.user.email_normalized
    ?? (state.status === 'restoring'
      ? '正在恢复账号…'
      : state.status === 'unavailable'
        ? '账号暂不可用'
        : '未登录')
  const status = state.status === 'signedIn'
    ? '已登录'
    : state.status === 'unavailable'
      ? '连接暂不可用'
      : state.status === 'restoring'
        ? '正在恢复'
        : '未登录'

  return (
    <Button
      onClick={onClick}
      style={{ justifyContent: 'flex-start', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%' }}
      title={`${label} · ${status}`}
      variant="quiet"
    >
      {label} · {status}
    </Button>
  )
}

function groupSessionsByTime(sessions: readonly ConversationListItem[], now = Date.now()): readonly TimeGroup[] {
  const grouped = new Map<TimeGroupKey, ConversationListItem[]>(
    timeGroupOrder.map(({ key }) => [key, []]),
  )
  const today = new Date(now)
  const todayDay = Math.floor(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) / 86_400_000)

  for (const session of sessions) {
    const timestamp = new Date(session.updatedAt)
    const sessionDay = Number.isNaN(timestamp.getTime())
      ? Number.NaN
      : Math.floor(Date.UTC(timestamp.getFullYear(), timestamp.getMonth(), timestamp.getDate()) / 86_400_000)
    const ageInDays = todayDay - sessionDay
    const key: TimeGroupKey = Number.isNaN(ageInDays) || ageInDays > 30
      ? 'older'
      : ageInDays <= 0
        ? 'today'
        : ageInDays === 1
          ? 'yesterday'
          : ageInDays <= 7
            ? 'week'
            : 'month'
    grouped.get(key)?.push(session)
  }

  return timeGroupOrder.flatMap(({ key, label }) => {
    const items = grouped.get(key) ?? []
    return items.length === 0 ? [] : [{ key, label, sessions: items }]
  })
}
