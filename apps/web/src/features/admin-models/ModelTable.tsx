import type { ColumnDef } from '@tanstack/react-table';
import { Link } from 'react-router-dom';
import type { ModelView } from '@cheapai/api-client/models';
import { CursorTable } from '../../shared/patterns/CursorTable';
import { StatusBadge } from '../../shared/ui/StatusBadge';

export interface ModelTableProps {
  readonly rows: readonly ModelView[];
  readonly loading?: boolean;
  readonly loadingMore?: boolean;
  readonly hasMore?: boolean;
  readonly error?: string | null;
  readonly onRetry?: () => void;
  readonly onLoadMore?: () => void;
}

const columns: ColumnDef<ModelView, unknown>[] = [
  {
    accessorKey: 'publicModelId',
    header: '公开模型 ID',
    cell: ({ row }) => (
      <Link
        to={`/admin/models/${encodeURIComponent(row.original.publicModelId)}`}
        className="font-mono text-sm font-medium text-[var(--color-primary)] underline-offset-4 hover:underline"
      >
        {row.original.publicModelId}
      </Link>
    ),
  },
  {
    accessorKey: 'status',
    header: '目录状态',
    cell: ({ row }) => (
      <StatusBadge tone={row.original.status === 'active' ? 'success' : 'neutral'}>
        {row.original.status === 'active' ? '已启用' : '已停用'}
      </StatusBadge>
    ),
  },
  {
    accessorKey: 'sellPrices',
    header: () => (
      <span>
        输入 / 输出
        <br />
        <span className="font-normal text-[var(--color-muted-foreground)]">USD / 百万 Token</span>
      </span>
    ),
    cell: ({ row }) => (
      <span className="font-mono text-xs tabular-nums">
        {row.original.sellPrices.input} / {row.original.sellPrices.output}
      </span>
    ),
  },
  {
    accessorKey: 'maxOutputTokens',
    header: '最大输出',
    cell: ({ row }) => (
      <span className="tabular-nums">{row.original.maxOutputTokens.toLocaleString()}</span>
    ),
  },
  {
    accessorKey: 'priceVersion',
    header: '价格版本',
    cell: ({ row }) => <span className="font-mono text-xs">v{row.original.priceVersion}</span>,
  },
  {
    id: 'channelMappings',
    header: '渠道可用性',
    cell: ({ row }) => (
      <Link
        to={`/admin/models/${encodeURIComponent(row.original.publicModelId)}`}
        aria-label={`查看 ${row.original.publicModelId} 的渠道映射`}
        className="text-sm font-medium text-[var(--color-primary)] underline-offset-4 hover:underline"
      >
        查看映射
      </Link>
    ),
  },
];

/** The catalog status and channel mappings are separate configuration states. */
export function ModelTable({
  rows,
  loading = false,
  loadingMore = false,
  hasMore = false,
  error,
  onRetry,
  onLoadMore,
}: ModelTableProps) {
  return (
    <>
      <CursorTable
        rows={rows}
        columns={columns}
        loading={loading}
        loadingMore={loadingMore}
        hasMore={hasMore}
        error={error}
        onRetry={onRetry}
        onLoadMore={onLoadMore}
        getRowId={(model) => model.publicModelId}
        emptyMessage="没有符合当前筛选条件的模型。"
        caption="模型目录"
      />
    </>
  );
}
