import { Link, useLocation } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import type { RequestRecord } from '@cheapai/contracts/requests';
import { formatDateTime } from '../../shared/lib/datetime';
import { CursorTable } from '../../shared/patterns/CursorTable';
import { StatusBadge } from '../../shared/ui/StatusBadge';
import { requestCostLabel, requestResultPresentation, requestSourceLabel } from './presentation';
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
  return `${item.usage.quality === 'complete' ? '完整' : '部分'} · 输入 ${input} / 输出 ${output}`;
}

function detailHref(id: string, detailPath: string, listLocation: string): string {
  return `${detailPath}/${encodeURIComponent(id)}?${new URLSearchParams({ returnTo: listLocation })}`;
}

function createdColumn(): ColumnDef<RequestRecord, unknown> {
  return {
    id: 'created',
    header: '时间',
    cell: ({ row }) => {
      const date = new Date(row.original.created_at);
      return (
        <time
          dateTime={Number.isFinite(date.getTime()) ? date.toISOString() : undefined}
          className="whitespace-nowrap text-xs text-[var(--color-ink-secondary)]"
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
          className="break-all font-medium text-[var(--color-accent)] hover:text-[var(--color-accent)]"
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
      header: '结果',
      cell: ({ row }) => {
        const result = requestResultPresentation(row.original.execution_status);
        return <StatusBadge tone={result.tone}>{result.label}</StatusBadge>;
      },
    },
    {
      id: 'cost',
      header: '费用',
      cell: ({ row }) => (
        <span className="whitespace-nowrap font-mono text-sm tabular-nums text-[var(--color-ink)]">
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
      header: '请求 / 用户',
      cell: ({ row }) => (
        <div className="min-w-48 space-y-1">
          <Link
            className="font-mono text-xs font-medium text-[var(--color-accent)] hover:text-[var(--color-accent)]"
            to={detailHref(row.original.id, detailPath, listLocation)}
          >
            {row.original.id}
          </Link>
          <p className="m-0 break-all font-medium text-[var(--color-ink)]">
            {row.original.public_model_id}
          </p>
          <p className="m-0 break-all text-xs text-[var(--color-ink-muted)]">
            {row.original.user_id}
          </p>
          <p className="m-0 text-xs text-[var(--color-ink-muted)]">
            {row.original.downstream_protocol} → {row.original.upstream_protocol} ·{' '}
            {row.original.upstream_model}
          </p>
        </div>
      ),
    },
    {
      id: 'source',
      header: '来源 / 分组',
      cell: ({ row }) => (
        <div className="min-w-28 text-sm">
          <span>{row.original.source === 'web_chat' ? '网页聊天' : 'API 请求'}</span>
          <p className="m-0 mt-1 break-all text-xs text-[var(--color-ink-muted)]">
            分组：{row.original.group_id ?? '未知'}
          </p>
          <Link
            className="mt-1 inline-block text-xs text-[var(--color-accent)] hover:underline"
            to={`/admin/billing?${new URLSearchParams({ userId: row.original.user_id, requestId: row.original.id })}`}
          >
            查看相关账单
          </Link>
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
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-xs text-[var(--color-ink-secondary)]">
          {usageText(row.original)}
        </span>
      ),
    },
    {
      id: 'cost',
      header: '费用',
      cell: ({ row }) => (
        <span className="whitespace-nowrap font-mono text-sm tabular-nums text-[var(--color-ink)]">
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
