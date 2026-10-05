import { ThemePicker } from '@cheapai/theme';
import { useState } from 'react';
import { readPreferences, savePreferences, type DesktopPreferences, type DesktopPreferencePatch } from './preferences';

export interface DesktopModelOption {
  readonly id: string;
  readonly label: string;
}

export interface DesktopDirectoryOption {
  readonly path: string;
  readonly label?: string;
}

export type OptionSource<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'ready'; readonly options: readonly T[] };

export type ModelOptionSource = OptionSource<DesktopModelOption>;
export type DirectoryOptionSource = OptionSource<DesktopDirectoryOption>;

export interface GeneralPanelProps {
  readonly userId: string | null;
  readonly modelSource: ModelOptionSource;
  readonly directorySource: DirectoryOptionSource;
}

export function GeneralPanel({ userId, modelSource, directorySource }: GeneralPanelProps) {
  const [preferences, setPreferences] = useState<DesktopPreferences>(() => readPreferences(userId));
  const [saveError, setSaveError] = useState('');

  function update(patch: DesktopPreferencePatch): void {
    const next = { ...preferences, ...patch };
    setPreferences(next);
    try {
      setPreferences(savePreferences(userId, patch));
      setSaveError('');
    } catch {
      setSaveError('偏好暂时无法保存到本机。');
    }
  }

  const selectedModelIsAvailable = modelSource.status === 'ready'
    && modelSource.options.some(option => option.id === preferences.defaultModelId);
  const selectedDirectoryIsAvailable = directorySource.status === 'ready'
    && directorySource.options.some(option => option.path === preferences.defaultDirectory);

  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 'var(--font-size-lg)' }}>通用设置</h2>
        <p style={{ margin: 'var(--space-2) 0 0', color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-sm)' }}>
          设置保存在本机，不会与对话历史或其他账号混存。
        </p>
      </div>

      <div className="ui-field"><span>外观</span><ThemePicker compact={false} /></div>

      <label className="ui-field" htmlFor="default-model">
        <span>默认模型</span>
        <select
          className="ui-input"
          id="default-model"
          onChange={event => update({ defaultModelId: event.currentTarget.value || null })}
          value={preferences.defaultModelId ?? ''}
        >
          <option value="">不指定默认模型</option>
          {modelSource.status === 'ready' && modelSource.options.map(option => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
          {preferences.defaultModelId !== null && !selectedModelIsAvailable && (
            <option disabled value={preferences.defaultModelId}>
              {preferences.defaultModelId}（当前模型目录中不可用）
            </option>
          )}
        </select>
      </label>
      <p className="settings-source-state" style={{ marginTop: 'calc(var(--space-4) * -1)', marginBottom: 0, color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-xs)' }}>
        {sourceStatusText('模型目录', modelSource)}
      </p>

      <label className="ui-field" htmlFor="default-directory">
        <span>默认工作目录</span>
        <select
          className="ui-input"
          id="default-directory"
          onChange={event => update({ defaultDirectory: event.currentTarget.value || null })}
          value={preferences.defaultDirectory ?? ''}
        >
          <option value="">不指定默认目录</option>
          {directorySource.status === 'ready' && directorySource.options.map(option => (
            <option key={option.path} value={option.path}>{option.label ?? option.path}</option>
          ))}
          {preferences.defaultDirectory !== null && !selectedDirectoryIsAvailable && (
            <option disabled value={preferences.defaultDirectory}>
              {preferences.defaultDirectory}（当前目录列表中不可用）
            </option>
          )}
        </select>
      </label>
      <p className="settings-source-state" style={{ marginTop: 'calc(var(--space-4) * -1)', marginBottom: 0, color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-xs)' }}>
        {sourceStatusText('工作目录列表', directorySource)}
      </p>

      {saveError && <p role="status" style={{ margin: 0, color: 'var(--color-danger)', fontSize: 'var(--font-size-sm)' }}>{saveError}</p>}
    </div>
  );
}

function sourceStatusText<T>(label: string, source: OptionSource<T>): string {
  switch (source.status) {
    case 'loading':
      return `${label}正在加载。`;
    case 'unavailable':
      return `${label}尚未加载。`;
    case 'ready':
      return source.options.length === 0 ? `当前没有可用的${label}。` : `选项来自当前连接的桌面服务。`;
  }
}
