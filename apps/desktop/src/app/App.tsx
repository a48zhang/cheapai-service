import { ThemePicker } from '@cheapai/theme';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { DesktopAccountProblem } from '@sub2api/desktop-contracts'
import { Button } from '../components/ui/controls'
import { NativeRuntimeClient, type NativeRuntimeSnapshot } from '../adapters/native/runtime'
import { DesktopAuthStore } from '../features/auth/auth-store'
import { LoginPage, type SignedInAccountState } from '../features/auth/LoginPage'
import { MessageStore } from '../features/conversations/message-store'
import { SessionStore } from '../features/conversations/session-store'
import { AppShell } from '../components/layout/AppShell'

interface RuntimeOwner {
  readonly id: number
  readonly runtime: NativeRuntimeClient
}

interface RestoreAttempt {
  readonly runtime: NativeRuntimeClient
  readonly hostEpoch: number
  readonly state: 'pending' | 'complete'
}

interface AccountActivation {
  readonly runtime: NativeRuntimeClient
  readonly hostEpoch: number
  readonly accountId: string
}

type LoginRoute = 'workspace' | 'login'

/** Root owner for native Runtime and account restoration; browser preview stays explicitly unavailable. */
export function App() {
  const [authStore] = useState(() => new DesktopAuthStore())
  const [sessions] = useState(() => new SessionStore())
  const [messages] = useState(() => new MessageStore())
  const [runtimeOwner, setRuntimeOwner] = useState<RuntimeOwner | null>(null)
  const ownerSequence = useRef(0)

  useEffect(() => {
    const id = ++ownerSequence.current
    const runtime = new NativeRuntimeClient()
    setRuntimeOwner(current => current === null || current.id < id ? { id, runtime } : current)
    void runtime.initialize().catch(() => undefined)

    return () => {
      runtime.dispose()
      setRuntimeOwner(current => current?.id === id ? null : current)
    }
  }, [])

  if (runtimeOwner === null) {
    return (
      <div className="desktop-app">
        <header className="desktop-header">
          <span className="desktop-brand">cheapai.dev</span>
          <span className="desktop-runtime-status" role="status">正在初始化桌面服务</span>
          <ThemePicker />
        </header>
      </div>
    )
  }

  return (
    <RuntimeApplication
      key={runtimeOwner.id}
      authStore={authStore}
      messages={messages}
      runtime={runtimeOwner.runtime}
      sessions={sessions}
    />
  )
}

