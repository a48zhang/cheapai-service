import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import type { RequestRecord } from '@cheapai/contracts/requests';
import { createDashboardApi, balanceQueryOptions, recentRequestsQueryOptions } from '../../features/dashboard/api';
import { BalanceCard } from '../../features/dashboard/BalanceCard';
import { useSession } from '../../features/session/useSession';
import { formatDateTime } from '../../shared/lib/datetime';
import { formatUnitsToUsd } from '../../shared/lib/money';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { AsyncState } from '../../shared/patterns/AsyncState';
import { PageHeader } from '../../shared/patterns/PageHeader';
import { CursorTable } from '../../shared/patterns/CursorTable';
import { RequestStatus } from '../../features/request-history/RequestStatus';

function costLabel(item: RequestRecord): string {
  if (item.cost_units !== null) {
    try { return `${formatUnitsToUsd(item.cost_units)} USD`; } catch { return '费用未知'; }
  }
  switch (item.billing_status) {
    case 'awaiting_usage': return '等待用量';
    case 'settlement_pending': return '待结算';
    case 'usage_unknown': return '费用未知';
    case 'not_chargeable': return '不计费';
    case 'settled': return '费用未知';
  }
}

export function DashboardPage() {
  const { client, user, state: session } = useSession();
  const api = useMemo(() => createDashboardApi(client), [client]);
  const userId = user?.id ?? 'anonymous';
  const enabled = session.status === 'authenticated' && user !== null;
  const balanceQuery = useQuery({ ...balanceQueryOptions(api, userId), enabled });
  const recentQuery = useQuery({ ...recentRequestsQueryOptions(api, userId), enabled });
  const recent = recentQuery.data?.items.slice(0, 5) ?? [];

  const columns: ColumnDef<RequestRecord, unknown>[] = [
    { id: 'model', header: '模型', cell: ({ row }) => <div className="min-w-36"><Link className="font-medium text-indigo-700 hover:underline" to={`/requests/${encodeURIComponent(row.original.id)}`}>{row.original.public_model_id}</Link><p className="m-0 mt-1 font-mono text-[11px] text-slate-500">{row.original.id}</p></div> },
    { id: 'status', header: '执行 / 计费', cell: ({ row }) => <RequestStatus executionStatus={row.original.execution_status} billingStatus={row.original.billing_status} /> },
    { id: 'cost', header: '费用', cell: ({ row }) => <span className="whitespace-nowrap font-mono text-xs tabular-nums">{costLabel(row.original)}</span> },
    { id: 'created', header: '时间', cell: ({ row }) => {
      const date = new Date(row.original.created_at);
      return <time dateTime={Number.isFinite(date.getTime()) ? date.toISOString() : undefined} className="whitespace-nowrap text-xs">{formatDateTime(row.original.created_at)}</time>;
    } },
  ];

  return <section className="space-y-7">
    <PageHeader heading="账户概览" description="余额、接入入口与最近的模型请求。"
      actions={<Link className="rounded-md bg-[var(--primary)] px-4 py-2.5 text-sm font-medium text-white hover:opacity-90" to="/keys">管理 API Keys <ArrowUpRight aria-hidden="true" className="inline-block align-[-2px]" size={14} /></Link>} />
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(17rem,0.9fr)]">
      <BalanceCard balance={balanceQuery.data} loading={balanceQuery.isPending} refreshing={balanceQuery.isFetching}
        error={balanceQuery.error} onRetry={() => void balanceQuery.refetch()} />
      <nav aria-label="账户操作" className="grid content-center divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5">
        <Link className="flex items-center justify-between gap-4 py-5 text-sm font-medium hover:text-[var(--primary)]" to="/keys"><span><strong className="block">API Keys</strong><small className="mt-1 block font-normal text-[var(--muted)]">创建和管理接入密钥</small></span><ArrowUpRight aria-hidden="true" className="inline-block align-[-2px]" size={14} /></Link>
        <Link className="flex items-center justify-between gap-4 py-5 text-sm font-medium hover:text-[var(--primary)]" to="/requests"><span><strong className="block">请求记录</strong><small className="mt-1 block font-normal text-[var(--muted)]">查看执行与结算明细</small></span><ArrowUpRight aria-hidden="true" className="inline-block align-[-2px]" size={14} /></Link>
        <Link className="flex items-center justify-between gap-4 py-5 text-sm font-medium hover:text-[var(--primary)]" to="/billing"><span><strong className="block">账单明细</strong><small className="mt-1 block font-normal text-[var(--muted)]">按账本核对余额变化</small></span><ArrowUpRight aria-hidden="true" className="inline-block align-[-2px]" size={14} /></Link>
      </nav>
    </div>

    <section className="space-y-4" aria-labelledby="recent-requests-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h2 id="recent-requests-heading" className="m-0 text-lg font-semibold">最近请求</h2><p className="mb-0 mt-1 text-sm text-[var(--muted)]">最多显示最近五条记录。</p></div>
        <Link className="text-sm font-medium text-[var(--primary)] hover:underline" to="/requests">全部请求 <ArrowUpRight aria-hidden="true" className="inline-block align-[-2px]" size={14} /></Link>
      </div>
      {recentQuery.error && <ApiErrorNotice error={recentQuery.error} onRetry={() => void recentQuery.refetch()} />}
      {recentQuery.isPending ? <AsyncState status="loading" loadingLabel="正在读取请求…" /> : null}
      {!recentQuery.isPending && !recentQuery.error && recent.length === 0 && <AsyncState status="empty" heading="还没有请求记录" description="用 API Key 发起首次调用后，记录会出现在这里。" action={<Link className="rounded-md border border-[var(--border)] px-4 py-2 text-sm font-medium hover:bg-[var(--surface-muted)]" to="/keys">前往 API Keys</Link>} />}
      {recent.length > 0 && <CursorTable rows={recent} columns={columns} getRowId={row => row.id} loading={false} caption="最近五条请求" emptyMessage="还没有请求记录。" />}
    </section>
  </section>;
}
