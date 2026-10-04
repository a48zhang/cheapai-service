import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { isTauri } from '@tauri-apps/api/core';
import type { DesktopAccountProblem } from '@sub2api/desktop-contracts';
import { Button } from '../../components/ui/controls';
import { DesktopAccountAdapterError } from '../../adapters/native/account';
import type { DesktopAuthStore } from '../auth/auth-store';
import {
  GeneralPanel,
  type DirectoryOptionSource,
  type ModelOptionSource,
} from './GeneralPanel';
import { AccountPanel } from './AccountPanel';
import { UpdatePanel } from './UpdatePanel';

type SettingsSection = 'general' | 'account' | 'about';

export interface SettingsPageProps {
  readonly userId: string | null;
  readonly modelSource?: ModelOptionSource;
  readonly directorySource?: DirectoryOptionSource;
  readonly appVersion?: string | null;
  readonly authStore?: DesktopAuthStore;
  readonly accountContent?: ReactNode;
  readonly aboutContent?: ReactNode;
  readonly updateContent?: ReactNode;
}

const sectionLabels: Record<SettingsSection, string> = {
  general: '通用',
  account: '账号',
  about: '关于',
};

const unavailableModels: ModelOptionSource = { status: 'unavailable' };
const unavailableDirectories: DirectoryOptionSource = { status: 'unavailable' };

const panelStyle = {
  display: 'grid',
  gap: 'var(--space-5)',
  width: 'min(100%, 44rem)',
  padding: 'var(--space-6)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-lg)',
  background: 'var(--color-surface)',
  boxShadow: 'var(--shadow-panel)',
} as const;

