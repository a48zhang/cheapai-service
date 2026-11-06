import { RouteButton } from '../../shared/ui/RouteButton';
import { useLocation } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import type { BillingEntry, BillingKind } from '@cheapai/contracts/billing';
import { formatDateTime } from '../../shared/lib/datetime';
import { formatConsumptionUsd } from '../../shared/lib/money';
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
  image_generation: '图片生成',
  grant: '管理员授额',
  adjustment: '积分调整',
};

function amountLabel(value: string, showPositiveSign = false): string {
  try {
    const units = BigInt(value);
    return `${showPositiveSign && units > 0n ? '+' : ''}${formatConsumptionUsd(units)}`;
  } catch {
    return '积分数值不可用';
  }
}
function sourceLabel(source: BillingEntry['source']) {
  return source === 'web_image'
    ? '网页生图'
    : source === 'web_chat'
      ? '网页聊天'
      : source === 'api'
        ? 'API'
        : '—';
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
  const location = useLocation();
  const returnTo = location.pathname + location.search;
  const recordLink = (entry: BillingEntry) => {
    const query = new URLSearchParams({ returnTo });
    if (entry.requestId)
      return (
        <RouteButton
          variant="outline"
          size="sm"
          to={`/requests/${encodeURIComponent(entry.requestId)}?${query}`}
        >
          查看记录
        </RouteButton>
      );
    if (entry.imageGenerationId) {
      query.set('job', entry.imageGenerationId);
      return (
        <RouteButton variant="outline" size="sm" to={`/images?${query}`}>
          查看图片
        </RouteButton>
      );
    }
    return <span className="text-[var(--color-ink-muted)]">—</span>;
  };
  const adminColumns: ColumnDef<BillingEntry, unknown>[] = [
    {
      id: 'kind',
      header: '类型',
      size: 120,
      cell: ({ row }) => (
        <span className="whitespace-nowrap font-medium text-[var(--color-ink)]">
          {kindLabels[row.original.kind]}
        </span>
      ),
    },
    {
      id: 'amount',
      header: '积分变动',
      size: 180,
      meta: { align: 'right', numeric: true },
      cell: ({ row }) => (
        <span className="whitespace-nowrap console-number text-[15px] font-medium text-[var(--color-ink)]">
          {amountLabel(row.original.deltaUnits)}
        </span>
      ),
    },
    ...(scope === 'admin'
      ? [
          {
            id: 'user',
            header: '用户',
            cell: ({ row }) => (
              <RouteButton
                className="block max-w-48 truncate text-[var(--color-accent)]"
                title={row.original.userEmail ?? row.original.userId}
                to={`/admin/users/${encodeURIComponent(row.original.userId)}`}
              >
                {row.original.userEmail ?? row.original.userId}
              </RouteButton>
            ),
          } as ColumnDef<BillingEntry, unknown>,
        ]
      : []),
    {
      id: 'request',
      header: '相关请求',
      cell: ({ row }) =>
        row.original.requestId ? (
          <RouteButton
            variant="outline"
            size="sm"
            title={row.original.requestId}
            to={`${scope === 'admin' ? '/admin/requests' : '/requests'}/${encodeURIComponent(row.original.requestId)}`}
          >
            查看请求
          </RouteButton>
        ) : (
          <span className="text-[var(--color-ink-muted)]">—</span>
        ),
    },
    {
      id: 'reason',
      header: '原因',
      size: 160,
      cell: ({ row }) => (
        <span
          title={row.original.reason ?? undefined}
          className="block max-w-56 truncate text-sm text-[var(--color-ink-secondary)]"
        >
          {row.original.reason ?? (row.original.kind === 'consumption' ? '模型消费' : '—')}
        </span>
      ),
    },
    {
      id: 'created',
      header: '时间',
      size: 190,
      cell: ({ row }) => (
        <time
          dateTime={row.original.createdAt}
          className="whitespace-nowrap text-sm text-[var(--color-ink-secondary)]"
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
      size: 190,
      cell: ({ row }) => (
        <time
          dateTime={row.original.createdAt}
          className="whitespace-nowrap text-sm text-[var(--color-ink-secondary)]"
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
            <span className="font-mono text-sm text-[var(--color-ink-muted)]">
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
          {sourceLabel(row.original.source)}
        </span>
      ),
    },
    {
      id: 'amount',
      header: '积分变动',
      size: 180,
      meta: { align: 'right', numeric: true },
      cell: ({ row }) => (
        <span className="whitespace-nowrap console-number text-[15px] font-medium text-[var(--color-ink)]">
          {amountLabel(row.original.deltaUnits, true)}
        </span>
      ),
    },
    {
      id: 'request',
      header: '记录',
      cell: ({ row }) => recordLink(row.original),
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
      renderMobileRow={
        scope === 'personal'
          ? (entry) => (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{kindLabels[entry.kind]}</span>
                  <span
                    className="console-number font-semibold"
                    aria-label={`积分变动 ${amountLabel(entry.deltaUnits, true)} 积分`}
                  >
                    {amountLabel(entry.deltaUnits, true)} 积分
                  </span>
                </div>
                {entry.modelId && <p className="break-all text-sm">{entry.modelId}</p>}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-muted-foreground)]">
                  <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
                  {entry.source && <span>{sourceLabel(entry.source)}</span>}
                </div>
                {(entry.requestId || entry.imageGenerationId) && recordLink(entry)}
              </div>
            )
          : undefined
      }
    />
  );
}
