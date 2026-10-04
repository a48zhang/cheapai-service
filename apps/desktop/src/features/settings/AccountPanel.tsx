import { useState, useSyncExternalStore } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import type { DesktopAccountProblem, DesktopPublicAccountState } from '@sub2api/desktop-contracts'
import { DesktopAccountAdapterError } from '../../adapters/native/account'
import { Button } from '../../components/ui/controls'
import type { DesktopAuthStore } from '../auth/auth-store'

export interface AccountPanelProps {
  readonly store: DesktopAuthStore
}

const detailsStyle = {
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr)',
  gap: 'var(--space-3) var(--space-6)',
  margin: 'var(--space-5) 0',
} as const

const actionStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--space-2)',
} as const

/** Account details are rendered only from the safe public account store. */
export function AccountPanel({ store }: AccountPanelProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [actionError, setActionError] = useState('')
  const account = stateAccount(snapshot.accountState)
  const expiresAt = stateExpiry(snapshot.accountState)
  const nativeAvailable = snapshot.available && isTauri()
  const busy = snapshot.pendingOperation !== null
  const restoring = snapshot.accountState.status === 'restoring' || snapshot.pendingOperation === 'restore'

  async function refreshAccount(): Promise<void> {
    setActionError('')
    try {
      await store.refresh()
    } catch (cause: unknown) {
      setActionError(problemMessage(cause instanceof DesktopAccountAdapterError
        ? cause.problem
        : 'serviceUnavailable'))
    }
  }

  async function logout(): Promise<void> {
    setActionError('')
    try {
      const next = await store.logout()
      if (next.status !== 'signedOut') {
        setActionError(next.status === 'unavailable'
          ? problemMessage(next.problem)
          : '退出操作尚未完成，请检查连接后重试。')
      }
    } catch (cause: unknown) {
      setActionError(problemMessage(cause instanceof DesktopAccountAdapterError
        ? cause.problem
        : 'serviceUnavailable'))
    }
  }

  async function openConsole(): Promise<void> {
    setActionError('')
    if (!isTauri()) {
      setActionError('网页环境无法打开桌面网页控制台。')
      return
    }
    try {
      await invoke('open_cheapai_console')
    } catch {
      setActionError('无法打开网页控制台，请稍后重试。')
    }
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <header>
        <h2 style={{ margin: 0, fontSize: 'var(--font-size-lg)' }}>账号</h2>
        <p style={{ margin: 'var(--space-2) 0 0', color: 'var(--color-ink-muted)' }}>
          显示当前桌面客户端使用的账号状态。
        </p>
      </header>

      {!nativeAvailable && (
        <p role="status" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>
          当前环境未提供桌面账号服务；请在桌面应用中登录和管理账号。
        </p>
      )}

      {snapshot.accountState.status === 'signedOut' && !restoring && (
        <p role="status" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>
          当前没有登录桌面账号。
        </p>
      )}
      {restoring && (
        <p role="status" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>
          正在恢复桌面账号状态…
        </p>
      )}

      {account && (
        <dl style={detailsStyle}>
          <dt>邮箱</dt>
          <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{account.user.email_normalized}</dd>
          <dt>余额</dt>
          <dd style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>{formatBalance(account.balance.balance_units)}</dd>
          <dt>分组</dt>
          <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>
            {account.user.group_id}（{account.user.group_status === 'active' ? '可用' : '已停用'}）
          </dd>
          <dt>账号状态</dt>
          <dd style={{ margin: 0 }}>
            {account.user.status === 'active' ? '正常' : '已停用'} · {account.user.role === 'admin' ? '管理员' : '普通用户'}
          </dd>
          {expiresAt !== null && (
            <>
              <dt>登录有效期至</dt>
              <dd style={{ margin: 0 }}>{formatExpiry(expiresAt)}</dd>
            </>
          )}
        </dl>
      )}

      {snapshot.accountState.status === 'unavailable' && (
        <p role="status" style={{ margin: 0, color: 'var(--color-danger)' }}>
          {problemMessage(snapshot.accountState.problem)}
          {snapshot.accountState.account !== null ? ' 已保留上次读取的账号和余额。' : ''}
        </p>
      )}

      <p style={{ margin: 0, color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-sm)' }}>
        模型 Key 由桌面服务按需获取；此页面不会显示或管理 Key。
      </p>

      {actionError && (
        <p role="alert" style={{ margin: 0, color: 'var(--color-danger)' }}>{actionError}</p>
      )}

      <div style={actionStyle}>
        {(snapshot.accountState.status === 'signedIn' || snapshot.accountState.status === 'unavailable') && (
          <Button disabled={!nativeAvailable || busy} onClick={() => { void refreshAccount() }} variant="secondary">
            {snapshot.pendingOperation === 'refresh' ? '正在刷新…' : '刷新账号信息'}
          </Button>
        )}
        <Button disabled={!isTauri()} onClick={() => { void openConsole() }} variant="quiet">
          打开网页控制台
        </Button>
        {snapshot.accountState.status !== 'signedOut' && nativeAvailable && (
          <Button disabled={busy} onClick={() => { void logout() }} variant="quiet">
            {snapshot.pendingOperation === 'logout' ? '正在退出…' : '退出当前桌面账号'}
          </Button>
        )}
      </div>
    </div>
  )
}

function stateAccount(state: DesktopPublicAccountState) {
  if (state.status === 'signedIn') return state.account
  return state.status === 'unavailable' ? state.account : null
}

function stateExpiry(state: DesktopPublicAccountState): number | null {
  if (state.status === 'signedIn') return state.expiresAt
  return state.status === 'unavailable' ? state.expiresAt : null
}

function formatBalance(value: string): string {
  if (!/^(?:0|-?[1-9][0-9]*)$/u.test(value)) return '金额未知'
  try {
    const units = BigInt(value)
    const negative = units < 0n
    const digits = (negative ? -units : units).toString().padStart(9, '0')
    return `${negative ? '-' : ''}${digits.slice(0, -8)}.${digits.slice(-8)} USD`
  } catch {
    return '金额未知'
  }
}

function formatExpiry(timestamp: number): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString()
}

function problemMessage(problem: DesktopAccountProblem): string {
  switch (problem) {
    case 'network': return '网络暂时不可用，请检查连接后重试。'
    case 'serviceUnavailable': return '桌面账号服务暂时不可用，请稍后重试。'
    case 'noModels': return '当前账号没有可用模型，请检查模型配置后重试。'
    case 'sessionExpired': return '桌面登录已过期或已撤销，请重新登录。'
    case 'keyRevoked': return '当前模型凭据已撤销，请刷新账号状态。'
    case 'insufficientBalance': return '账号余额不足，暂时无法继续使用模型服务。'
    case 'groupUnavailable': return '账号所属分组暂不可用。'
  }
}
