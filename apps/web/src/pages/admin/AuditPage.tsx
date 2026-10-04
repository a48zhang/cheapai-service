import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { AuditQuery } from '@cheapai/contracts/audit';
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

const textFields = [
  { key: 'actorId', label: '操作者 ID' },
  { key: 'action', label: '动作' },
  { key: 'targetType', label: '目标类型' },
  { key: 'targetId', label: '目标 ID' },
  { key: 'operationId', label: '操作 ID' },
] as const;
export default function AuditPage() {
  const { client, user } = useSession();
  const [params, setParams] = useSearchParams();
  const [error, setError] = useState<unknown>(null);
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
    <>
      <PageHeader heading="管理审计" />
      <form
        key={params.toString()}
        className="flex flex-wrap items-end gap-3 rounded-xl border border-[var(--color-border)] bg-white p-4"
        onSubmit={applyFilters}
      >
        {textFields.map((field) => (
          <Field key={field.key} label={field.label}>
            <Input name={field.key} defaultValue={filters[field.key]} maxLength={128} />
          </Field>
        ))}
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
        <Button type="submit" variant="secondary">
          查询
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setError(null);
            setParams({});
          }}
        >
          清空
        </Button>
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
        caption="脱敏审计记录"
        emptyMessage="暂无审计记录"
        columns={[
          {
            header: '时间',
            id: 'time',
            cell: (context) => formatDateTime(context.row.original.created_at),
          },
          { header: '操作者', accessorKey: 'actor_id' },
          { header: '动作', accessorKey: 'action' },
          {
            header: '目标',
            id: 'target',
            cell: (context) => (
              <span>
                {context.row.original.target_type}
                <br />
                <code>{context.row.original.target_id}</code>
              </span>
            ),
          },
          { header: '操作 ID', accessorKey: 'operation_id' },
          {
            header: '脱敏变更',
            id: 'changes',
            cell: (context) => (
              <details>
                <summary>查看变更</summary>
                <pre className="max-w-sm whitespace-pre-wrap break-all text-xs">
                  {context.row.original.redaction_valid
                    ? (JSON.stringify(context.row.original.changes, null, 2) ?? '无变更')
                    : '脱敏内容不可用'}
                </pre>
              </details>
            ),
          },
        ]}
      />
    </>
  );
}
