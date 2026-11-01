import { RouteButton } from '../../shared/ui/RouteButton';
import type { ColumnDef } from '@tanstack/react-table';
import type { GroupView } from '@cheapai/api-client/groups';
import { CursorTable } from '../../shared/patterns/CursorTable';
import { StatusBadge } from '../../shared/ui/StatusBadge';

export interface GroupTableProps {
  readonly emptyMessage?: string;
  readonly rows: readonly GroupView[];
  readonly loading?: boolean;
  readonly loadingMore?: boolean;
  readonly hasMore?: boolean;
  readonly error?: string | null;
  readonly onRetry?: () => void;
  readonly onLoadMore?: () => void;
}

const columns: ColumnDef<GroupView, unknown>[] = [
  {
    accessorKey: 'name',
    header: '访问组',
    cell: ({ row }) => (
      <div className="grid min-w-40 gap-1">
        <RouteButton
          to={`/admin/groups/${encodeURIComponent(row.original.id)}`}
          title={row.original.name}
          className="block max-w-80 truncate font-medium text-[var(--color-primary)]"
        >
          {row.original.name}
        </RouteButton>
      </div>
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
    accessorKey: 'billingMultiplier',
    header: '计费倍率',
    cell: ({ row }) => (
      <code className="font-mono text-sm tabular-nums">{row.original.billingMultiplier}×</code>
    ),
  },
  {
    accessorKey: 'channelIds',
    header: '关联渠道',
    cell: ({ row }) => (
      <RouteButton
        to={`/admin/groups/${encodeURIComponent(row.original.id)}`}
        className="text-[var(--color-primary)]"
      >
        {row.original.channelIds.length > 0
          ? `${row.original.channelIds.length} 个渠道`
          : '未关联渠道'}
      </RouteButton>
    ),
  },
];

/** The table shows saved group/channel links without claiming an authorization preview. */
export function GroupTable({
  rows,
  emptyMessage,
  loading = false,
  loadingMore = false,
  hasMore = false,
  error,
  onRetry,
  onLoadMore,
}: GroupTableProps) {
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
      getRowId={(group) => group.id}
      emptyMessage={emptyMessage ?? '暂无访问组，创建访问组后将在这里显示。'}
      caption="访问组列表"
    />
  );
}
