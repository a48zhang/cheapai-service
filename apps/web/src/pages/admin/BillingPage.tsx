import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { billingKindSchema, type AdminBillingQuery } from '@cheapai/contracts/billing';
import { useSession } from '../../features/session/useSession';
import { BillingTable } from '../../features/billing/BillingTable';
import { adminBillingListQueryOptions } from '../../features/billing/admin-api';
import { PageHeader } from '../../shared/patterns/PageHeader';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { Button } from '../../shared/ui/Button';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { formatLocalDateTime, parseLocalDateRange } from '../../shared/lib/datetime';
import { mergePageItems } from '../../shared/lib/pagination';

export default function BillingPage() {
  const { client, user } = useSession();
  const [params, setParams] = useSearchParams();
  const [filterError, setFilterError] = useState<unknown>(null);
  const kind = billingKindSchema.safeParse(params.get('kind'));
  const filters: AdminBillingQuery = {
    ...(params.get('createdFrom') && Number.isSafeInteger(Number(params.get('createdFrom')))
      ? { createdFrom: Number(params.get('createdFrom')) }
      : {}),
    ...(params.get('createdBefore') && Number.isSafeInteger(Number(params.get('createdBefore')))
      ? { createdBefore: Number(params.get('createdBefore')) }
      : {}),
    ...(kind.success ? { kind: kind.data } : {}),
    ...(params.get('userId') ? { userId: params.get('userId')! } : {}),
    ...(params.get('requestId') ? { requestId: params.get('requestId')! } : {}),
  };
  const query = useInfiniteQuery(adminBillingListQueryOptions(client, user!.id, filters));
  const rows = mergePageItems(query.data?.pages);
  return (
    <section className="space-y-5">
      <PageHeader heading="全局账单" />
      <form
        key={params.toString()}
        className="flex flex-wrap items-end gap-3 console-panel p-5"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const next = new URLSearchParams();
          for (const key of ['userId', 'requestId', 'kind']) {
            const value = String(data.get(key) ?? '').trim();
            if (value) next.set(key, value);
          }
          try {
            const range = parseLocalDateRange(
              String(data.get('from') ?? ''),
              String(data.get('to') ?? ''),
            );
            if (range.from !== undefined) next.set('createdFrom', String(range.from));
            if (range.to !== undefined) next.set('createdBefore', String(range.to));
            setFilterError(null);
            setParams(next);
          } catch (error) {
            setFilterError(error);
          }
        }}
      >
        <Field label="开始时间">
          <Input
            type="datetime-local"
            name="from"
            step="0.001"
            defaultValue={formatLocalDateTime(filters.createdFrom, true)}
          />
        </Field>
        <Field label="结束时间（不含）">
          <Input
            type="datetime-local"
            name="to"
            step="0.001"
            defaultValue={formatLocalDateTime(filters.createdBefore, true)}
          />
        </Field>
        <Field label="类型">
          <select
            name="kind"
            defaultValue={filters.kind ?? ''}
            className="h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3"
          >
            <option value="">全部</option>
            <option value="consumption">模型消费</option>
            <option value="grant">授额</option>
            <option value="adjustment">余额调整</option>
          </select>
        </Field>
        <Button type="submit" variant="secondary">
          筛选
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setFilterError(null);
            setParams({});
          }}
        >
          重置
        </Button>
        <details
          className="basis-full border-t border-[var(--color-border)] pt-4"
          open={Boolean(filters.userId || filters.requestId)}
        >
          <summary className="cursor-pointer text-sm font-medium text-[var(--color-ink-secondary)]">
            更多筛选
          </summary>
          <div className="mt-4 flex flex-wrap gap-4">
            <Field label="用户 ID">
              <Input name="userId" defaultValue={filters.userId} />
            </Field>
            <Field label="请求 ID">
              <Input name="requestId" defaultValue={filters.requestId} />
            </Field>
          </div>
        </details>
      </form>
      {(filterError || query.error) && (
        <ApiErrorNotice
          error={filterError ?? query.error}
          onRetry={() =>
            void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())
          }
        />
      )}
      <BillingTable
        scope="admin"
        rows={rows}
        loading={query.isPending}
        loadingMore={query.isFetchingNextPage}
        hasMore={query.hasNextPage}
        onLoadMore={() => void query.fetchNextPage()}
      />
    </section>
  );
}
