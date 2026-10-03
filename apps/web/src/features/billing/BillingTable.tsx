import { Link } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import type { BillingEntry, BillingKind } from '@cheapai/contracts/billing';
import { formatDateTime } from '../../shared/lib/datetime';
import { formatUnitsToUsd } from '../../shared/lib/money';
import { CursorTable } from '../../shared/patterns/CursorTable';

export interface BillingTableProps {
  readonly rows: readonly BillingEntry[];
  readonly scope?: 'personal' | 'admin';
  readonly hasMore?: boolean;
  readonly loading?: boolean;
  readonly loadingMore?: boolean;
  readonly error?: string | null;
  readonly onLoadMore?: () => void;
  readonly onRetry?: () => void;
}

const kindLabels: Record<BillingKind, string> = {
  consumption: '模型消费',
  grant: '管理员授额',
  adjustment: '余额调整',
};

function amountLabel(value: string): string {
  try { return `${formatUnitsToUsd(value)} USD`; } catch { return '金额未知'; }
}

/** Ledger rows link back to their source request when one exists. */
export function BillingTable({ rows, scope = 'personal', hasMore, loading, loadingMore, error, onLoadMore, onRetry }: BillingTableProps) {
  const columns: ColumnDef<BillingEntry, unknown>[] = [
    { id: 'kind', header: '类型', cell: ({ row }) => <span className="font-medium text-slate-800">{kindLabels[row.original.kind]}</span> },
    { id: 'amount', header: '金额变化', cell: ({ row }) => <span className="whitespace-nowrap font-mono text-sm font-medium tabular-nums text-slate-900">{amountLabel(row.original.deltaUnits)}</span> },
    ...(scope === 'admin' ? [{ id: 'user', header: '用户', cell: ({ row }) => <span className="break-all font-mono text-xs text-slate-600">{row.original.userId}</span> } as ColumnDef<BillingEntry, unknown>] : []),
    {
      id: 'request', header: '相关请求',
      cell: ({ row }) => row.original.requestId
        ? <Link className="font-mono text-xs text-indigo-700 hover:underline" to={`${scope === 'admin' ? '/admin/requests' : '/requests'}/${encodeURIComponent(row.original.requestId)}`}>{row.original.requestId}</Link>
        : <span className="text-slate-500">—</span>,
    },
    { id: 'reason', header: '原因', cell: ({ row }) => <span className="block min-w-40 max-w-xl break-words text-sm text-slate-600">{row.original.reason ?? (row.original.kind === 'consumption' ? '模型消费' : '—')}</span> },
    { id: 'created', header: '时间', cell: ({ row }) => <time dateTime={row.original.createdAt} className="whitespace-nowrap text-xs text-slate-600">{formatDateTime(row.original.createdAt)}</time> },
  ];

  return <CursorTable rows={rows} columns={columns} getRowId={row => row.id} hasMore={hasMore} loading={loading}
    loadingMore={loadingMore} error={error} onLoadMore={onLoadMore} onRetry={onRetry}
    emptyMessage="当前筛选下没有账单记录。" caption={scope === 'admin' ? '全局账单明细' : '个人账单明细'} />;
}