function RuntimeApplication({
  runtime,
  authStore,
  sessions,
  messages,
}: {
  readonly runtime: NativeRuntimeClient
  readonly authStore: DesktopAuthStore
  readonly sessions: SessionStore
  readonly messages: MessageStore
}) {
  const runtimeSnapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot)
  const authSnapshot = useSyncExternalStore(authStore.subscribe, authStore.getSnapshot, authStore.getSnapshot)
  const [hostEpoch, setHostEpoch] = useState(0)
  const [restoreRetry, setRestoreRetry] = useState(0)
  const [restoreAttempt, setRestoreAttempt] = useState<RestoreAttempt | null>(null)
  const [activation, setActivation] = useState<AccountActivation | null>(null)
  const [route, setRoute] = useState<LoginRoute>('workspace')
  const [startRetry, setStartRetry] = useState(0)
  const [startError, setStartError] = useState(false)
  const [websiteError, setWebsiteError] = useState(false)
  const lastProcessReady = useRef(false)
  const startAttemptKey = useRef('')
  const lastConfirmedAccountId = useRef<string | null>(null)

  const processReady = runtimeSnapshot.status?.process === 'ready'
  useEffect(() => {
    if (processReady && !lastProcessReady.current) {
      setHostEpoch(epoch => epoch + 1)
    }
    lastProcessReady.current = processReady
  }, [processReady])

  const activateAccount = useCallback((accountId: string): void => {
    const previous = lastConfirmedAccountId.current ?? sessions.getSnapshot().scope?.accountId ?? null
    if (previous !== null && previous !== accountId) {
      sessions.clearForAccountChange(previous)
      messages.clearDraftsForAccount(previous)
    }
    lastConfirmedAccountId.current = accountId
    setActivation({ runtime, hostEpoch, accountId })
  }, [hostEpoch, messages, runtime, sessions])

  useEffect(() => {
    if (!processReady || hostEpoch === 0) return
    let live = true
    setRestoreAttempt({ runtime, hostEpoch, state: 'pending' })
    void authStore.restore().then(state => {
      if (!live) return
      setRestoreAttempt({ runtime, hostEpoch, state: 'complete' })
      if (state.status === 'signedIn') {
        activateAccount(state.account.user.id)
      } else {
        setActivation(current => current?.runtime === runtime && current.hostEpoch === hostEpoch ? null : current)
      }
    }).catch(() => {
      if (!live) return
      setRestoreAttempt({ runtime, hostEpoch, state: 'complete' })
      setActivation(current => current?.runtime === runtime && current.hostEpoch === hostEpoch ? null : current)
    })
    return () => { live = false }
  }, [activateAccount, authStore, hostEpoch, processReady, restoreRetry, runtime])

  const accountState = authSnapshot.accountState
  useEffect(() => {
    if (accountState.status === 'signedOut') setRoute('login')
  }, [accountState.status])
  const accountId = accountState.status === 'signedIn' ? accountState.account.user.id : null
  const activationCurrent = accountId !== null
    && activation?.runtime === runtime
    && activation.hostEpoch === hostEpoch
    && activation.accountId === accountId
  const restoreCurrent = restoreAttempt?.runtime === runtime
    && restoreAttempt.hostEpoch === hostEpoch
  const dshState = runtimeSnapshot.status?.dsh.state
  const dshReady = processReady && dshState === 'ready'
    && runtimeSnapshot.status?.connection !== null

  useEffect(() => {
    if (!activationCurrent || !processReady || dshState === undefined
      || dshState === 'ready' || dshState === 'starting' || dshState === 'stopping') return
    const key = `${hostEpoch}:${accountId}:${startRetry}`
    if (startAttemptKey.current === key) return
    startAttemptKey.current = key
    setStartError(false)
    void runtime.start().catch(() => setStartError(true))
  }, [accountId, activationCurrent, dshState, hostEpoch, processReady, runtime, startRetry])

  const runtimeLabel = getRuntimeLabel(runtimeSnapshot)

  if (runtimeSnapshot.mode === 'browser') {
    return (
      <div className="desktop-app" data-route="unavailable">
        <header className="desktop-header">
          <span className="desktop-brand">cheapai.dev</span>
          <span className="desktop-runtime-status" role="status">桌面服务不可用</span>
          <ThemePicker />
        </header>
        <StatusPanel
          title="请使用桌面应用"
          message="浏览器预览没有本地 Runtime 或账号凭据，无法连接 DSH 会话服务。"
        />
      </div>
    )
  }

  const retryHost = (): void => {
    if (runtimeSnapshot.error !== null || runtimeSnapshot.status === null) {
      void runtime.initialize().catch(() => undefined)
    } else {
      void runtime.restart().catch(() => undefined)
    }
  }

  const retryRestore = (): void => setRestoreRetry(value => value + 1)
  const retryDsh = (): void => {
    if (dshState === 'ready' && runtimeSnapshot.status?.connection === null) {
      void runtime.restart().catch(() => setStartError(true))
    } else {
      setStartRetry(value => value + 1)
    }
  }

  let content: ReactNode
  if (runtimeSnapshot.status === null) {
    content = runtimeSnapshot.error === null
      ? <StatusPanel title="正在连接桌面服务" message="正在初始化本机 Runtime。" />
      : <StatusPanel title="无法连接桌面服务" message="本机 Runtime 没有完成初始化，请重试。" action={<Button onClick={retryHost} variant="primary">重试连接</Button>} />
  } else if (runtimeSnapshot.status.process !== 'ready') {
    content = runtimeSnapshot.status.process === 'failed' || runtimeSnapshot.status.process === 'stopped'
      ? <StatusPanel title="桌面服务暂时不可用" message="本机 Runtime 未运行。请显式重启服务；登录将重新恢复，模型请求不会自动重放。" action={<Button onClick={retryHost} variant="primary">重试启动</Button>} />
      : <StatusPanel title="正在启动桌面服务" message="正在等待本机 Runtime 就绪。" />
  } else if (!restoreCurrent || restoreAttempt?.state === 'pending' || authSnapshot.pendingOperation === 'restore') {
    content = <StatusPanel title="正在恢复账号" message="正在由桌面服务恢复本机账号和模型凭据。" />
  } else if (accountState.status === 'signedOut'
    || (route === 'login' && accountState.status === 'unavailable')) {
    content = (
      <main className="desktop-page" data-page="login">
        <LoginPage
          onAuthenticated={state => {
            activateAccount(state.account.user.id)
            setRoute('workspace')
          }}
          store={authStore}
        />
      </main>
    )
  } else if (accountState.status === 'unavailable') {
    const recovery = accountRecoveryCopy(accountState.problem)
    content = (
      <StatusPanel
        title={recovery.title}
        message={recovery.message}
        action={(
          <>
            {accountState.problem !== 'sessionExpired' && (
              <Button onClick={retryRestore} variant="primary">{recovery.retry}</Button>
            )}
            {accountState.problem === 'insufficientBalance' && (
              <Button onClick={() => {
                setWebsiteError(false)
                void invoke('open_cheapai_console').catch(() => setWebsiteError(true))
              }} variant="quiet">打开账号控制台</Button>
            )}
            {websiteError && <p role="alert">暂时无法打开账号控制台，请稍后重试。</p>}
            <Button onClick={() => setRoute('login')} variant="quiet">前往登录</Button>
          </>
        )}
      />
    )
  } else if (!activationCurrent) {
    content = <StatusPanel title="正在恢复账号" message="请等待桌面服务完成账号激活。" />
  } else if (!dshReady) {
    const failed = dshState === 'failed' || dshState === 'stopped' || startError
      || (dshState === 'ready' && runtimeSnapshot.status?.connection === null)
    content = (
      <StatusPanel
        title={failed ? 'DSH 会话服务未启动' : '正在启动 DSH 会话服务'}
        message={failed
          ? '账号已恢复，但 DSH 没有报告可用连接。现有本地会话保持在 DSH 中。'
          : '账号已恢复，正在等待 DSH 建立真实会话连接。'}
        action={failed
          ? <Button onClick={retryDsh} variant="primary">重试启动</Button>
          : undefined}
      />
    )
  } else {
    content = (
      <AppShell
        key={`${runtimeSnapshot.connectionGeneration}:${accountId}`}
        account={accountState as SignedInAccountState}
        authStore={authStore}
        messages={messages}
        runtime={runtime}
        sessions={sessions}
      />
    )
  }

  return (
    <div className="desktop-app" data-route={contentRoute(accountState, route, dshReady)}>
      <header className="desktop-header">
        <span className="desktop-brand">cheapai.dev</span>
        <span className="desktop-runtime-status" role="status" aria-live="polite">{runtimeLabel}</span>
        <ThemePicker />
      </header>
      {content}
    </div>
  )
}

