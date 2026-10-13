import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { AuditEntry, AuditQuery } from '@cheapai/contracts/audit';
import { auditQueryOptions } from '../../features/admin-audit/api';
import { useSession } from '../../features/session/useSession';
import { PageHeader } from '../../shared/patterns/PageHeader';
import { CursorTable } from '../../shared/patterns/CursorTable';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { Button } from '../../shared/ui/Button';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import {
  formatDateTime,
  formatLocalDateTime,
  parseLocalDateRange,
} from '../../shared/lib/datetime';
import { mergePageItems } from '../../shared/lib/pagination';
import type { FormEvent } from 'react';
import { AuditChangesSheet } from '../../features/admin-audit/AuditChangesSheet';
import {
  auditActionLabels,
  auditActionLabel,
  auditTargetLabel,
} from '../../features/admin-audit/labels';

const textFields = [
  { key: 'actorId', label: '操作者 ID' },
  { key: 'action', label: '操作类型' },
  { key: 'targetType', label: '目标类型' },
  { key: 'targetId', label: '目标 ID' },
  { key: 'operationId', label: '操作 ID' },
] as const;
export default function AuditPage() {
  const { client, user } = useSession();
  const [params, setParams] = useSearchParams();
  const [error, setError] = useState<unknown>(null);
  const [selectedEntry, setSelectedEntry] = useState<AuditEntry | null>(null);
  const [actionChoice, setActionChoice] = useState<{ search: string; custom: boolean } | null>(
    null,
  );
  const customAction =
    actionChoice?.search === params.toString()
      ? actionChoice.custom
      : Boolean(params.get('action') && !auditActionLabels[params.get('action')!]);
  const filters: AuditQuery = {};
  for (const field of textFields) {
    const value = params.get(field.key)?.trim();
    if (value && value.length <= 128) filters[field.key] = value;
  }
  for (const field of ['from', 'to'] as const) {
    const value = params.get(field);
    if (value && /^\d+$/u.test(value) && Number.isSafeInteger(Number(value)))
      filters[field] = Number(value);
  }
  const query = useInfiniteQuery(auditQueryOptions(client, user!.id, filters));
  const rows = mergePageItems(query.data?.pages);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    for (const field of textFields) {
      const value = String(data.get(field.key) ?? '').trim();
      if (value) next.set(field.key, value);
    }
    try {
      const range = parseLocalDateRange(
        String(data.get('from') ?? ''),
        String(data.get('to') ?? ''),
      );
      for (const [key, value] of Object.entries(range)) next.set(key, String(value));
      setError(null);
      setParams(next);
    } catch (error) {
      setError(error);
    }
  }
  return (
    <section className="space-y-5">
      <PageHeader heading="管理审计" />
      <form
        key={params.toString()}
        className="grid items-end gap-4 console-panel sm:grid-cols-2 2xl:grid-cols-4"
        onSubmit={applyFilters}
      >
        <Field label="操作者 ID">
          <Input name="actorId" defaultValue={filters.actorId} maxLength={128} />
        </Field>
        <Field label="操作类型">
          <select
            name={customAction ? undefined : 'action'}
            defaultValue={customAction ? '__custom' : (filters.action ?? '')}
            className="min-h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
            onChange={(event) =>
              setActionChoice({
                search: params.toString(),
                custom: event.target.value === '__custom',
              })
            }
          >
            <option value="">全部操作</option>
            {Object.entries(auditActionLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
            <option value="__custom">其他操作类型</option>
          </select>
        </Field>
        {customAction && (
          <Field label="其他操作类型">
            <Input
              name="action"
              defaultValue={filters.action}
              placeholder="如 custom.action"
              maxLength={64}
            />
          </Field>
        )}
        <Field label="开始时间">
          <Input
            name="from"
            type="datetime-local"
            step="0.001"
            defaultValue={formatLocalDateTime(filters.from, true)}
          />
        </Field>
        <Field label="结束时间">
          <Input
            name="to"
            type="datetime-local"
            step="0.001"
            defaultValue={formatLocalDateTime(filters.to, true)}
          />
        </Field>
        <div className="flex flex-wrap gap-2 sm:col-span-2 2xl:col-span-4">
          <Button type="submit" variant="secondary">
            筛选
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setError(null);
              setParams({});
              setActionChoice(null);
            }}
          >
            清空
          </Button>
        </div>
        <details
          className="sm:col-span-2 2xl:col-span-4 border-t border-[var(--color-border)] pt-4"
          open={Boolean(filters.targetType || filters.targetId || filters.operationId)}
        >
          <summary className="cursor-pointer text-sm font-medium text-[var(--color-ink-secondary)]">
            更多筛选
          </summary>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {textFields
              .filter((field) => field.key !== 'actorId' && field.key !== 'action')
              .map((field) => (
                <Field key={field.key} label={field.label}>
                  <Input name={field.key} defaultValue={filters[field.key]} maxLength={128} />
                </Field>
              ))}
          </div>
        </details>
      </form>
      {(error || query.error) && (
        <ApiErrorNotice
          error={error ?? query.error}
          onRetry={() =>
            void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())
          }
        />
      )}
      <CursorTable
        rows={rows}
        loading={query.isPending}
        loadingMore={query.isFetchingNextPage}
        hasMore={query.hasNextPage}
        onLoadMore={() => void query.fetchNextPage()}
        getRowId={(row) => row.id}
        onRowClick={setSelectedEntry}
        caption="管理审计记录"
        emptyMessage="暂无审计记录"
        columns={[
          {
            header: '时间',
            id: 'time',
            size: 190,
            cell: (context) => (
              <span className="whitespace-nowrap tabular-nums">
                {formatDateTime(context.row.original.created_at)}
              </span>
            ),
          },
          {
            header: '操作者',
            id: 'actor',
            cell: (context) => (
              <span title={context.row.original.actor_id} className="block max-w-52 truncate">
                {context.row.original.actor_email ?? context.row.original.actor_id}
              </span>
            ),
          },
          {
            header: '操作',
            id: 'action',
            cell: (context) => (
              <span className="whitespace-nowrap">
                {auditActionLabel(context.row.original.action)}
              </span>
            ),
          },
          {
            header: '目标',
            id: 'target',
            cell: (context) => (
              <div className="grid gap-1">
                <span title={context.row.original.target_id} className="block max-w-60 truncate">
                  {context.row.original.target_name ?? context.row.original.target_id}
                </span>
                <span className="text-sm text-[var(--color-ink-secondary)]">
                  {auditTargetLabel(context.row.original.target_type)}
                </span>
              </div>
            ),
          },
          {
            header: '详情',
            id: 'changes',
            size: 110,
            cell: (context) => (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSelectedEntry(context.row.original)}
              >
                查看变更
              </Button>
            ),
          },
        ]}
      />
      <AuditChangesSheet entry={selectedEntry} onClose={() => setSelectedEntry(null)} />
    </section>
  );
}
