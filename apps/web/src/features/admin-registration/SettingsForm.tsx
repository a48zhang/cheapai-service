import { useState } from 'react';
import type { AdminRegistrationSettings } from '@cheapai/contracts/registration-admin';
import { Button } from '../../shared/ui/Button';
import { Field } from '../../shared/ui/Field';
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
      className="max-w-xl space-y-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
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
      <h2 className="text-lg font-semibold">注册策略</h2>
      <Field label="注册模式">
        <Select
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
      </Field>
      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={verification}
          onChange={(event) => {
            setVerification(event.target.checked);
            setSaved(false);
          }}
          disabled={busy || !settings.emailAvailable}
        />
        启用邮箱验证
      </label>
      <p className="text-sm text-[var(--color-muted-foreground)]">
        邮件服务：{settings.emailAvailable ? '可用' : '不可用'}
      </p>
      {!settings.valid && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          当前策略配置不完整，请先修复服务端设置。
        </p>
      )}
      {verification && !settings.emailAvailable && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          邮件服务不可用，无法保存启用邮箱验证的策略。
        </p>
      )}
      {error != null && <ApiErrorNotice error={error} />}
      {saved && <p role="status">策略已保存。</p>}
      <Button
        type="submit"
        busy={busy}
        disabled={settings.version === null || (verification && !settings.emailAvailable)}
      >
        保存策略
      </Button>
    </form>
  );
}
