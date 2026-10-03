import { Link, useLocation } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { formatDateTime } from '../../shared/lib/datetime';
import { formatUnitsToUsd } from '../../shared/lib/money';
import { CursorTable } from '../../shared/patterns/CursorTable';
import { RequestStatus } from './RequestStatus';
import type { RequestRecord } from '@cheapai/contracts/requests';

export interface RequestTableProps {
  readonly rows: readonly RequestRecord[];
  readonly scope?: 'personal' | 'admin';
  readonly returnTo?: string;
  readonly hasMore?: boolean;
  readonly loading?: boolean;
  readonly loadingMore?: boolean;
  readonly error?: string | null;
  readonly onLoadMore?: () => void;
  readonly onRetry?: () => void;
}

function usageText(item: RequestRecord): string {
  if (item.usage_valid !== true || item.usage === null) return item.usage_valid === false ? '用量数据无效' : '用量未知';
  if (item.usage.quality === 'missing') return '上游未提供用量';
  if (item.usage.quality === 'invalid') return '用量记录无效';
  const counts = item.usage.counts;
  const input = counts.inputTokens === undefined ? '—' : String(counts.inputTokens);
  const output = counts.outputTokens === undefined ? '—' : String(counts.outputTokens);
  return `${item.usage.quality === 'complete' ? '完整' : '部分'} · 输入 ${input} / 输出 ${output}`;
}

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

/** Shared personal/admin table. Detail links carry the current filters and cursor back to the list. */
export function RequestTable({ rows, scope = 'personal', returnTo, hasMore, loading, loadingMore, error, onLoadMore, onRetry }: RequestTableProps) {
  const location = useLocation();
  const listLocation = returnTo ?? `${location.pathname}${location.search}`;
  const detailPath = scope === 'admin' ? '/admin/requests' : '/requests';
  const columns: ColumnDef<RequestRecord, unknown>[] = [
    {
      id: 'request', header: scope === 'admin' ? '请求 / 用户' : '请求 / 模型',
      cell: ({ row }) => <div className="min-w-48 space-y-1">
        <Link className="font-mono text-xs font-medium text-indigo-700 hover:text-indigo-900" to={`${detailPath}/${encodeURIComponent(row.original.id)}?${new URLSearchParams({ returnTo: listLocation })}`}>
          {row.original.id}
        </Link>
        <p className="m-0 break-all font-medium text-slate-900">{row.original.public_model_id}</p>
        {scope === 'admin' && <p className="m-0 break-all text-xs text-slate-500">{row.original.user_id}</p>}
        <p className="m-0 text-xs text-slate-500">{row.original.downstream_protocol} → {row.original.upstream_protocol} · {row.original.upstream_model}</p>
      </div>,
    },
    {
      id: 'source', header: '来源 / 分组',
      cell: ({ row }) => <div className="min-w-28 text-sm">
        <span>{row.original.source === 'web_chat' ? '网页聊天' : 'API 请求'}</span>
        <p className="m-0 mt-1 break-all text-xs text-slate-500">分组：{row.original.group_id ?? '未知'}</p>
        {scope === 'admin' && <Link className="mt-1 inline-block text-xs text-indigo-700 hover:underline" to={`/admin/billing?${new URLSearchParams({ userId: row.original.user_id, requestId: row.original.id })}`}>查看相关账单</Link>}
      </div>,
    },
    {
      id: 'status', header: '执行 / 计费',
      cell: ({ row }) => <RequestStatus executionStatus={row.original.execution_status} billingStatus={row.original.billing_status} />,
    },
    { id: 'usage', header: '用量', cell: ({ row }) => <span className="whitespace-nowrap text-xs text-slate-600">{usageText(row.original)}</span> },
    { id: 'cost', header: '费用', cell: ({ row }) => <span className="whitespace-nowrap font-mono text-sm tabular-nums text-slate-800">{costLabel(row.original)}</span> },
    { id: 'created', header: '创建时间', cell: ({ row }) => {
      const date = new Date(row.original.created_at);
      return <time dateTime={Number.isFinite(date.getTime()) ? date.toISOString() : undefined} className="whitespace-nowrap text-xs text-slate-600">{formatDateTime(row.original.created_at)}</time>;
    } },
  ];

  return <CursorTable rows={rows} columns={columns} getRowId={row => row.id} hasMore={hasMore} loading={loading}
    loadingMore={loadingMore} error={error} onLoadMore={onLoadMore} onRetry={onRetry}
    emptyMessage="当前筛选下没有请求记录。" caption={scope === 'admin' ? '全局请求列表' : '个人请求列表'} />;
}
