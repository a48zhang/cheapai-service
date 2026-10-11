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
    header: '模型名称',
    cell: ({ row }) => (
      <Link
        to={`/admin/models/${encodeURIComponent(row.original.publicModelId)}`}
        title={row.original.publicModelId}
        className="block min-w-40 max-w-72 truncate font-mono text-sm font-medium text-[var(--color-primary)] underline-offset-4 hover:underline"
      >
        {row.original.publicModelId}
      </Link>
    ),
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: ({ row }) => (
      <StatusBadge tone={row.original.status === 'active' ? 'success' : 'neutral'}>
        {row.original.status === 'active' ? '启用' : '停用'}
      </StatusBadge>
    ),
  },
  {
    id: 'inputPrice',
    meta: { align: 'right', numeric: true },
    accessorFn: (model) => model.sellPrices.input,
    header: () => (
      <div className="text-right">
        输入价格<span className="block text-xs font-normal">USD / 百万 Token</span>
      </div>
    ),
    cell: ({ row }) => (
      <span className="console-number block text-right">{row.original.sellPrices.input}</span>
    ),
  },
  {
    id: 'outputPrice',
    meta: { align: 'right', numeric: true },
    accessorFn: (model) => model.sellPrices.output,
    header: () => (
      <div className="text-right">
        输出价格<span className="block text-xs font-normal">USD / 百万 Token</span>
      </div>
    ),
    cell: ({ row }) => (
      <span className="console-number block text-right">{row.original.sellPrices.output}</span>
    ),
  },
  {
    accessorKey: 'maxOutputTokens',
    meta: { align: 'right', numeric: true },
    header: '最大输出 Token',
    cell: ({ row }) => (
      <span className="whitespace-nowrap tabular-nums">
        {row.original.maxOutputTokens.toLocaleString()}
      </span>
    ),
  },
  {
    id: 'channelMappings',
    header: '渠道映射',
    cell: ({ row }) => (
      <Link
        to={`/admin/models/${encodeURIComponent(row.original.publicModelId)}`}
        aria-label={`查看 ${row.original.publicModelId} 的渠道映射`}
        className="whitespace-nowrap text-sm font-medium text-[var(--color-primary)] underline-offset-4 hover:underline"
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
      emptyMessage="暂无模型，可调整筛选条件或新增模型。"
      caption="模型目录，输入与输出价格单位为 USD / 百万 Token"
    />
  );
}
