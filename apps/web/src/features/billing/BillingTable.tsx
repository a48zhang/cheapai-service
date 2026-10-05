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
  readonly error?: string | null | undefined;
  readonly emptyMessage?: string;
  readonly onLoadMore?: () => void;
  readonly onRetry?: () => void;
}

const kindLabels: Record<BillingKind, string> = {
  consumption: '模型消费',
  grant: '管理员授额',
  adjustment: '余额调整',
};

function amountLabel(value: string, kind: BillingKind, showConsumptionAsCost = false): string {
  try {
    const units = showConsumptionAsCost && kind === 'consumption' ? -BigInt(value) : BigInt(value);
    return `${formatUnitsToUsd(units)} USD`;
  } catch {
    return '金额未知';
  }
}

/** Ledger rows link back to their source request when one exists. */
export function BillingTable({
  rows,
  scope = 'personal',
  hasMore,
  loading,
  loadingMore,
  error,
  emptyMessage,
  onLoadMore,
  onRetry,
}: BillingTableProps) {
  const adminColumns: ColumnDef<BillingEntry, unknown>[] = [
    {
      id: 'kind',
      header: '类型',
      cell: ({ row }) => (
        <span className="font-medium text-[var(--color-ink)]">{kindLabels[row.original.kind]}</span>
      ),
    },
    {
      id: 'amount',
      header: '金额变化',
      cell: ({ row }) => (
        <span className="whitespace-nowrap font-mono text-sm font-medium tabular-nums text-[var(--color-ink)]">
          {amountLabel(row.original.deltaUnits, row.original.kind)}
        </span>
      ),
    },
    ...(scope === 'admin'
      ? [
          {
            id: 'user',
            header: '用户',
            cell: ({ row }) => (
              <span className="break-all font-mono text-xs text-[var(--color-ink-secondary)]">
                {row.original.userId}
              </span>
            ),
          } as ColumnDef<BillingEntry, unknown>,
        ]
      : []),
    {
      id: 'request',
      header: '相关请求',
      cell: ({ row }) =>
        row.original.requestId ? (
          <Link
            className="font-mono text-xs text-[var(--color-accent)] hover:underline"
            to={`${scope === 'admin' ? '/admin/requests' : '/requests'}/${encodeURIComponent(row.original.requestId)}`}
          >
            {row.original.requestId}
          </Link>
        ) : (
          <span className="text-[var(--color-ink-muted)]">—</span>
        ),
    },
    {
      id: 'reason',
      header: '原因',
      cell: ({ row }) => (
        <span className="block min-w-40 max-w-xl break-words text-sm text-[var(--color-ink-secondary)]">
          {row.original.reason ?? (row.original.kind === 'consumption' ? '模型消费' : '—')}
        </span>
      ),
    },
    {
      id: 'created',
      header: '时间',
      cell: ({ row }) => (
        <time
          dateTime={row.original.createdAt}
          className="whitespace-nowrap text-xs text-[var(--color-ink-secondary)]"
        >
          {formatDateTime(row.original.createdAt)}
        </time>
      ),
    },
  ];
  const personalColumns: ColumnDef<BillingEntry, unknown>[] = [
    {
      id: 'created',
      header: '时间',
      cell: ({ row }) => (
        <time
          dateTime={row.original.createdAt}
          className="whitespace-nowrap text-xs text-[var(--color-ink-secondary)]"
        >
          {formatDateTime(row.original.createdAt)}
        </time>
      ),
    },
    {
      id: 'type-model',
      header: '类型 / 模型',
      cell: ({ row }) => (
        <div className="grid gap-1">
          <span className="font-medium text-[var(--color-ink)]">
            {kindLabels[row.original.kind]}
          </span>
          {row.original.modelId && (
            <span className="font-mono text-xs text-[var(--color-ink-muted)]">
              {row.original.modelId}
            </span>
          )}
        </div>
      ),
    },
    {
      id: 'source',
      header: '来源',
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-[var(--color-ink-secondary)]">
          {row.original.source === 'web_chat'
            ? '网页聊天'
            : row.original.source === 'api'
              ? 'API'
              : '—'}
        </span>
      ),
    },
    {
      id: 'amount',
      header: '金额',
      cell: ({ row }) => (
        <span className="whitespace-nowrap font-mono text-sm font-medium tabular-nums text-[var(--color-ink)]">
          {amountLabel(row.original.deltaUnits, row.original.kind, true)}
        </span>
      ),
    },
    {
      id: 'request',
      header: '记录',
      cell: ({ row }) =>
        row.original.requestId ? (
          <Link
            className="whitespace-nowrap text-[var(--color-accent)] hover:underline"
            to={`/requests/${encodeURIComponent(row.original.requestId)}`}
          >
            查看记录
          </Link>
        ) : (
          <span className="text-[var(--color-ink-muted)]">—</span>
        ),
    },
  ];

  return (
    <CursorTable
      rows={rows}
      columns={scope === 'admin' ? adminColumns : personalColumns}
      getRowId={(row) => row.id}
      hasMore={hasMore}
      loading={loading}
      loadingMore={loadingMore}
      error={error}
      onLoadMore={onLoadMore}
      onRetry={onRetry}
      emptyMessage={emptyMessage ?? '当前筛选下没有账单记录。'}
      caption={scope === 'admin' ? '全局账单明细' : '个人账单明细'}
    />
  );
}
