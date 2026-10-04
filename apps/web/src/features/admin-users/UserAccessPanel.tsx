import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiClientError } from '@cheapai/api-client/errors';
import type { UserListItem } from '@cheapai/api-client/users';
import type { AdminUsersApi } from './api';
import { Button } from '../../shared/ui/Button';
import { Dialog } from '../../shared/ui/Dialog';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { StatusBadge } from '../../shared/ui/StatusBadge';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';

type RevokeIntent = { readonly keyId: string; readonly version: number };
type RevokeResult = Awaited<ReturnType<AdminUsersApi['revokeKey']>>;

export interface UserAccessPanelProps {
  readonly user: UserListItem;
  readonly api: AdminUsersApi;
  readonly onEdit?: () => void;
  readonly onRevoked?: (result: RevokeResult) => void;
}

function isDefinitiveRevokeFailure(error: unknown): boolean {
  return (
    error instanceof ApiClientError &&
    error.status !== null &&
    error.status >= 400 &&
    error.status < 500
  );
}

/** Read-only access summary and explicitly targeted admin Key revocation. */
export function UserAccessPanel({ user, api, onEdit, onRevoked }: UserAccessPanelProps) {
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [keyId, setKeyId] = useState('');
  const [versionText, setVersionText] = useState('');
  const [ownerConfirmation, setOwnerConfirmation] = useState('');
  const [intent, setIntent] = useState<RevokeIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<RevokeResult | null>(null);
  const busyRef = useRef(false);

  const resetRevoke = (open: boolean) => {
    if (busyRef.current) return;
    setRevokeOpen(open);
    if (!open) {
      setKeyId('');
      setVersionText('');
      setOwnerConfirmation('');
      setIntent(null);
      setLocked(false);
      setError(null);
      setResult(null);
    }
  };

  async function revoke(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current || locked) return;
    if (!intent) {
      const normalizedKeyId = keyId.trim();
      const version = Number(versionText);
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(normalizedKeyId) ||
        /s2a_(?:key|session|invite)_/u.test(normalizedKeyId) ||
        !/^[1-9][0-9]*$/u.test(versionText) ||
        !Number.isSafeInteger(version) ||
        version >= Number.MAX_SAFE_INTEGER
      ) {
        setError(new Error('请输入有效的 Key ID 和正整数版本。'));
        return;
      }
      if (ownerConfirmation.trim() !== user.id) {
        setError(new Error('请逐字输入目标用户 ID，确认你已核对 Key 所属用户。'));
        return;
      }
      setIntent({ keyId: normalizedKeyId, version });
    }
    const activeIntent = intent ?? { keyId: keyId.trim(), version: Number(versionText) };
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const revoked = await api.revokeKey(activeIntent.keyId, activeIntent.version);
      setResult(revoked);
      setLocked(true);
      onRevoked?.(revoked);
    } catch (cause) {
      setError(cause);
      if (isDefinitiveRevokeFailure(cause)) setIntent(null);
      else setLocked(true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const ownerMatches = result?.key.userId === user.id;

  return (
    <section className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">访问与授权</h2>
        </div>
        {onEdit && (
          <Button variant="secondary" onClick={onEdit}>
            编辑访问设置
          </Button>
        )}
      </div>
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <dt className="text-xs text-[var(--color-muted-foreground)]">角色</dt>
          <dd className="mt-1 font-medium">{user.role === 'admin' ? '管理员' : '普通用户'}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--color-muted-foreground)]">账户状态</dt>
          <dd className="mt-1">
            {user.status === 'active' ? (
              <StatusBadge tone="success">启用</StatusBadge>
            ) : (
              <StatusBadge>停用</StatusBadge>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--color-muted-foreground)]">默认分组</dt>
          <dd className="mt-1">{user.group_name}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--color-muted-foreground)]">并发上限</dt>
          <dd className="mt-1">
            {user.concurrency_limit === Number.MAX_SAFE_INTEGER ? '不限' : user.concurrency_limit}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--color-muted-foreground)]">每分钟请求上限</dt>
          <dd className="mt-1">
            {user.rpm_limit === Number.MAX_SAFE_INTEGER ? '不限' : user.rpm_limit}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--color-muted-foreground)]">版本</dt>
          <dd className="mt-1">{user.version}</dd>
        </div>
      </dl>
      <div>
        <h3 className="text-sm font-medium">可访问分组 ID</h3>
        <ul className="mt-2 flex flex-wrap gap-2">
          {user.allowed_group_ids.map((id) => (
            <li
              key={id}
              className="rounded-md bg-[var(--color-surface-subtle)] px-2.5 py-1 font-mono text-xs"
            >
              {id}
              {id === user.group_id ? ' · 默认' : ''}
            </li>
          ))}
        </ul>
      </div>
      <div className="border-t border-[var(--color-border)] pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-medium">撤销已有 Key</h3>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--color-muted-foreground)]">
              请先核对 Key ID、版本和所属用户。撤销前无法自动核验所属用户。
            </p>
          </div>
          <Button variant="danger" onClick={() => setRevokeOpen(true)}>
            输入 Key 信息
          </Button>
        </div>
      </div>
      <Dialog
        open={revokeOpen}
        onOpenChange={resetRevoke}
        title="撤销已有 Key"
        description={`目标用户：${user.email_normalized} · ${user.id}`}
        closeLabel="关闭 Key 撤销"
        closeButton={!busy}
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => resetRevoke(false)}>
              关闭
            </Button>
            {!result && (
              <Button
                type="submit"
                form="admin-user-key-revoke"
                variant="danger"
                busy={busy}
                disabled={locked}
              >
                {intent && locked ? '重试同一撤销' : '撤销 Key'}
              </Button>
            )}
          </>
        }
      >
        {result ? (
          <div
            role="status"
            className={`rounded-lg border p-4 text-sm ${ownerMatches ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-300 bg-amber-50 text-amber-950'}`}
          >
            <p className="font-medium">
              {result.kind === 'already_revoked' ? '此 Key 已经撤销。' : 'Key 已撤销。'}
            </p>
            <p className="mt-2">
              Key ID：<code>{result.key.id}</code> · 实际所属用户：<code>{result.key.userId}</code>
            </p>
            {!ownerMatches && (
              <p className="mt-2 font-medium">
                Key 所属用户与当前资料不同。服务端已按输入 ID 完成撤销，请立即核对并联系相关用户。
              </p>
            )}
          </div>
        ) : (
          <form
            id="admin-user-key-revoke"
            className="space-y-4"
            onSubmit={(event) => {
              void revoke(event);
            }}
          >
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
              请确认 Key 属于当前用户，错误的 ID 可能撤销其他用户的 Key。
            </p>
            <Field label="Key ID" required>
              <Input
                value={intent?.keyId ?? keyId}
                onChange={(event) => setKeyId(event.currentTarget.value)}
                required
                maxLength={128}
                autoComplete="off"
                disabled={busy || locked}
              />
            </Field>
            <Field label="Key 版本" required description="填写 Key 当前版本。">
              <Input
                value={intent ? String(intent.version) : versionText}
                onChange={(event) => setVersionText(event.currentTarget.value)}
                required
                inputMode="numeric"
                maxLength={16}
                autoComplete="off"
                disabled={busy || locked}
              />
            </Field>
            <Field label="确认目标用户 ID" required description={`必须精确输入 ${user.id}。`}>
              <Input
                value={ownerConfirmation}
                onChange={(event) => setOwnerConfirmation(event.currentTarget.value)}
                required
                autoComplete="off"
                disabled={busy || locked}
              />
            </Field>
            {error !== null && <ApiErrorNotice error={error} />}
            {intent && locked && (
              <p role="status" className="text-sm text-amber-900">
                结果未确认。重试会复用相同 Key ID 和版本；请勿更换输入。
              </p>
            )}
          </form>
        )}
      </Dialog>
    </section>
  );
}
