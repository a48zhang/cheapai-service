import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { billingStatusSchema, executionStatusSchema } from '@cheapai/contracts/requests';
import type { BillingStatus, ExecutionStatus, RequestPage, RequestRecord } from '@cheapai/contracts/requests';
import { requestListQueryOptions } from '../../features/request-history/api';
import type { RequestFilters } from '../../features/request-history/filters';
import { parseRequestListUrl, serializeRequestFilters, serializeRequestListUrl } from '../../features/request-history/filters';
import { RequestTable } from '../../features/request-history/RequestTable';
import { useSession } from '../../features/session/useSession';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { PageHeader } from '../../shared/patterns/PageHeader';

interface LoadedPages {
  readonly filterKey: string;
  readonly pages: readonly { readonly cursor: string | null; readonly page: RequestPage }[];
}

interface FilterDraft {
  readonly status: string;
  readonly billingStatus: string;
  readonly model: string;
  readonly from: string;
  readonly to: string;
}

const emptyDraft: FilterDraft = { status: '', billingStatus: '', model: '', from: '', to: '' };
const validModelId = (value: string) => value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u.test(value);
const executionLabels: Record<ExecutionStatus, string> = {
  admitted: '已接收', succeeded: '成功', failed: '失败', cancelled: '已取消', abandoned: '已放弃',
};
const billingLabels: Record<BillingStatus, string> = {
  awaiting_usage: '等待用量', settled: '已结算', not_chargeable: '不计费', settlement_pending: '待结算', usage_unknown: '用量未知',
};

function localDateTime(value: number | undefined): string {
  if (value === undefined) return '';
  const date = new Date(value - new Date(value).getTimezoneOffset() * 60_000);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 16) : '';
}

