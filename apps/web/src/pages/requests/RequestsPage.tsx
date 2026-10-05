import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { billingStatusSchema, executionStatusSchema } from '@cheapai/contracts/requests';
import type { BillingStatus, ExecutionStatus } from '@cheapai/contracts/requests';
import { useRequestPages } from '../../features/request-history/useRequestPages';
import type { RequestFilters } from '../../features/request-history/filters';
import {
  parseRequestListUrl,
  serializeRequestFilters,
  serializeRequestListUrl,
} from '../../features/request-history/filters';
import { RequestTable } from '../../features/request-history/RequestTable';
import { useSession } from '../../features/session/useSession';
import { formatLocalDateTime, parseLocalDateRange } from '../../shared/lib/datetime';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { PageHeader } from '../../shared/patterns/PageHeader';

interface FilterDraft {
  readonly status: string;
  readonly billingStatus: string;
  readonly model: string;
  readonly from: string;
  readonly to: string;
}

const emptyDraft: FilterDraft = { status: '', billingStatus: '', model: '', from: '', to: '' };
const validModelId = (value: string) =>
  value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u.test(value);
const executionLabels: Record<ExecutionStatus, string> = {
  admitted: '已接收',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  abandoned: '已放弃',
};
const billingLabels: Record<BillingStatus, string> = {
  awaiting_usage: '等待用量',
  settled: '已结算',
  not_chargeable: '不计费',
  settlement_pending: '待结算',
  usage_unknown: '用量未知',
};

function draftFrom(filters: RequestFilters): FilterDraft {
  return {
    status: filters.status ?? '',
    billingStatus: filters.billingStatus ?? '',
    model: filters.model ?? '',
    from: formatLocalDateTime(filters.from),
    to: formatLocalDateTime(filters.to),
  };
}

