import { ModelIdentity } from '../../shared/ui/ModelIdentity';
import { useMemo } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Link } from 'react-router-dom';
import type { ChannelView } from '@cheapai/api-client/channels';
import { CursorTable } from '../../shared/patterns/CursorTable';
import { Button } from '../../shared/ui/Button';
import { StatusBadge } from '../../shared/ui/StatusBadge';

export interface ChannelTableProps {
  emptyMessage?: string;
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
  emptyMessage,
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
          <div className="min-w-40 max-w-64">
            <Link
              to={`/admin/channels/${encodeURIComponent(row.original.id)}`}
              className="block truncate font-medium text-[var(--color-primary)] hover:underline underline-offset-4"
              title={row.original.name}
            >
              {row.original.name}
            </Link>
            <code className="mt-1 block truncate console-muted" title={row.original.baseUrl}>
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
          if (!models.length) return <span className="console-muted">尚未配置模型</span>;
          return (
            <div className="min-w-32 max-w-48 space-y-1">
              <p className="text-sm">{models.length} 个映射</p>
              {models.slice(0, 3).map((model) => (
                <ModelIdentity
                  key={`${model.publicModelId}:${model.protocol}`}
                  modelId={model.publicModelId}
                  className="model-identity-compact text-sm"
                />
              ))}
              {models.length > 3 && <span className="console-muted">…</span>}
            </div>
          );
        },
      },
      {
        id: 'status',
        accessorKey: 'status',
        header: '状态',
        cell: ({ row }) => (
          <div className="space-y-1">
            <StatusBadge tone={row.original.status === 'active' ? 'success' : 'neutral'}>
              {row.original.status === 'active' ? '启用' : '停用'}
            </StatusBadge>
            {!row.original.hasCredential && (
              <p className="whitespace-nowrap text-sm text-[var(--color-warning)]">未配置凭证</p>
            )}
          </div>
        ),
      },
      {
        id: 'limits',
        header: '调度',
        cell: ({ row }) => {
          const { concurrencyLimit, rpmLimit, priority } = row.original;
          const unlimited = Number.MAX_SAFE_INTEGER;
          return (
            <div className="space-y-1 whitespace-nowrap text-sm text-[var(--color-ink-secondary)]">
              <p>
                并发 {concurrencyLimit === unlimited ? '不限' : concurrencyLimit} · RPM{' '}
                {rpmLimit === unlimited ? '不限' : rpmLimit}
              </p>
              <p className="console-muted">优先级 {priority}</p>
            </div>
          );
        },
      },
      {
        id: 'actions',
        header: '操作',
        cell: ({ row }) => {
          const channel = row.original;
          return (
            <div className="flex items-center gap-1 whitespace-nowrap">
              <Button variant="outline" size="sm" onClick={() => onEdit?.(channel)}>
                管理渠道
              </Button>
              <Button variant="outline" size="sm" onClick={() => onDiagnose?.(channel)}>
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
      emptyMessage={emptyMessage ?? '暂无渠道，创建渠道后将在这里显示。'}
    />
  );
}
