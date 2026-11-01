import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { billingStatusSchema, executionStatusSchema } from '@cheapai/contracts/requests';
import type { BillingStatus, ExecutionStatus } from '@cheapai/contracts/requests';
import { useRequestPages } from '../../features/request-history/useRequestPages';
import { requestListQueryOptions } from '../../features/request-history/api';
import type { RequestFilters } from '../../features/request-history/filters';
import {
  parseRequestListUrl,
  serializeRequestFilters,
  serializeRequestListUrl,
} from '../../features/request-history/filters';
import { billingLabels, executionLabels } from '../../features/request-history/RequestStatus';
import { RequestTable } from '../../features/request-history/RequestTable';
import { useSession } from '../../features/session/useSession';
import { formatLocalDateTime, parseLocalDateRange } from '../../shared/lib/datetime';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { PageHeader } from '../../shared/patterns/PageHeader';
import { Button } from '../../shared/ui/Button';

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
  const { client, user, epoch: sessionEpoch, state: session, queryClient } = useSession();
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
      <PageHeader
        heading="使用记录"
        description={
          <>
            查看网页对话与 API 调用的用量和费用。图片记录见{' '}
            <Link to="/images" className="underline underline-offset-4">
              生图
            </Link>
            。
          </>
        }
        actions={
          <Button
            variant="outline"
            busy={query.isFetching}
            onClick={() => {
              if (urlState.cursor !== null) {
                void queryClient.invalidateQueries({
                  queryKey: requestListQueryOptions(
                    { client, userId, scope: 'personal', epoch: sessionEpoch },
                    { ...urlState.filters, cursor: null },
                  ).queryKey,
                  exact: true,
                  refetchType: 'none',
                });
                setSearchParams(serializeRequestFilters(urlState.filters));
              } else void query.refetch();
            }}
          >
            刷新记录
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-2" aria-label="常用筛选">
        <span className="text-sm text-[var(--color-muted-foreground)]">时间</span>
        {[
          ['今天', 1],
          ['近 7 天', 7],
          ['近 30 天', 30],
          ['全部时间', 0],
        ].map(([label, days]) => (
          <Button
            key={label}
            size="sm"
            variant="outline"
            onClick={() => {
              const filters = { ...urlState.filters };
              delete filters.from;
              delete filters.to;
              const end = new Date();
              const start = new Date(end);
              start.setHours(0, 0, 0, 0);
              start.setDate(start.getDate() - Number(days) + 1);
              setSearchParams(
                serializeRequestFilters(
                  Number(days) ? { ...filters, from: start.getTime(), to: end.getTime() } : filters,
                ),
              );
            }}
          >
            {label}
          </Button>
        ))}
        <Button
          size="sm"
          variant={urlState.filters.status === 'failed' ? 'primary' : 'outline'}
          aria-pressed={urlState.filters.status === 'failed'}
          onClick={() => {
            const filters = { ...urlState.filters };
            delete filters.status;
            setSearchParams(
              serializeRequestFilters(
                urlState.filters.status === 'failed' ? filters : { ...filters, status: 'failed' },
              ),
            );
          }}
        >
          只看失败
        </Button>
      </div>
      <form
        onSubmit={applyFilters}
        className="flex flex-wrap items-end gap-3 console-panel p-5"
        aria-label="使用记录筛选"
      >
        <label className="grid gap-2 console-label">
          模型 ID
          <input
            value={draft.model}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDraft((current) => ({ ...current, model: value }));
            }}
            placeholder="输入完整模型 ID"
            maxLength={128}
            autoComplete="off"
            className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[15px]"
          />
        </label>
        <div className="grid gap-2 console-label">
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
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDraft((current) => ({ ...current, from: value }));
              }}
              className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[15px]"
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
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDraft((current) => ({ ...current, to: value }));
              }}
              className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[15px]"
            />
          </div>
        </div>
        <button
          type="submit"
          className="min-h-11 rounded-lg bg-[var(--color-primary)] px-4 text-[15px] font-medium text-[var(--color-primary-foreground)]"
        >
          筛选
        </button>
        <button
          type="button"
          className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-[15px]"
          onClick={() => {
            setDraft(emptyDraft);
            setMoreFiltersOpen(false);
            setFilterError('');
            setSearchParams(new URLSearchParams());
          }}
        >
          重置
        </button>
        <details
          className="basis-full border-t border-[var(--color-border)] pt-4"
          open={moreFiltersOpen}
          onToggle={(event) => setMoreFiltersOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer text-sm font-medium text-[var(--color-foreground)]">
            更多筛选
          </summary>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="grid gap-2 console-label">
              执行状态
              <select
                value={draft.status}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDraft((current) => ({ ...current, status: value }));
                }}
                className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[15px]"
              >
                <option value="">全部</option>
                {executionStatusSchema.options.map((value) => (
                  <option key={value} value={value}>
                    {executionLabels[value].label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-2 console-label">
              计费状态
              <select
                value={draft.billingStatus}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDraft((current) => ({ ...current, billingStatus: value }));
                }}
                className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[15px]"
              >
                <option value="">全部</option>
                {billingStatusSchema.options.map((value) => (
                  <option key={value} value={value}>
                    {billingLabels[value].label}
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
              ? '没有符合筛选条件的记录。点击上方“重置”查看全部。'
              : '还没有使用记录。'
          }
        />
      )}
      {query.isSuccess && rows.length === 0 && !hasActiveFilters && (
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link to="/chat">开始对话</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/keys">接入 API</Link>
          </Button>
        </div>
      )}
    </section>
  );
}