export function RequestsPage() {
  const { client, user, epoch: sessionEpoch, state: session } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlState = useMemo(() => parseRequestListUrl(searchParams, 'personal'), [searchParams]);
  const filterKey = JSON.stringify(urlState.filters);
  const userId = user?.id ?? 'anonymous';
  const requestPages = useRequestPages({
    context: { client, userId, scope: 'personal' },
    epoch: sessionEpoch,
    filters: urlState.filters,
    cursor: urlState.cursor,
    enabled: session.status === 'authenticated' && user !== null,
  });
  const { query, rows, nextCursor, error: requestError } = requestPages;
  const [draft, setDraft] = useState<FilterDraft>(() => draftFrom(urlState.filters));
  const [filterError, setFilterError] = useState('');
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(
    () => urlState.filters.status !== undefined || urlState.filters.billingStatus !== undefined,
  );
  const syncedFilterKey = useRef(filterKey);

  useEffect(() => {
    if (syncedFilterKey.current === filterKey) return;
    syncedFilterKey.current = filterKey;
    setDraft(draftFrom(urlState.filters));
    setMoreFiltersOpen(
      urlState.filters.status !== undefined || urlState.filters.billingStatus !== undefined,
    );
    setFilterError('');
  }, [filterKey, urlState.filters]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilterError('');
    let dateRange: ReturnType<typeof parseLocalDateRange>;
    try {
      dateRange = parseLocalDateRange(draft.from, draft.to);
    } catch (error) {
      setFilterError(error instanceof Error ? error.message : '请输入有效的时间范围。');
      return;
    }
    const model = draft.model.trim();
    if (model && !validModelId(model)) {
      setFilterError('模型 ID 格式无效。');
      return;
    }
    const status = draft.status ? executionStatusSchema.safeParse(draft.status) : null;
    const billingStatus = draft.billingStatus
      ? billingStatusSchema.safeParse(draft.billingStatus)
      : null;
    if (status && !status.success) {
      setFilterError('执行状态无效。');
      return;
    }
    if (billingStatus && !billingStatus.success) {
      setFilterError('计费状态无效。');
      return;
    }
    const filters: RequestFilters = {
      ...(status?.success ? { status: status.data as ExecutionStatus } : {}),
      ...(billingStatus?.success ? { billingStatus: billingStatus.data as BillingStatus } : {}),
      ...(model ? { model } : {}),
      ...dateRange,
    };
    setSearchParams(serializeRequestFilters(filters));
  }

  function loadMore() {
    if (nextCursor !== undefined)
      setSearchParams(serializeRequestListUrl(urlState.filters, nextCursor, 'personal'));
  }

  const hasActiveFilters = Object.keys(urlState.filters).length > 0;

  return (
    <section className="space-y-5">
      <PageHeader heading="使用记录" />
      <form
        onSubmit={applyFilters}
        className="flex flex-wrap items-end gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        aria-label="使用记录筛选"
      >
        <label className="grid gap-1.5 text-xs font-medium text-[var(--color-foreground)]">
          模型
          <input
            value={draft.model}
            onChange={(event) =>
              setDraft((current) => ({ ...current, model: event.currentTarget.value }))
            }
            maxLength={128}
            autoComplete="off"
            className="min-h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
          />
        </label>
        <div className="grid gap-1.5 text-xs font-medium text-[var(--color-foreground)]">
          <span>时间范围</span>
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="request-time-from">
              开始时间
            </label>
            <input
              id="request-time-from"
              aria-label="开始时间"
              type="datetime-local"
              value={draft.from}
              onChange={(event) =>
                setDraft((current) => ({ ...current, from: event.currentTarget.value }))
              }
              className="min-h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
            />
            <span aria-hidden="true" className="text-[var(--color-muted-foreground)]">
              至
            </span>
            <label className="sr-only" htmlFor="request-time-to">
              结束时间
            </label>
            <input
              id="request-time-to"
              aria-label="结束时间"
              type="datetime-local"
              value={draft.to}
              onChange={(event) =>
                setDraft((current) => ({ ...current, to: event.currentTarget.value }))
              }
              className="min-h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
            />
          </div>
        </div>
        <button
          type="submit"
          className="min-h-10 rounded-md bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-primary-foreground)]"
        >
          应用筛选
        </button>
        <button
          type="button"
          className="min-h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-sm"
          onClick={() => {
            setDraft(emptyDraft);
            setMoreFiltersOpen(false);
            setFilterError('');
            setSearchParams(new URLSearchParams());
          }}
        >
          清除
        </button>
        <details
          className="basis-full rounded-lg border border-[var(--color-border)] px-3 py-2"
          open={moreFiltersOpen}
          onToggle={(event) => setMoreFiltersOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer text-sm font-medium text-[var(--color-foreground)]">
            更多筛选
          </summary>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="grid gap-1.5 text-xs font-medium text-[var(--color-foreground)]">
              执行状态
              <select
                value={draft.status}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, status: event.currentTarget.value }))
                }
                className="min-h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
              >
                <option value="">全部</option>
                {executionStatusSchema.options.map((value) => (
                  <option key={value} value={value}>
                    {executionLabels[value]}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-[var(--color-foreground)]">
              计费状态
              <select
                value={draft.billingStatus}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, billingStatus: event.currentTarget.value }))
                }
                className="min-h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
              >
                <option value="">全部</option>
                {billingStatusSchema.options.map((value) => (
                  <option key={value} value={value}>
                    {billingLabels[value]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </details>
        {filterError && (
          <p className="m-0 basis-full text-sm text-[var(--color-destructive)]" role="alert">
            {filterError}
          </p>
        )}
      </form>
      {requestError && <ApiErrorNotice error={requestError} onRetry={() => void query.refetch()} />}
      {(!requestError || rows.length > 0) && (
        <RequestTable
          rows={rows}
          loading={query.isPending}
          loadingMore={query.isFetching && urlState.cursor !== null}
          hasMore={nextCursor !== undefined}
          onLoadMore={loadMore}
          emptyMessage={
            hasActiveFilters
              ? '没有符合筛选条件的记录。点击上方“清除”查看全部。'
              : '还没有使用记录。'
          }
        />
      )}
    </section>
  );
}