function StatusPanel({
  title,
  message,
  action,
}: {
  readonly title: string
  readonly message: string
  readonly action?: ReactNode
}) {
  return (
    <main className="desktop-page" style={{ display: 'grid', placeItems: 'center' }}>
      <section className="workspace-empty" role={action === undefined ? 'status' : 'alert'}>
        <h1>{title}</h1>
        <p>{message}</p>
        {action && <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 'var(--space-2)' }}>{action}</div>}
      </section>
    </main>
  )
}

function getRuntimeLabel(snapshot: NativeRuntimeSnapshot): string {
  if (snapshot.mode === 'browser') return '桌面服务不可用'
  if (snapshot.status === null) return snapshot.error === null ? '正在连接桌面服务' : '桌面服务暂时不可用'
  if (snapshot.status.process !== 'ready') return snapshot.status.process === 'failed'
    ? '桌面服务暂时不可用'
    : '正在启动桌面服务'
  if (snapshot.status.dsh.state === 'ready' && snapshot.status.connection !== null) return 'DSH 会话服务已连接'
  if (snapshot.status.dsh.state === 'failed') return 'DSH 会话服务暂时不可用'
  return '正在连接 DSH 会话服务'
}

function contentRoute(
  accountState: ReturnType<DesktopAuthStore['getSnapshot']>['accountState'],
  route: LoginRoute,
  dshReady: boolean,
): string {
  if (accountState.status === 'signedOut' || accountState.status === 'unavailable') return route === 'login' ? 'login' : 'startup'
  return dshReady ? 'workspace' : 'startup'
}

function accountRecoveryCopy(problem: DesktopAccountProblem): { title: string; message: string; retry: string } {
  switch (problem) {
    case 'network': return { title: '网络暂时不可用', message: '账号信息暂时无法刷新。检查连接后重试；输入和本地历史会保留。', retry: '重试连接' }
    case 'serviceUnavailable': return { title: '账号服务暂时不可用', message: '账号服务或本地模型配置未能完成。请重试恢复；输入和本地历史会保留。', retry: '重试恢复' }
    case 'sessionExpired': return { title: '桌面登录已失效', message: '桌面登录已自然到期或已撤销。请重新登录后继续。', retry: '重试恢复' }
    case 'keyRevoked': return { title: '模型 Key 已撤销', message: '当前模型 Key 已被撤销，重试不会自动创建替代 Key。请检查账号凭据后重新登录。', retry: '重新检查凭据' }
    case 'insufficientBalance': return { title: '账号余额不足', message: '账号服务报告余额不足。可打开控制台查看真实余额，充值后重新检查；失败请求不会自动重放。', retry: '刷新账号余额' }
    case 'groupUnavailable': return { title: '账号服务分组不可用', message: '账号当前没有可用服务分组。确认账号配置后重新检查。', retry: '重新检查账号' }
    case 'noModels': return { title: '当前账号没有可用模型', message: '账号已恢复，但当前模型目录为空。确认模型配置后重新检查。', retry: '重新检查可用模型' }
  }
}
