import { Link, useLocation } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import type { RequestRecord } from '@cheapai/contracts/requests';
import { formatDateTime } from '../../shared/lib/datetime';
import { CursorTable } from '../../shared/patterns/CursorTable';
import { requestCostLabel, requestSourceLabel } from './presentation';
import { RequestStatus } from './RequestStatus';

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
  readonly emptyMessage?: string;
}

function usageText(item: RequestRecord): string {
  if (item.usage_valid !== true || item.usage === null)
    return item.usage_valid === false ? '用量数据无效' : '用量未知';
  if (item.usage.quality === 'missing') return '上游未提供用量';
  if (item.usage.quality === 'invalid') return '用量记录无效';
  const counts = item.usage.counts;
  const input = counts.inputTokens === undefined ? '—' : String(counts.inputTokens);
  const output = counts.outputTokens === undefined ? '—' : String(counts.outputTokens);
  return `输入 ${input} / 输出 ${output}${item.usage.quality === 'partial' ? '（部分）' : ''}`;
}

function detailHref(id: string, detailPath: string, listLocation: string): string {
  return `${detailPath}/${encodeURIComponent(id)}?${new URLSearchParams({ returnTo: listLocation })}`;
}

function createdColumn(): ColumnDef<RequestRecord, unknown> {
  return {
    id: 'created',
    header: '时间',
    size: 160,
    cell: ({ row }) => {
      const date = new Date(row.original.created_at);
      return (
        <time
          dateTime={Number.isFinite(date.getTime()) ? date.toISOString() : undefined}
          className="whitespace-nowrap text-sm text-[var(--color-ink-secondary)]"
        >
          {formatDateTime(row.original.created_at)}
        </time>
      );
    },
  };
}

function personalColumns(
  detailPath: string,
  listLocation: string,
): ColumnDef<RequestRecord, unknown>[] {
  return [
    createdColumn(),
    {
      id: 'model',
      header: '模型',
      cell: ({ row }) => (
        <Link
          className="block max-w-64 truncate font-medium text-[var(--color-accent)] hover:underline"
          aria-label={`查看 ${row.original.public_model_id} 使用详情`}
          to={detailHref(row.original.id, detailPath, listLocation)}
        >
          {row.original.public_model_id}
        </Link>
      ),
    },
    {
      id: 'source',
      header: '来源',
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-sm text-[var(--color-ink-secondary)]">
          {requestSourceLabel(row.original.source)}
        </span>
      ),
    },
    {
      id: 'result',
      header: '执行 / 计费',
      cell: ({ row }) => {
        return (
          <RequestStatus
            executionStatus={row.original.execution_status}
            billingStatus={row.original.billing_status}
          />
        );
      },
    },
    {
      id: 'usage',
      header: '用量',
      size: 165,
      cell: ({ row }) => (
        <span className="text-sm text-[var(--color-ink-secondary)]">{usageText(row.original)}</span>
      ),
    },
    {
      id: 'cost',
      header: '费用',
      size: 170,
      meta: { align: 'right', numeric: true },
      cell: ({ row }) => (
        <span className="whitespace-nowrap console-number text-[15px] text-[var(--color-ink)]">
          {requestCostLabel(row.original)}
        </span>
      ),
    },
  ];
}

function adminColumns(
  detailPath: string,
  listLocation: string,
): ColumnDef<RequestRecord, unknown>[] {
  return [
    {
      id: 'request',
      header: '模型 / 用户',
      size: 190,
      cell: ({ row }) => (
        <div className="min-w-40 max-w-64 space-y-1">
          <Link
            className="block truncate text-[15px] font-medium text-[var(--color-accent)] hover:underline"
            to={detailHref(row.original.id, detailPath, listLocation)}
          >
            {row.original.public_model_id}
          </Link>
          <Link
            className="block truncate text-sm text-[var(--color-ink-secondary)] hover:text-[var(--color-accent)]"
            title={row.original.user_email ?? row.original.user_id}
            to={`/admin/users/${encodeURIComponent(row.original.user_id)}`}
          >
            {row.original.user_email ?? row.original.user_id}
          </Link>
        </div>
      ),
    },
    {
      id: 'source',
      header: '来源 / 分组',
      size: 130,
      cell: ({ row }) => (
        <div className="min-w-28 space-y-1 text-sm">
          <span>{row.original.source === 'web_chat' ? '网页聊天' : 'API 请求'}</span>
          <p className="m-0 mt-1 max-w-40 truncate text-sm text-[var(--color-ink-muted)]">
            {row.original.group_name ?? row.original.group_id ?? '未记录分组'}
          </p>
        </div>
      ),
    },
    {
      id: 'status',
      header: '执行 / 计费',
      cell: ({ row }) => (
        <RequestStatus
          executionStatus={row.original.execution_status}
          billingStatus={row.original.billing_status}
        />
      ),
    },
    {
      id: 'usage',
      header: '用量',
      size: 160,
      cell: ({ row }) => (
        <span className="block max-w-64 text-sm leading-6 text-[var(--color-ink-secondary)]">
          {usageText(row.original)}
        </span>
      ),
    },
    {
      id: 'cost',
      header: '费用',
      size: 170,
      meta: { align: 'right', numeric: true },
      cell: ({ row }) => (
        <span className="whitespace-nowrap console-number text-[15px] text-[var(--color-ink)]">
          {requestCostLabel(row.original)}
        </span>
      ),
    },
    createdColumn(),
  ];
}

/** Personal list stays task-focused; admins keep the complete technical view. */
export function RequestTable({
  rows,
  scope = 'personal',
  returnTo,
  hasMore,
  loading,
  loadingMore,
  error,
  onLoadMore,
  onRetry,
  emptyMessage,
}: RequestTableProps) {
  const location = useLocation();
  const listLocation = returnTo ?? `${location.pathname}${location.search}`;
  const detailPath = scope === 'admin' ? '/admin/requests' : '/requests';
  const columns =
    scope === 'admin'
      ? adminColumns(detailPath, listLocation)
      : personalColumns(detailPath, listLocation);

  return (
    <CursorTable
      rows={rows}
      columns={columns}
      getRowId={(row) => row.id}
      hasMore={hasMore}
      loading={loading}
      loadingMore={loadingMore}
      error={error}
      onLoadMore={onLoadMore}
      onRetry={onRetry}
      emptyMessage={
        emptyMessage ?? (scope === 'admin' ? '当前筛选下没有请求记录。' : '还没有使用记录。')
      }
      caption={scope === 'admin' ? '全局请求列表' : '个人使用记录列表'}
    />
  );
}
