import type { ColumnDef } from '@tanstack/react-table';
import { Button } from '../../shared/ui/Button';
import { Link } from 'react-router-dom';
import type { ModelView } from '@cheapai/api-client/models';
import { CursorTable } from '../../shared/patterns/CursorTable';
import { ModelIdentity } from '../../shared/ui/ModelIdentity';
import { StatusBadge } from '../../shared/ui/StatusBadge';

export interface ModelTableProps {
  readonly emptyMessage?: string;
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
        className="block min-w-40 max-w-72 text-sm text-[var(--color-primary)] underline-offset-4 hover:underline"
      >
        <ModelIdentity modelId={row.original.publicModelId} />
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
        输入价格<span className="block text-sm font-normal">USD / 百万 Token</span>
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
        输出价格<span className="block text-sm font-normal">USD / 百万 Token</span>
      </div>
    ),
    cell: ({ row }) => (
      <span className="console-number block text-right">{row.original.sellPrices.output}</span>
    ),
  },
  {
    id: 'channelMappings',
    header: '渠道映射',
    cell: ({ row }) => (
      <Button asChild variant="outline" size="sm">
        <Link
          to={`/admin/models/${encodeURIComponent(row.original.publicModelId)}`}
          aria-label={`查看 ${row.original.publicModelId} 的渠道映射`}
        >
          查看映射
        </Link>
      </Button>
    ),
  },
];

/** The catalog status and channel mappings are separate configuration states. */
export function ModelTable({
  rows,
  emptyMessage,
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
      emptyMessage={emptyMessage ?? '暂无模型，新增模型后将在这里显示。'}
      caption="模型目录，输入与输出价格单位为 USD / 百万 Token"
    />
  );
}