export function SettingsPage({
  userId,
  modelSource = unavailableModels,
  directorySource = unavailableDirectories,
  appVersion = null,
  authStore,
  accountContent,
  aboutContent,
  updateContent,
}: SettingsPageProps) {
  const [section, setSection] = useState<SettingsSection>('general');
  const [nativeVersion, setNativeVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    void getVersion().then(version => {
      if (live) setNativeVersion(version);
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);

  const displayedVersion = nativeVersion ?? appVersion;

  return (
    <main className="desktop-page settings-page" data-page="settings" aria-labelledby="settings-title">
      <div style={{ display: 'grid', gap: 'var(--space-6)', justifyItems: 'center', padding: 'var(--space-8)' }}>
        <header style={{ width: 'min(100%, 44rem)' }}>
          <h1 id="settings-title" style={{ margin: 0, fontSize: 'var(--font-size-2xl)' }}>设置</h1>
        </header>

        {authStore && <AccountRecoveryNotice store={authStore} />}

        <nav
          aria-label="设置分区"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', width: 'min(100%, 44rem)' }}
        >
          {(Object.keys(sectionLabels) as SettingsSection[]).map(key => (
            <Button
              aria-pressed={section === key}
              key={key}
              onClick={() => setSection(key)}
              variant={section === key ? 'primary' : 'quiet'}
            >
              {sectionLabels[key]}
            </Button>
          ))}
        </nav>

        <section aria-label={sectionLabels[section]} style={panelStyle}>
          {section === 'general' && (
            <GeneralPanel
              key={userId && userId.trim() !== '' ? `user:${userId}` : 'anonymous'}
              directorySource={directorySource}
              modelSource={modelSource}
              userId={userId}
            />
          )}
          {section === 'account' && (accountContent ?? (authStore ? <AccountPanel store={authStore} /> : <AccountPlaceholder />))}
          {section === 'about' && (
            <AboutPlaceholder appVersion={displayedVersion}>
              {aboutContent}
              <div data-settings-update-slot="true" style={{ marginTop: 'var(--space-5)' }}>
                {updateContent ?? <UpdatePanel />}
              </div>
            </AboutPlaceholder>
          )}
        </section>
      </div>
    </main>
  );
}

function AccountRecoveryNotice({ store }: { readonly store: DesktopAuthStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [actionError, setActionError] = useState('')
  const state = snapshot.accountState
  const [pending, setPending] = useState(false)
  if (state.status !== 'unavailable') return null

  const problem = state.problem
  const sessionExpired = problem === 'sessionExpired'
  const label = sessionExpired
    ? '返回登录'
    : problem === 'noModels' ? '重新检查可用模型' : '重试账号状态'
  const busy = pending || snapshot.pendingOperation !== null

  async function recover(): Promise<void> {
    setActionError('')
    setPending(true)
    try {
      const next = sessionExpired
        ? await store.logout()
        : problem === 'insufficientBalance' || problem === 'groupUnavailable'
          ? await store.refresh()
          : await store.restore()
      if (sessionExpired && next.status !== 'signedOut') {
        setActionError(next.status === 'unavailable'
          ? accountProblemMessage(next.problem)
          : '退出操作尚未完成，请稍后重试。')
      } else if (!sessionExpired && next.status === 'unavailable') {
        setActionError(accountProblemMessage(next.problem))
      }
    } catch (cause: unknown) {
      setActionError(accountProblemMessage(cause instanceof DesktopAccountAdapterError
        ? cause.problem : 'serviceUnavailable'))
    } finally {
      setPending(false)
    }
  }

  return (
    <section role="alert" aria-label="账号恢复" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)', width: 'min(100%, 44rem)', padding: 'var(--space-4)', border: '1px solid var(--color-danger)', borderRadius: 'var(--radius-md)', background: 'var(--color-surface)' }}>
      <div style={{ minWidth: 0, flex: '1 1 18rem' }}>
        <strong>{accountProblemMessage(problem)}</strong>
        <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-sm)' }}>
          {problem === 'noModels'
            ? '重新检查会重新恢复桌面账号与模型目录；不会重放失败的模型请求。'
            : problem === 'insufficientBalance'
              ? '余额状态会单独刷新；应用不会自动重试模型请求。'
              : problem === 'sessionExpired'
                ? '返回登录后可用原账号重新登录；本地草稿仍保留。'
                : '保留当前页面状态，完成检查后再手动继续。'}
        </p>
        {actionError !== '' && <p role="status" style={{ margin: 'var(--space-2) 0 0', color: 'var(--color-danger)', fontSize: 'var(--font-size-sm)' }}>{actionError}</p>}
      </div>
      <Button disabled={busy} onClick={() => { void recover() }} variant="secondary">
        {busy ? '处理中…' : label}
      </Button>
    </section>
  )
}

function accountProblemMessage(problem: DesktopAccountProblem): string {
  switch (problem) {
    case 'network': return '网络暂时不可用，尚未确认账号状态。'
    case 'serviceUnavailable': return '本地账号服务暂时不可用。'
    case 'noModels': return '账号已恢复，但当前没有可用模型。'
    case 'sessionExpired': return '桌面登录已过期或已撤销。'
    case 'keyRevoked': return '模型凭据已失效，桌面服务会恢复当前账号凭据。'
    case 'insufficientBalance': return '账号余额不足，无法继续当前模型请求。'
    case 'groupUnavailable': return '账号所属服务分组暂不可用。'
  }
}

function AccountPlaceholder() {
  return (
    <div>
      <h2 style={{ margin: 0, fontSize: 'var(--font-size-lg)' }}>账号</h2>
      <p style={{ margin: 'var(--space-3) 0 0', color: 'var(--color-ink-muted)' }}>
        账号信息会在登录接入后显示。
      </p>
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 'var(--space-3) var(--space-6)' }}>
        <dt>余额</dt>
        <dd style={{ margin: 0, color: 'var(--color-ink-muted)' }}>未加载</dd>
      </dl>
    </div>
  );
}

function AboutPlaceholder({ appVersion, children }: { readonly appVersion: string | null; readonly children?: ReactNode }) {
  return (
    <div>
      <h2 style={{ margin: 0, fontSize: 'var(--font-size-lg)' }}>关于</h2>
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 'var(--space-3) var(--space-6)' }}>
        <dt>应用版本</dt>
        <dd style={{ margin: 0, color: 'var(--color-ink-muted)' }}>{appVersion?.trim() || '未加载'}</dd>
      </dl>
      {children}
    </div>
  );
}
