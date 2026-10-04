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
import { mergePageItems } from '../../shared/lib/pagination';

export default function BillingPage() {
  const { client, user } = useSession();
  const [params, setParams] = useSearchParams();
  const kind = billingKindSchema.safeParse(params.get('kind'));
  const filters: AdminBillingQuery = {
    ...(kind.success ? { kind: kind.data } : {}),
    ...(params.get('userId') ? { userId: params.get('userId')! } : {}),
    ...(params.get('requestId') ? { requestId: params.get('requestId')! } : {}),
  };
  const query = useInfiniteQuery(adminBillingListQueryOptions(client, user!.id, filters));
  const rows = mergePageItems(query.data?.pages);
  return (
    <>
      <PageHeader heading="全局账单" description="实际记账明细；消费、授额与调整分别列示。" />
      <form
        key={params.toString()}
        className="flex flex-wrap items-end gap-3 rounded-xl border border-[var(--color-border)] bg-white p-4"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const next = new URLSearchParams();
          for (const key of ['userId', 'requestId', 'kind']) {
            const value = String(data.get(key) ?? '').trim();
            if (value) next.set(key, value);
          }
          setParams(next);
        }}
      >
        <Field label="用户 ID">
          <Input name="userId" defaultValue={filters.userId} />
        </Field>
        <Field label="请求 ID">
          <Input name="requestId" defaultValue={filters.requestId} />
        </Field>
        <Field label="类型">
          <select
            name="kind"
            defaultValue={filters.kind ?? ''}
            className="h-10 rounded-md border px-3"
          >
            <option value="">全部</option>
            <option value="consumption">模型消费</option>
            <option value="grant">授额</option>
            <option value="adjustment">余额调整</option>
          </select>
        </Field>
        <Button type="submit" variant="secondary">
          查询
        </Button>
        <Button variant="ghost" onClick={() => setParams({})}>
          清空
        </Button>
      </form>
      {query.error && (
        <ApiErrorNotice
          error={query.error}
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
    </>
  );
}
