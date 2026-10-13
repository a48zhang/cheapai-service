import { Link } from 'react-router-dom';
import type { CodeListItem } from '@cheapai/contracts/registration-admin';
import { CursorTable } from '../../shared/patterns/CursorTable';
import { ConfirmAction } from '../../shared/ui/ConfirmAction';
import { Button } from '../../shared/ui/Button';
import { StatusBadge } from '../../shared/ui/StatusBadge';
import { formatDateTime } from '../../shared/lib/datetime';
export function CodeTable({
  rows,
  hasMore,
  loadingMore,
  onLoadMore,
  onRevoke,
  filtered = false,
  onCreate,
}: {
  rows: CodeListItem[];
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore: () => void;
  onRevoke: (id: string) => Promise<void>;
  filtered?: boolean;
  onCreate?: () => void;
}) {
  return (
    <div className="space-y-4">
      <CursorTable
        rows={rows}
        getRowId={(row) => row.id}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={onLoadMore}
        emptyMessage={filtered ? '没有符合筛选条件的邀请码' : '暂无邀请码，生成后即可邀请用户注册'}
        columns={[
          {
            header: '邀请码',
            accessorKey: 'displayPrefix',
            cell: (context) => (
              <code className="text-[15px] font-medium">{context.row.original.displayPrefix}…</code>
            ),
          },
          {
            header: '状态',
            accessorKey: 'status',
            cell: (context) => (
              <StatusBadge tone={context.row.original.status === 'unused' ? 'success' : 'neutral'}>
                {
                  { unused: '未使用', used: '已使用', expired: '已过期', revoked: '已撤销' }[
                    context.row.original.status
                  ]
                }
              </StatusBadge>
            ),
          },
          {
            header: '创建时间',
            accessorKey: 'createdAt',
            cell: (context) => (
              <span className="whitespace-nowrap text-sm">
                {formatDateTime(context.row.original.createdAt)}
              </span>
            ),
          },
          {
            header: '到期时间',
            accessorKey: 'expiresAt',
            cell: (context) => (
              <span className="whitespace-nowrap text-sm">
                {formatDateTime(context.row.original.expiresAt)}
              </span>
            ),
          },
          {
            header: '使用情况',
            id: 'usage',
            cell: ({ row }) =>
              row.original.usedAt !== null || row.original.usedBy ? (
                <div className="space-y-1">
                  {row.original.usedBy ? (
                    <Link
                      className="block max-w-52 truncate text-[var(--color-accent)]"
                      title={row.original.usedByEmail ?? row.original.usedBy}
                      to={`/admin/users/${encodeURIComponent(row.original.usedBy)}`}
                    >
                      {row.original.usedByEmail ?? '查看使用者'}
                    </Link>
                  ) : (
                    <span className="text-[var(--color-ink-secondary)]">使用者已删除</span>
                  )}
                  <span className="whitespace-nowrap text-sm text-[var(--color-ink-secondary)]">
                    {formatDateTime(row.original.usedAt)}
                  </span>
                </div>
              ) : (
                <span className="text-[var(--color-ink-secondary)]">—</span>
              ),
          },
          {
            header: '操作',
            id: 'actions',
            cell: (context) =>
              context.row.original.status === 'unused' ? (
                <ConfirmAction
                  title="撤销邀请码"
                  description="撤销后此邀请码无法用于注册。"
                  confirmLabel="确认撤销"
                  cancelLabel="取消"
                  trigger={
                    <Button variant="outline" size="sm">
                      撤销
                    </Button>
                  }
                  onConfirm={() => onRevoke(context.row.original.id)}
                />
              ) : null,
          },
        ]}
      />
      {!rows.length && !filtered && onCreate && (
        <div className="text-center">
          <Button variant="secondary" onClick={onCreate}>
            生成邀请码
          </Button>
        </div>
      )}
    </div>
  );
}
