import { useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import type { DesktopPublicAccountState } from '@sub2api/desktop-contracts'
import { Button, TextInput } from '../../components/ui/controls'
import { DesktopAccountAdapterError } from '../../adapters/native/account'
import { DesktopAuthStore } from './auth-store'
import './login.css'

export type SignedInAccountState = Extract<DesktopPublicAccountState, { readonly status: 'signedIn' }>

export interface LoginPageProps {
  readonly store: DesktopAuthStore
  /** Route to the signed-in workspace after the native account state is committed. */
  readonly onAuthenticated?: (state: SignedInAccountState) => void | Promise<void>
}

export function LoginPage({ store, onAuthenticated }: LoginPageProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [formError, setFormError] = useState('')
  const [registrationError, setRegistrationError] = useState('')
  const [registrationPending, setRegistrationPending] = useState(false)
  const submitting = useRef(false)
  const composing = useRef(false)
  const nativeAvailable = isTauri()
  const loginPending = snapshot.pendingOperation === 'login'

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (composing.current || submitting.current || loginPending) return
    setFormError('')

    const normalizedEmail = email.trim()
    if (normalizedEmail.length === 0) {
      setFormError('请输入邮箱地址。')
      return
    }
    if (password.length === 0) {
      setFormError('请输入密码。')
      return
    }
    if (!snapshot.available) {
      setPassword('')
      setFormError('浏览器预览不可用账号登录，请在桌面应用中继续。')
      return
    }

    const submittedPassword = password
    setPassword('')
    submitting.current = true
    try {
      const state = await store.login({ email: normalizedEmail, password: submittedPassword })
      if (state.status === 'signedIn') {
        try {
          await onAuthenticated?.(state)
        } catch {
          setFormError('登录已完成，但暂时无法打开工作区。')
        }
        return
      }
      setFormError(state.status === 'unavailable'
        ? accountProblemMessage(state.problem)
        : '无法登录，请检查邮箱和密码后重试。')
    } catch (cause) {
      if (cause instanceof DesktopAccountAdapterError) {
        setFormError(accountProblemMessage(cause.problem))
      } else {
        setFormError('登录暂时无法完成，请稍后重试。')
      }
    } finally {
      submitting.current = false
      setPassword('')
    }
  }

  async function openRegistration(): Promise<void> {
    setRegistrationError('')
    if (!nativeAvailable) {
      setRegistrationError('浏览器预览不支持注册；请在桌面应用中打开注册链接。')
      return
    }
    setRegistrationPending(true)
    try {
      await invoke('open_cheapai_registration')
    } catch {
      setRegistrationError('暂时无法打开注册页面，请稍后重试。')
    } finally {
      setRegistrationPending(false)
    }
  }

  function setComposition(active: boolean): void {
    composing.current = active
  }

  const disabled = loginPending || submitting.current || !snapshot.available
  const fieldsDisabled = loginPending || submitting.current || !snapshot.available

  return (
    <main className="login-page" aria-label="账号登录">
      <section className="login-card">
        <header className="login-header">
          <span className="login-brand-mark" aria-hidden="true">c</span>
          <div>
            <p className="login-eyebrow">CHEAPAI.DEV DESKTOP</p>
            <h1 className="login-title">登录你的账号</h1>
          </div>
        </header>

        <p className="login-intro">
          登录后即可使用桌面工作区。你的账号凭据由桌面宿主安全保存。
        </p>

        {!snapshot.available && (
          <p className="login-unavailable" role="status">
            浏览器预览不发送账号请求；请在 Tauri 桌面应用中登录。
          </p>
        )}

        <form className="login-form" onSubmit={event => { void submit(event) }}>
          <TextInput
            autoComplete="username"
            autoCapitalize="none"
            className="login-input"
            disabled={fieldsDisabled}
            inputMode="email"
            label="邮箱"
            name="email"
            onChange={event => setEmail(event.currentTarget.value)}
            onCompositionEnd={() => setComposition(false)}
            onCompositionStart={() => setComposition(true)}
            placeholder="name@example.com"
            required
            type="email"
            value={email}
          />

          <TextInput
            autoComplete="current-password"
            className="login-input"
            disabled={fieldsDisabled}
            label="密码"
            name="password"
            onChange={event => setPassword(event.currentTarget.value)}
            onCompositionEnd={() => setComposition(false)}
            onCompositionStart={() => setComposition(true)}
            placeholder="输入密码"
            required
            type="password"
            value={password}
          />

          {formError && <p className="login-error" role="alert">{formError}</p>}

          <Button className="login-submit" disabled={disabled} type="submit" variant="primary">
            {loginPending || submitting.current ? '正在登录…' : '登录'}
          </Button>
        </form>

        <footer className="login-footer">
          <span>还没有账号？</span>
          {nativeAvailable ? (
            <button
              className="login-register-link"
              disabled={registrationPending}
              onClick={() => { void openRegistration() }}
              type="button"
            >
              {registrationPending ? '正在打开…' : '创建账号'}
            </button>
          ) : (
            <span className="login-register-unavailable">桌面应用内注册</span>
          )}
        </footer>
        {registrationError && <p className="login-error" role="alert">{registrationError}</p>}
      </section>
    </main>
  )
}

function accountProblemMessage(problem: string): string {
  switch (problem) {
    case 'network':
      return '网络暂时不可用，请检查连接后重试。'
    case 'sessionExpired':
      return '邮箱或密码不正确，请检查后重试。'
    case 'keyRevoked':
      return '当前账号凭据已失效，请重新登录。'
    case 'insufficientBalance':
      return '账号余额不足，暂时无法继续。'
    case 'groupUnavailable':
      return '账号当前没有可用的服务分组。'
    case 'noModels':
      return '账号已登录，但当前没有可用模型；请检查服务配置后重试。'
    case 'serviceUnavailable':
    default:
      return '账号服务暂时不可用，请稍后重试。'
  }
}
