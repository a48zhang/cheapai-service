import { useMemo } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Link } from 'react-router-dom';
import type { UserListItem } from '@cheapai/api-client/users';
import { formatUnitsToUsd } from '../../shared/lib/money';
import { formatDateTime } from '../../shared/lib/datetime';
import { CursorTable } from '../../shared/patterns/CursorTable';
import { Button } from '../../shared/ui/Button';
import { StatusBadge } from '../../shared/ui/StatusBadge';

export interface UserTableProps {
  readonly rows: readonly UserListItem[];
  readonly hasMore?: boolean;
  readonly loading?: boolean;
  readonly loadingMore?: boolean;
  readonly error?: string | null;
  readonly onLoadMore?: () => void;
  readonly onRetry?: () => void;
}

/** Administrative user inventory showing only fields returned by the safe user projection. */
export function UserTable({ rows, hasMore, loading, loadingMore, error, onLoadMore, onRetry }: UserTableProps) {
  const columns = useMemo<ColumnDef<UserListItem, unknown>[]>(() => [
    {
      id: 'email_normalized',
      accessorKey: 'email_normalized',
      header: '账户',
      cell: ({ row }) => <div className="min-w-44">
        <p className="font-medium text-slate-900">{row.original.email_normalized}</p>
        <p className="mt-1 text-xs text-slate-500">{row.original.role === 'admin' ? '管理员' : '普通用户'}</p>
      </div>,
    },
    {
      id: 'status-group',
      header: '状态与分组',
      cell: ({ row }) => {
        const user = row.original;
        return <div className="space-y-1.5">
          {user.status === 'active'
            ? <StatusBadge tone="success">启用</StatusBadge>
            : <StatusBadge tone="neutral">停用</StatusBadge>}
          <p className="text-xs text-slate-600">{user.group_name}</p>
        </div>;
      },
    },
    {
      id: 'balance_units',
      accessorKey: 'balance_units',
      header: '余额（USD）',
      cell: ({ row }) => <span className="whitespace-nowrap font-mono tabular-nums">{formatUnitsToUsd(row.original.balance_units)}</span>,
    },
    {
      id: 'limits',
      header: '访问限额',
      cell: ({ row }) => {
        const user = row.original;
        return <div className="space-y-1 whitespace-nowrap text-xs text-slate-600">
          <p>并发 {user.concurrency_limit === Number.MAX_SAFE_INTEGER ? '不限' : user.concurrency_limit}</p>
          <p>每分钟请求 {user.rpm_limit === Number.MAX_SAFE_INTEGER ? '不限' : user.rpm_limit}</p>
        </div>;
      },
    },
    {
      id: 'created_at',
      accessorKey: 'created_at',
      header: '创建时间',
      cell: ({ row }) => <span className="whitespace-nowrap text-xs text-slate-600">{formatDateTime(row.original.created_at)}</span>,
    },
    {
      id: 'details',
      header: '操作',
      cell: ({ row }) => <Button asChild variant="ghost" size="sm">
        <Link to={`/admin/users/${encodeURIComponent(row.original.id)}`}>查看详情</Link>
      </Button>,
    },
  ], []);

  return <CursorTable
    rows={rows}
    columns={columns}
    {...(hasMore !== undefined ? { hasMore } : {})}
    {...(loading !== undefined ? { loading } : {})}
    {...(loadingMore !== undefined ? { loadingMore } : {})}
    {...(error !== undefined ? { error } : {})}
    {...(onLoadMore !== undefined ? { onLoadMore } : {})}
    {...(onRetry !== undefined ? { onRetry } : {})}
    getRowId={user => user.id}
    caption="用户列表"
    emptyMessage="没有符合条件的用户。"
  />;
}
