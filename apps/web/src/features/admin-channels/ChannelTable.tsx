import { useMemo } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Link } from 'react-router-dom';
import type { ChannelView } from '@cheapai/api-client/channels';
import { CursorTable } from '../../shared/patterns/CursorTable';
import { Button } from '../../shared/ui/Button';
import { StatusBadge } from '../../shared/ui/StatusBadge';

export interface ChannelTableProps {
  rows: readonly ChannelView[];
  hasMore?: boolean;
  loading?: boolean;
  loadingMore?: boolean;
  error?: string | null;
  onLoadMore?: () => void;
  onRetry?: () => void;
  onEdit?: (channel: ChannelView) => void;
  onDiagnose?: (channel: ChannelView) => void;
}

/** Resource inventory with server cursor controls and explicit edit/diagnostic entry points. */
export function ChannelTable({
  rows,
  hasMore,
  loading,
  loadingMore,
  error,
  onLoadMore,
  onRetry,
  onEdit,
  onDiagnose,
}: ChannelTableProps) {
  const columns = useMemo<ColumnDef<ChannelView, unknown>[]>(
    () => [
      {
        id: 'name',
        accessorKey: 'name',
        header: '渠道',
        cell: ({ row }) => (
          <div className="min-w-48">
            <p className="font-medium text-[var(--color-ink)]">{row.original.name}</p>
            <code className="mt-1 block break-all text-xs text-[var(--color-ink-muted)]">
              {row.original.baseUrl}
            </code>
          </div>
        ),
      },
      {
        id: 'models',
        accessorKey: 'models',
        header: '模型映射',
        cell: ({ row }) => {
          const models = row.original.models;
          if (!models.length)
            return <span className="text-sm text-[var(--color-ink-muted)]">尚未配置模型</span>;
          return (
            <div className="max-w-md space-y-1">
              <p className="text-sm">{models.length} 个映射</p>
              <p className="break-all text-xs text-[var(--color-ink-muted)]">
                {models
                  .slice(0, 3)
                  .map((model) => model.publicModelId)
                  .join('、')}
                {models.length > 3 ? '…' : ''}
              </p>
            </div>
          );
        },
      },
      {
        id: 'status',
        accessorKey: 'status',
        header: '状态',
        cell: ({ row }) =>
          row.original.status === 'active' ? (
            <StatusBadge tone="success">启用</StatusBadge>
          ) : (
            <StatusBadge tone="neutral">停用</StatusBadge>
          ),
      },
      {
        id: 'limits',
        header: '限额 / 优先级',
        cell: ({ row }) => {
          const { concurrencyLimit, rpmLimit, priority } = row.original;
          const unlimited = Number.MAX_SAFE_INTEGER;
          return (
            <div className="space-y-1 whitespace-nowrap text-xs text-[var(--color-ink-secondary)]">
              <p>并发 {concurrencyLimit === unlimited ? '不限' : concurrencyLimit}</p>
              <p>RPM {rpmLimit === unlimited ? '不限' : rpmLimit}</p>
              <p>优先级 {priority}</p>
            </div>
          );
        },
      },
      {
        id: 'hasCredential',
        accessorKey: 'hasCredential',
        header: '上游凭证',
        cell: ({ row }) =>
          row.original.hasCredential ? (
            <span className="text-sm text-[var(--color-ink-secondary)]">已配置</span>
          ) : (
            <StatusBadge tone="warning">未配置</StatusBadge>
          ),
      },
      {
        id: 'actions',
        header: '操作',
        cell: ({ row }) => {
          const channel = row.original;
          return (
            <div className="flex min-w-48 flex-wrap items-center gap-1">
              <Button asChild variant="ghost" size="sm">
                <Link to={`/admin/channels/${encodeURIComponent(channel.id)}`}>查看</Link>
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onEdit?.(channel)}>
                编辑
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={channel.status !== 'active' || channel.models.length === 0}
                onClick={() => onDiagnose?.(channel)}
              >
                诊断
              </Button>
            </div>
          );
        },
      },
    ],
    [onDiagnose, onEdit],
  );

  return (
    <CursorTable
      rows={rows}
      columns={columns}
      hasMore={hasMore}
      loading={loading}
      loadingMore={loadingMore}
      error={error}
      onLoadMore={onLoadMore}
      onRetry={onRetry}
      getRowId={(channel) => channel.id}
      caption="渠道列表"
      emptyMessage="还没有渠道。创建渠道后可配置模型映射。"
    />
  );
}
