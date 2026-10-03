import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { createAdminRequestsApi } from '@cheapai/api-client/requests';
import { requestHistoryKeys } from '../../features/request-history/api';
import { parseRequestListUrl, serializeRequestFilters } from '../../features/request-history/filters';
import { RequestTable } from '../../features/request-history/RequestTable';
import { useSession } from '../../features/session/useSession';
import { PageHeader } from '../../shared/patterns/PageHeader';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { Button } from '../../shared/ui/Button';
import { Input } from '../../shared/ui/Input';
import { Field } from '../../shared/ui/Field';
import { billingStatusSchema, executionStatusSchema } from '@cheapai/contracts/requests';

export default function RequestsPage() {
  const { client, user } = useSession();
  const [params, setParams] = useSearchParams();
  const { filters } = parseRequestListUrl(params, 'admin');
  const [filterError, setFilterError] = useState<unknown>(null);
  const query = useInfiniteQuery({ queryKey: requestHistoryKeys.list(user!.id, 'admin', filters), initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => createAdminRequestsApi(client).list({ ...filters, cursor: pageParam }),
    getNextPageParam: (last, pages) => {
      if (last.nextCursor && pages.slice(0, -1).some(page => page.nextCursor === last.nextCursor)) throw new Error('请求分页返回重复游标。');
      return last.nextCursor ?? undefined;
    },
  });
  const rows = [...new Map((query.data?.pages.flatMap(page => page.items) ?? []).map(row => [row.id, row])).values()];
  return <><PageHeader heading="全局请求" description="查看用户请求、上游执行和计费证据。" />
    <form key={serializeRequestFilters(filters, 'admin')} className="flex flex-wrap items-end gap-3 rounded-xl border border-[var(--border)] bg-white p-4" aria-label="请求筛选" onSubmit={event => {
      event.preventDefault(); const data = new FormData(event.currentTarget); const next = new URLSearchParams();
      for (const key of ['userId', 'model', 'status', 'billingStatus']) { const value = String(data.get(key) ?? '').trim(); if (value) next.set(key, value); }
      for (const key of ['from', 'to']) { const value = String(data.get(key) ?? ''); if (value) { const time = new Date(value).getTime(); if (!Number.isSafeInteger(time)) { setFilterError(new Error('时间格式无效。')); return; } next.set(key, String(time)); } }
      if (next.has('from') && next.has('to') && Number(next.get('from')) > Number(next.get('to'))) { setFilterError(new Error('开始时间不能晚于结束时间。')); return; }
      setFilterError(null); setParams(serializeRequestFilters(parseRequestListUrl(next, 'admin').filters, 'admin'));
    }}>
      <Field label="用户 ID"><Input name="userId" defaultValue={filters.userId} /></Field><Field label="公开模型"><Input name="model" defaultValue={filters.model} /></Field>
      <Field label="执行状态"><select name="status" defaultValue={filters.status ?? ''} className="h-10 rounded-md border px-3"><option value="">全部</option>{executionStatusSchema.options.map(status => <option key={status} value={status}>{status}</option>)}</select></Field>
      <Field label="计费状态"><select name="billingStatus" defaultValue={filters.billingStatus ?? ''} className="h-10 rounded-md border px-3"><option value="">全部</option>{billingStatusSchema.options.map(status => <option key={status} value={status}>{status}</option>)}</select></Field>
      <Field label="开始时间"><Input type="datetime-local" name="from" /></Field><Field label="结束时间"><Input type="datetime-local" name="to" /></Field>
      <Button type="submit" variant="secondary">应用筛选</Button><Button variant="ghost" onClick={() => setParams({})}>清除</Button>
    </form>
    {(filterError || query.error) && <ApiErrorNotice error={filterError ?? query.error} onRetry={() => void query.refetch()} />}
    <RequestTable scope="admin" rows={rows} loading={query.isPending} loadingMore={query.isFetchingNextPage} hasMore={query.hasNextPage} onLoadMore={() => void query.fetchNextPage()} />
  </>;
}
