import type { AuditEntry } from '@cheapai/contracts/audit';
import { Sheet } from '../../shared/ui/Sheet';
import { formatDateTime } from '../../shared/lib/datetime';
import { auditActionLabel, auditTargetLabel, auditFieldLabels } from './labels';

function showValue(value: unknown, field: string): string {
  if (value === undefined) return '未记录';
  if (value === null) return '无';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (
    (field === 'concurrency_limit' ||
      field === 'rpm_limit' ||
      field === 'concurrencyLimit' ||
      field === 'rpmLimit') &&
    (value === Number.MAX_SAFE_INTEGER || value === String(Number.MAX_SAFE_INTEGER))
  )
    return '不限';
  if (typeof value === 'string') {
    const labels: Record<string, Record<string, string>> = {
      status: { active: '启用', disabled: '停用', revoked: '已撤销' },
      role: { admin: '管理员', user: '普通用户' },
      registration_mode: { open: '开放注册', invite_only: '邀请码注册', closed: '关闭注册' },
    };
    return labels[field]?.[value] ?? (value || '空');
  }
  return JSON.stringify(value, null, 2);
}
interface AuditChange {
  key: string;
  before: unknown;
  after: unknown;
  paired: boolean;
}
function changesOf(changes: Record<string, unknown>): AuditChange[] {
  const before = changes.before;
  const after = changes.after;
  if (
    (Object.hasOwn(changes, 'before') || Object.hasOwn(changes, 'after')) &&
    (before === null || before === undefined || typeof before === 'object') &&
    (after === null || after === undefined || typeof after === 'object')
  ) {
    const previous = (before ?? {}) as Record<string, unknown>;
    const next = (after ?? {}) as Record<string, unknown>;
    const comparison = [...new Set([...Object.keys(previous), ...Object.keys(next)])].map(
      (key) => ({
        key,
        before: previous[key],
        after: next[key],
        paired: true,
      }),
    );
    const extra = Object.fromEntries(
      Object.entries(changes).filter(([key]) => key !== 'before' && key !== 'after'),
    );
    return [...comparison, ...changesOf(extra)];
  }
  return Object.entries(changes).map(([key, value]) => {
    const paired =
      value !== null && typeof value === 'object' && ('before' in value || 'after' in value);
    const pair = value as { before?: unknown; after?: unknown };
    return {
      key,
      before: paired ? pair.before : undefined,
      after: paired ? pair.after : value,
      paired,
    };
  });
}

export function AuditChangesSheet({
  entry,
  onClose,
}: {
  entry: AuditEntry | null;
  onClose(): void;
}) {
  const businessChanges = entry?.changes
    ? changesOf(entry.changes).filter(
        (change) =>
          !['version', 'config_version', 'configVersion', 'price_version', 'priceVersion'].includes(
            change.key,
          ) &&
          (change.paired
            ? JSON.stringify(change.before) !== JSON.stringify(change.after)
            : !(change.key.endsWith('_changed') && change.after === false)),
      )
    : [];
  return (
    <Sheet
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="变更详情"
    >
      {entry && (
        <div className="space-y-6">
          <div className="space-y-2">
            <h3 className="text-lg font-semibold">{auditActionLabel(entry.action)}</h3>
            <p className="break-words">{entry.target_name ?? entry.target_id}</p>
            <p className="text-sm text-[var(--color-ink-secondary)]">
              {auditTargetLabel(entry.target_type)} · {formatDateTime(entry.created_at)}
            </p>
            <p className="break-words text-sm text-[var(--color-ink-secondary)]">
              操作者：{entry.actor_email ?? entry.actor_id}
            </p>
          </div>
          {entry.changes ? (
            <div className="space-y-4">
              {businessChanges.map((change) => (
                <section
                  key={change.key}
                  className="rounded-lg border border-[var(--color-border)] p-4"
                >
                  <h4 className="mb-3 font-medium">{auditFieldLabels[change.key] ?? change.key}</h4>
                  <div className={`grid gap-3 ${change.paired ? 'sm:grid-cols-2' : ''}`}>
                    {change.paired && (
                      <ChangeValue label="修改前" value={change.before} field={change.key} />
                    )}
                    <ChangeValue
                      label={change.paired ? '修改后' : '记录内容'}
                      value={change.after}
                      field={change.key}
                    />
                  </div>
                </section>
              ))}
              {!businessChanges.length && (
                <p className="text-[var(--color-ink-secondary)]">无业务字段变更</p>
              )}
            </div>
          ) : (
            <p className="text-[var(--color-ink-secondary)]">此记录的变更内容不可用</p>
          )}
          <details className="border-t border-[var(--color-border)] pt-4">
            <summary className="cursor-pointer text-sm text-[var(--color-ink-secondary)]">
              原始记录
            </summary>
            <dl className="mt-4 grid gap-3 text-sm">
              {[
                ['记录 ID', entry.id],
                ['操作 ID', entry.operation_id],
                ['操作者 ID', entry.actor_id],
                ['目标 ID', entry.target_id],
                ['操作类型', entry.action],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-[var(--color-ink-secondary)]">{label}</dt>
                  <dd className="break-all font-mono">{value}</dd>
                </div>
              ))}
            </dl>
            <pre className="mt-4 overflow-auto rounded-lg bg-[var(--color-surface-subtle)] p-4 whitespace-pre-wrap break-words text-sm">
              {JSON.stringify(entry.changes, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </Sheet>
  );
}
function ChangeValue({ label, value, field }: { label: string; value: unknown; field: string }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-sm text-[var(--color-ink-secondary)]">{label}</p>
      <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6">
        {showValue(value, field)}
      </pre>
    </div>
  );
}
