import { RouteButton } from '../../shared/ui/RouteButton';
import { Field } from '../../shared/ui/Field';
import { DateInput } from '../../shared/ui/DateInput';
import { Select } from '../../shared/ui/Select';
import { Button } from '../../shared/ui/Button';
import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { billingKindSchema } from '@cheapai/contracts/billing';
import type { BillingKind } from '@cheapai/contracts/billing';
import {
  billingListQueryOptions,
  createPersonalAccountApi,
  createPersonalBillingApi,
  personalBalanceQueryOptions,
} from '../../features/billing/api';
import {
  billingDateBoundsFromInputs,
  billingDateRangeFromSearch,
  currentBillingMonthRange,
} from '../../features/billing/filters';
import { BillingSummary } from '../../features/billing/BillingSummary';
import { BillingTable } from '../../features/billing/BillingTable';
import { useSession } from '../../features/session/useSession';
import { PageHeader } from '../../shared/patterns/PageHeader';
import { mergePageItems } from '../../shared/lib/pagination';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';

const kindLabels: Record<BillingKind, string> = {
  consumption: '模型消费',
  image_generation: '图片生成',
  grant: '管理员授额',
  adjustment: '余额调整',
};

function validRequestId(value: string | null): string | undefined {
  if (
    !value ||
    value.length > 128 ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u.test(value)
  ) {
    return undefined;
  }
  return value;
}

function searchParamsForFilters(
  bounds: { readonly createdFrom?: number; readonly createdBefore?: number },
  kind: BillingKind | undefined,
  requestId: string | undefined,
): URLSearchParams {
  const next = new URLSearchParams();
  if (bounds.createdFrom === undefined && bounds.createdBefore === undefined)
    next.set('period', 'all');
  if (bounds.createdFrom !== undefined) next.set('createdFrom', String(bounds.createdFrom));
  if (bounds.createdBefore !== undefined) next.set('createdBefore', String(bounds.createdBefore));
  if (kind) next.set('kind', kind);
  if (requestId) next.set('requestId', requestId);
  return next;
}

