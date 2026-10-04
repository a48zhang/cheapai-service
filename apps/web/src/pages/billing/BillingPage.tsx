import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { billingKindSchema } from '@cheapai/contracts/billing';
import type { BillingKind } from '@cheapai/contracts/billing';
import { billingListQueryOptions, createPersonalBillingApi } from '../../features/billing/api';
import { BillingTable } from '../../features/billing/BillingTable';
import { useSession } from '../../features/session/useSession';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { PageHeader } from '../../shared/patterns/PageHeader';
import { mergePageItems } from '../../shared/lib/pagination';

const kindLabels: Record<BillingKind, string> = {
  consumption: '模型消费',
  grant: '管理员授额',
  adjustment: '余额调整',
};

export function BillingPage() {
  const { client, user, state: session } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestId = searchParams.get('requestId') ?? '';
  const kindValue = searchParams.get('kind') ?? '';
  const parsedKind = kindValue ? billingKindSchema.safeParse(kindValue) : null;
  const kind = parsedKind?.success ? parsedKind.data : undefined;
  const filters = useMemo(
    () => ({
      ...(kind ? { kind } : {}),
      ...(requestId.trim() ? { requestId: requestId.trim() } : {}),
    }),
    [kind, requestId],
  );
  const api = useMemo(() => createPersonalBillingApi(client), [client]);
  const userId = user?.id ?? 'anonymous';
  const query = useInfiniteQuery({
    ...billingListQueryOptions(api, userId, filters),
    enabled: session.status === 'authenticated' && user !== null,
  });
  const [draftKind, setDraftKind] = useState(kind ?? '');
  const [draftRequestId, setDraftRequestId] = useState(requestId);
  const [filterError, setFilterError] = useState('');

  useEffect(() => {
    setDraftKind(kind ?? '');
    setDraftRequestId(requestId);
    setFilterError('');
  }, [kind, requestId]);
  const rows = mergePageItems(query.data?.pages);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilterError('');
    const next = new URLSearchParams();
    if (draftKind) {
      const parsed = billingKindSchema.safeParse(draftKind);
      if (!parsed.success) {
        setFilterError('账单类型无效。');
        return;
      }
      next.set('kind', parsed.data);
    }
    const normalizedRequestId = draftRequestId.trim();
    if (normalizedRequestId) {
      if (
        normalizedRequestId.length > 128 ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u.test(normalizedRequestId)
      ) {
        setFilterError('请求 ID 格式无效。');
        return;
      }
      next.set('requestId', normalizedRequestId);
    }
    setSearchParams(next);
  }

  return (
    <section className="space-y-5">
      <PageHeader heading="账单明细" />
      <form
        onSubmit={applyFilters}
        className="flex flex-wrap items-end gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        aria-label="账单筛选"
      >
        <label className="grid gap-1.5 text-xs font-medium text-[var(--color-foreground)]">
          类型
          <select
            value={draftKind}
            onChange={(event) => setDraftKind(event.currentTarget.value)}
            className="min-h-10 rounded-md border border-[var(--color-border)] bg-white px-3 text-sm"
          >
            <option value="">全部</option>
            {billingKindSchema.options.map((value) => (
              <option key={value} value={value}>
                {kindLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-[var(--color-foreground)]">
          请求 ID（可选）
          <input
            value={draftRequestId}
            onChange={(event) => setDraftRequestId(event.currentTarget.value)}
            maxLength={128}
            autoComplete="off"
            className="min-h-10 rounded-md border border-[var(--color-border)] bg-white px-3 text-sm"
          />
        </label>
        <button
          type="submit"
          className="min-h-10 rounded-md bg-[var(--color-primary)] px-4 text-sm font-medium text-white"
        >
          应用筛选
        </button>
        <button
          type="button"
          className="min-h-10 rounded-md border border-[var(--color-border)] bg-white px-4 text-sm"
          onClick={() => {
            setDraftKind('');
            setDraftRequestId('');
            setFilterError('');
            setSearchParams(new URLSearchParams());
          }}
        >
          清除
        </button>
        {filterError && (
          <p className="m-0 basis-full text-sm text-[var(--color-destructive)]" role="alert">
            {filterError}
          </p>
        )}
      </form>
      {query.error && (
        <ApiErrorNotice
          error={query.error}
          onRetry={() =>
            void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())
          }
        />
      )}
      {(!query.error || rows.length > 0) && (
        <BillingTable
          rows={rows}
          loading={query.isPending}
          loadingMore={query.isFetchingNextPage}
          hasMore={query.hasNextPage}
          onLoadMore={() => {
            void query.fetchNextPage();
          }}
        />
      )}
    </section>
  );
}
