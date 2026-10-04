import { useState, type ReactNode } from 'react';
import { Button } from '../../components/ui/controls';
import {
  GeneralPanel,
  type DirectoryOptionSource,
  type ModelOptionSource,
} from './GeneralPanel';

type SettingsSection = 'general' | 'account' | 'about';

export interface SettingsPageProps {
  readonly userId: string | null;
  readonly modelSource?: ModelOptionSource;
  readonly directorySource?: DirectoryOptionSource;
  readonly appVersion?: string | null;
  readonly accountContent?: ReactNode;
  readonly aboutContent?: ReactNode;
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
  accountContent,
  aboutContent,
}: SettingsPageProps) {
  const [section, setSection] = useState<SettingsSection>('general');

  return (
    <main className="desktop-page settings-page" data-page="settings" aria-labelledby="settings-title">
      <div style={{ display: 'grid', gap: 'var(--space-6)', justifyItems: 'center', padding: 'var(--space-8)' }}>
        <header style={{ width: 'min(100%, 44rem)' }}>
          <h1 id="settings-title" style={{ margin: 0, fontSize: 'var(--font-size-2xl)' }}>设置</h1>
        </header>

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
          {section === 'account' && (accountContent ?? <AccountPlaceholder />)}
          {section === 'about' && (
            <AboutPlaceholder appVersion={appVersion}>
              {aboutContent}
            </AboutPlaceholder>
          )}
        </section>
      </div>
    </main>
  );
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
