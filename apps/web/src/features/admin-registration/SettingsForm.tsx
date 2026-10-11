import { useState } from 'react';
import type { AdminRegistrationSettings } from '@cheapai/contracts/registration-admin';
import { Button } from '../../shared/ui/Button';
import { Select } from '../../shared/ui/Select';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';

export function SettingsForm({
  settings,
  onSave,
}: {
  settings: AdminRegistrationSettings;
  onSave: (
    version: number,
    mode: 'closed' | 'open' | 'invite',
    verification: boolean,
  ) => Promise<unknown>;
}) {
  const [mode, setMode] = useState<'closed' | 'open' | 'invite'>(
    settings.registrationMode ?? 'closed',
  );
  const [verification, setVerification] = useState(settings.emailVerificationEnabled ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  return (
    <form
      className="console-panel max-w-4xl overflow-hidden"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || settings.version === null) return;
        setBusy(true);
        setError(null);
        setSaved(false);
        try {
          await onSave(settings.version, mode, verification);
          setSaved(true);
        } catch (failure) {
          setError(failure);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid gap-4 p-5 sm:grid-cols-[1fr_240px] sm:items-center sm:p-6">
        <div>
          <h2 className="text-[15px] font-medium">注册方式</h2>
          <p className="mt-1 text-sm leading-6 text-[var(--color-ink-secondary)]">
            {
              {
                closed: '暂停新用户注册，已有账户仍可登录。',
                open: '任何用户均可创建账户。',
                invite: '新用户需使用有效邀请码创建账户。',
              }[mode]
            }
          </p>
        </div>
        <Select
          aria-label="注册方式"
          value={mode}
          onValueChange={(value) => {
            setMode(value as typeof mode);
            setSaved(false);
          }}
          disabled={busy}
          items={[
            { value: 'closed', label: '关闭注册' },
            { value: 'open', label: '开放注册' },
            { value: 'invite', label: '邀请码注册' },
          ]}
        />
      </div>
      <div className="flex items-center justify-between gap-6 border-t border-[var(--color-border)] p-5 sm:p-6">
        <div>
          <label htmlFor="registration-verification" className="text-[15px] font-medium">
            邮箱验证
          </label>
          <p className="mt-1 text-sm leading-6 text-[var(--color-ink-secondary)]">
            {settings.emailAvailable
              ? '启用后，新用户需要验证邮箱。'
              : '邮件服务不可用，暂时无法启用邮箱验证。'}
          </p>
        </div>
        <button
          id="registration-verification"
          type="button"
          role="switch"
          aria-label="邮箱验证"
          aria-checked={verification}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${verification ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-ink-muted)]'}`}
          onClick={() => {
            setVerification(!verification);
            setSaved(false);
          }}
          disabled={busy || !settings.emailAvailable}
        >
          <span
            aria-hidden="true"
            className={`absolute top-1 size-4 rounded-full bg-white transition-transform ${verification ? 'left-1 translate-x-5' : 'left-1'}`}
          />
        </button>
      </div>
      {!settings.valid && (
        <p role="alert" className="px-6 pb-4 text-sm text-[var(--color-danger)]">
          当前注册设置不完整，请先修复服务端设置。
        </p>
      )}
      {verification && !settings.emailAvailable && (
        <p role="alert" className="px-6 pb-4 text-sm text-[var(--color-danger)]">
          邮件服务不可用，无法保存启用邮箱验证的设置。
        </p>
      )}
      {error != null && <ApiErrorNotice error={error} />}
      <div className="flex flex-wrap items-center gap-4 border-t border-[var(--color-border)] p-5 sm:px-6">
        <Button
          type="submit"
          busy={busy}
          disabled={settings.version === null || (verification && !settings.emailAvailable)}
        >
          保存设置
        </Button>
        {saved && (
          <p className="m-0 text-sm text-[var(--color-success)]" role="status">
            设置已保存
          </p>
        )}
      </div>
    </form>
  );
}