function epoch(value: string): number | undefined {
  if (!value) return undefined;
  const parsed = new Date(value).getTime();
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function draftFrom(filters: RequestFilters): FilterDraft {
  return {
    status: filters.status ?? '',
    billingStatus: filters.billingStatus ?? '',
    model: filters.model ?? '',
    from: localDateTime(filters.from),
    to: localDateTime(filters.to),
  };
}

export function RequestsPage() {
  const { client, user, state: session } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlState = useMemo(() => parseRequestListUrl(searchParams, 'personal'), [searchParams]);
  const filterKey = JSON.stringify(urlState.filters);
  const userId = user?.id ?? 'anonymous';
  const requestQuery = requestListQueryOptions({ client, userId, scope: 'personal' }, { ...urlState.filters, cursor: urlState.cursor });
  const query = useQuery({ ...requestQuery, enabled: session.status === 'authenticated' && user !== null });
  const [draft, setDraft] = useState<FilterDraft>(() => draftFrom(urlState.filters));
  const [filterError, setFilterError] = useState('');
  const [loaded, setLoaded] = useState<LoadedPages | null>(null);
  const syncedFilterKey = useRef(filterKey);

  useEffect(() => {
    if (syncedFilterKey.current === filterKey) return;
    syncedFilterKey.current = filterKey;
    setDraft(draftFrom(urlState.filters));
    setFilterError('');
  }, [filterKey, urlState.filters]);
  useEffect(() => {
    if (!query.data) return;
    setLoaded(current => {
      const currentPages = current?.filterKey === filterKey ? current.pages : [];
      const pageIndex = currentPages.findIndex(item => item.cursor === urlState.cursor);
      if (pageIndex >= 0) return { filterKey, pages: [...currentPages.slice(0, pageIndex), { cursor: urlState.cursor, page: query.data }] };
      const previous = currentPages.at(-1);
      if (previous && previous.page.nextCursor === urlState.cursor) return { filterKey, pages: [...currentPages, { cursor: urlState.cursor, page: query.data }] };
      return { filterKey, pages: [{ cursor: urlState.cursor, page: query.data }] };
    });
  }, [query.data, filterKey, urlState.cursor]);

  const pages = loaded?.filterKey === filterKey ? loaded.pages : [];
  const rows: readonly RequestRecord[] = pages.length ? pages.flatMap(item => item.page.items) : query.data?.items ?? [];
  const currentPage = pages.at(-1)?.page ?? query.data;

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilterError('');
    const from = epoch(draft.from);
    const to = epoch(draft.to);
    if ((draft.from && from === undefined) || (draft.to && to === undefined)) { setFilterError('请输入有效的时间范围。'); return; }
    if (from !== undefined && to !== undefined && from > to) { setFilterError('开始时间不能晚于结束时间。'); return; }
    const model = draft.model.trim();
    if (model && !validModelId(model)) { setFilterError('模型 ID 格式无效。'); return; }
    const status = draft.status ? executionStatusSchema.safeParse(draft.status) : null;
    const billingStatus = draft.billingStatus ? billingStatusSchema.safeParse(draft.billingStatus) : null;
    if (status && !status.success) { setFilterError('执行状态无效。'); return; }
    if (billingStatus && !billingStatus.success) { setFilterError('计费状态无效。'); return; }
    const filters: RequestFilters = {
      ...(status?.success ? { status: status.data as ExecutionStatus } : {}),
      ...(billingStatus?.success ? { billingStatus: billingStatus.data as BillingStatus } : {}),
      ...(model ? { model } : {}),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    };
    setSearchParams(serializeRequestFilters(filters));
  }

  function loadMore() {
    const nextCursor = currentPage?.nextCursor;
    if (nextCursor) setSearchParams(serializeRequestListUrl(urlState.filters, nextCursor, 'personal'));
  }

  return <section className="space-y-5">
    <PageHeader heading="我的请求" description="查看模型调用结果、用量和实际结算状态。" />
    <form onSubmit={applyFilters} className="flex flex-wrap items-end gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4" aria-label="请求筛选">
      <label className="grid gap-1.5 text-xs font-medium text-[var(--foreground)]">执行状态
        <select value={draft.status} onChange={event => setDraft(current => ({ ...current, status: event.currentTarget.value }))} className="min-h-10 rounded-md border border-[var(--border)] bg-white px-3 text-sm">
          <option value="">全部</option>{executionStatusSchema.options.map(value => <option key={value} value={value}>{executionLabels[value]}</option>)}
        </select>
      </label>
      <label className="grid gap-1.5 text-xs font-medium text-[var(--foreground)]">计费状态
        <select value={draft.billingStatus} onChange={event => setDraft(current => ({ ...current, billingStatus: event.currentTarget.value }))} className="min-h-10 rounded-md border border-[var(--border)] bg-white px-3 text-sm">
          <option value="">全部</option>{billingStatusSchema.options.map(value => <option key={value} value={value}>{billingLabels[value]}</option>)}
        </select>
      </label>
      <label className="grid gap-1.5 text-xs font-medium text-[var(--foreground)]">公开模型
        <input value={draft.model} onChange={event => setDraft(current => ({ ...current, model: event.currentTarget.value }))} maxLength={128} autoComplete="off" className="min-h-10 rounded-md border border-[var(--border)] bg-white px-3 text-sm" />
      </label>
      <label className="grid gap-1.5 text-xs font-medium text-[var(--foreground)]">开始时间
        <input type="datetime-local" value={draft.from} onChange={event => setDraft(current => ({ ...current, from: event.currentTarget.value }))} className="min-h-10 rounded-md border border-[var(--border)] bg-white px-3 text-sm" />
      </label>
      <label className="grid gap-1.5 text-xs font-medium text-[var(--foreground)]">结束时间
        <input type="datetime-local" value={draft.to} onChange={event => setDraft(current => ({ ...current, to: event.currentTarget.value }))} className="min-h-10 rounded-md border border-[var(--border)] bg-white px-3 text-sm" />
      </label>
      <button type="submit" className="min-h-10 rounded-md bg-[var(--primary)] px-4 text-sm font-medium text-white">应用筛选</button>
      <button type="button" className="min-h-10 rounded-md border border-[var(--border)] bg-white px-4 text-sm" onClick={() => { setDraft(emptyDraft); setFilterError(''); setSearchParams(new URLSearchParams()); }}>清除</button>
      {filterError && <p className="m-0 basis-full text-sm text-[var(--destructive)]" role="alert">{filterError}</p>}
    </form>
    {query.error && <ApiErrorNotice error={query.error} onRetry={() => void query.refetch()} />}
    {(!query.error || rows.length > 0) && <RequestTable rows={rows} loading={query.isPending} loadingMore={query.isFetching && urlState.cursor !== null}
      hasMore={Boolean(currentPage?.nextCursor)} onLoadMore={loadMore} />}
  </section>;
}
