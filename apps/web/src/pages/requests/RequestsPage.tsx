import { RequestExport } from '../../features/request-history/RequestExport';
import { Input } from '../../shared/ui/Input';
import { RouteButton } from '../../shared/ui/RouteButton';
import { DateInput } from '../../shared/ui/DateInput';
import { Disclosure } from '../../shared/ui/Disclosure';
import { Select } from '../../shared/ui/Select';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
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
            <RouteButton to="/images" className="">
              生图
            </RouteButton>
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
        noValidate
        onSubmit={applyFilters}
        className="flex flex-wrap items-end gap-3 console-panel p-5"
        aria-label="使用记录筛选"
      >
        <label className="grid gap-2 console-label">
          模型 ID
          <Input
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
            <DateInput
              id="request-time-from"
              aria-label="开始时间"

              value={draft.from}
              onValueChange={(value) => {
                setDraft((current) => ({ ...current, from: value }));
              }}
            />
            <span aria-hidden="true" className="text-[var(--color-muted-foreground)]">
              至
            </span>
            <label className="sr-only" htmlFor="request-time-to">
              结束时间
            </label>
            <DateInput
              id="request-time-to"
              aria-label="结束时间"

              value={draft.to}
              onValueChange={(value) => {
                setDraft((current) => ({ ...current, to: value }));
              }}
            />
          </div>
        </div>
        <Button type="submit" variant="primary">
          筛选
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setDraft(emptyDraft);
            setMoreFiltersOpen(false);
            setFilterError('');
            setSearchParams(new URLSearchParams());
          }}
        >
          重置
        </Button>
        <Disclosure
          className="basis-full border-t border-[var(--color-border)] pt-4"
          open={moreFiltersOpen}
          onOpenChange={(nextOpen) => setMoreFiltersOpen(nextOpen)}
          title={<>更多筛选</>}
          triggerClassName="cursor-pointer text-sm font-medium text-[var(--color-foreground)]"
        >
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="grid gap-2 console-label">
              执行状态
              <Select
                value={draft.status}
                onValueChange={(nextValue) => {
                  const value = nextValue;
                  setDraft((current) => ({ ...current, status: value }));
                }}
                items={[
                  { value: '', label: <>全部</> },
                  ...executionStatusSchema.options.map((value) => ({
                    value: value,
                    label: <>{executionLabels[value].label}</>,
                  })),
                ]}
              />
            </label>
            <label className="grid gap-2 console-label">
              计费状态
              <Select
                value={draft.billingStatus}
                onValueChange={(nextValue) => {
                  const value = nextValue;
                  setDraft((current) => ({ ...current, billingStatus: value }));
                }}
                items={[
                  { value: '', label: <>全部</> },
                  ...billingStatusSchema.options.map((value) => ({
                    value: value,
                    label: <>{billingLabels[value].label}</>,
                  })),
                ]}
              />
            </label>
          </div>
        </Disclosure>
        {filterError && (
          <p className="m-0 basis-full text-sm text-[var(--color-destructive)]" role="alert">
            {filterError}
          </p>
        )}
      </form>
      <RequestExport filters={urlState.filters} scope="personal" />
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
          <RouteButton variant="outline" to="/chat">
            开始对话
          </RouteButton>
          <RouteButton variant="outline" to="/keys">
            接入 API
          </RouteButton>
        </div>
      )}
    </section>
  );
}