export function BillingPage() {
  const { client, user, state: session } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const searchKey = searchParams.toString();
  const parsedParams = useMemo(() => new URLSearchParams(searchKey), [searchKey]);
  const dateRange = useMemo(() => billingDateRangeFromSearch(parsedParams), [parsedParams]);
  const defaultMonth = useMemo(() => currentBillingMonthRange(), []);
  const kindValue = parsedParams.get('kind') ?? '';
  const parsedKind = kindValue ? billingKindSchema.safeParse(kindValue) : null;
  const kind = parsedKind?.success ? parsedKind.data : undefined;
  const requestId = validRequestId(parsedParams.get('requestId'));
  const filters = useMemo(
    () => ({
      ...(dateRange.createdFrom === undefined ? {} : { createdFrom: dateRange.createdFrom }),
      ...(dateRange.createdBefore === undefined ? {} : { createdBefore: dateRange.createdBefore }),
      ...(kind ? { kind } : {}),
      ...(requestId ? { requestId } : {}),
    }),
    [dateRange.createdBefore, dateRange.createdFrom, kind, requestId],
  );
  const billingApi = useMemo(() => createPersonalBillingApi(client), [client]);
  const accountApi = useMemo(() => createPersonalAccountApi(client), [client]);
  const userId = user?.id ?? 'anonymous';
  const enabled = session.status === 'authenticated' && user !== null;
  const query = useInfiniteQuery({
    ...billingListQueryOptions(billingApi, userId, filters),
    enabled,
  });
  const balanceQuery = useQuery({
    ...personalBalanceQueryOptions(accountApi, userId),
    enabled,
  });
  const rows = mergePageItems(query.data?.pages);
  const [dateDraft, setDateDraft] = useState({
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
  });
  const [dateError, setDateError] = useState('');
  const [kindDraft, setKindDraft] = useState<BillingKind | ''>(kind ?? '');

  useEffect(() => {
    const normalized = searchParamsForFilters(dateRange, kind, requestId);
    if (normalized.toString() !== searchKey) setSearchParams(normalized, { replace: true });
  }, [dateRange, kind, requestId, searchKey, setSearchParams]);

  useEffect(() => {
    setKindDraft(kind ?? '');
    setDateDraft({ startDate: dateRange.startDate, endDate: dateRange.endDate });
    setDateError('');
  }, [dateRange.endDate, dateRange.startDate, searchKey, kind]);

  const hasCustomDateRange =
    dateRange.createdFrom !== defaultMonth.createdFrom ||
    dateRange.createdBefore !== defaultMonth.createdBefore;
  const hasActiveFilters = Boolean(kind || requestId || hasCustomDateRange);
  const emptyMessage = hasActiveFilters ? '没有符合筛选条件的记录。' : '本期间暂无费用记录。';

  function updateDate(field: 'startDate' | 'endDate', value: string) {
    const nextDraft = { ...dateDraft, [field]: value };
    setDateDraft(nextDraft);
    setDateError('');
  }

  function applyFilters() {
    const bounds = billingDateBoundsFromInputs(dateDraft.startDate, dateDraft.endDate);
    if (!bounds) {
      setDateError('请选择有效的日期范围，结束日期应不早于开始日期。');
      return;
    }
    setDateError('');
    setSearchParams(searchParamsForFilters(bounds, kindDraft || undefined, requestId));
  }

  function clearFilters() {
    setKindDraft('');
    setDateDraft({ startDate: defaultMonth.startDate, endDate: defaultMonth.endDate });
    setDateError('');
    setSearchParams(searchParamsForFilters(defaultMonth, undefined, undefined));
  }

  function retryBilling() {
    void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch());
  }

  return (
    <section className="space-y-4">
      <PageHeader
        heading="费用"
        description="查看账户余额、消费汇总与每笔余额变动。"
        actions={
          <Button
            variant="outline"
            busy={query.isFetching || balanceQuery.isFetching}
            onClick={() => {
              void query.refetch();
              void balanceQuery.refetch();
            }}
          >
            刷新费用
          </Button>
        }
      />
      <BillingSummary
        balance={balanceQuery.data}
        balanceLoading={balanceQuery.isPending}
        balanceError={balanceQuery.error}
        onRetryBalance={() => void balanceQuery.refetch()}
        summary={query.data?.pages[0]?.summary}
        summaryLoading={query.isPending}
        summaryError={query.isFetchNextPageError ? undefined : query.error}
        onRetrySummary={retryBilling}
        periodLabel={
          dateRange.startDate && dateRange.endDate
            ? `${dateRange.startDate} 至 ${dateRange.endDate}`
            : dateRange.startDate
              ? `${dateRange.startDate} 起`
              : dateRange.endDate
                ? `截至 ${dateRange.endDate}`
                : '全部时间'
        }
      />
      <p className="text-sm leading-6 text-[var(--color-muted-foreground)]">
        汇总包含所选日期内的全部对话、API 与生图消费；类型和请求筛选仅作用于下方明细。
      </p>
      <form
        noValidate
        className="flex flex-wrap items-end gap-3 console-panel p-5"
        aria-label="费用筛选"
        onSubmit={(event) => {
          event.preventDefault();
          applyFilters();
        }}
      >
        <fieldset className="flex min-w-0 flex-wrap items-end gap-3 border-0 p-0">
          <legend className="sr-only">日期范围</legend>
          <Field label="开始日期">
            <DateInput
              mode="date"
              value={dateDraft.startDate}
              onValueChange={(value) => updateDate('startDate', value)}
            />
          </Field>
          <span className="pb-3 text-sm text-[var(--color-ink-muted)]">至</span>
          <Field label="结束日期">
            <DateInput
              mode="date"
              value={dateDraft.endDate}
              onValueChange={(value) => updateDate('endDate', value)}
            />
          </Field>
        </fieldset>
        <Button
          variant="outline"
          aria-pressed={
            dateRange.startDate === defaultMonth.startDate &&
            dateRange.endDate === defaultMonth.endDate
          }
          onClick={() => {
            setDateDraft({ startDate: defaultMonth.startDate, endDate: defaultMonth.endDate });
            setDateError('');
            setSearchParams(
              searchParamsForFilters(defaultMonth, kindDraft || undefined, requestId),
            );
          }}
        >
          本月
        </Button>
        <Button
          variant="outline"
          aria-pressed={!dateRange.startDate && !dateRange.endDate}
          onClick={() => {
            setDateDraft({ startDate: '', endDate: '' });
            setDateError('');
            setSearchParams(searchParamsForFilters({}, kindDraft || undefined, requestId));
          }}
        >
          全部时间
        </Button>
        <label className="grid gap-2 console-label">
          类型
          <Select
            aria-label="费用类型"
            value={kindDraft}
            onValueChange={(nextValue) => setKindDraft(nextValue as BillingKind | '')}
            className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[15px]"
            items={[
              { value: '', label: <>全部类型</> },
              ...billingKindSchema.options.map((value) => ({
                value: value,
                label: <>{kindLabels[value]}</>,
              })),
            ]}
          />
        </label>
        <Button type="submit" variant="secondary">
          筛选
        </Button>
        {requestId && (
          <div className="flex min-h-10 min-w-0 items-center gap-2 rounded-md bg-[var(--color-surface-subtle)] px-3 text-[15px] text-[var(--color-ink-secondary)]">
            <span className="min-w-0 break-all">请求 ID 筛选：{requestId}</span>
            <Button
              variant="ghost"
              size="sm"
              aria-label="清除请求 ID 筛选"
              onClick={() => setSearchParams(searchParamsForFilters(dateRange, kind, undefined))}
            >
              清除
            </Button>
          </div>
        )}
        <Button variant="outline" onClick={clearFilters}>
          重置筛选
        </Button>
        {dateError && (
          <p className="m-0 basis-full text-sm text-[var(--color-destructive)]" role="alert">
            {dateError}
          </p>
        )}
      </form>
      {query.error && (
        <ApiErrorNotice error={query.error} onRetry={retryBilling} />
      )}
      {(!query.error || rows.length > 0) && (
        <BillingTable
          rows={rows}
          loading={query.isPending}
          loadingMore={query.isFetchingNextPage}
          hasMore={query.hasNextPage}
          emptyMessage={emptyMessage}
          onLoadMore={() => {
            void query.fetchNextPage();
          }}
        />
      )}
      {query.isSuccess && rows.length === 0 && !hasActiveFilters && (
        <div className="flex flex-wrap gap-2">
          <RouteButton variant="outline" to="/chat">
            开始对话
          </RouteButton>
          <RouteButton variant="outline" to="/images">
            生成图片
          </RouteButton>
        </div>
      )}
    </section>
  );
}
