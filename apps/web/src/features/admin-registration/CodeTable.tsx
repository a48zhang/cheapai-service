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
}: {
  rows: CodeListItem[];
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore: () => void;
  onRevoke: (id: string) => void;
}) {
  return (
    <CursorTable
      rows={rows}
      getRowId={(row) => row.id}
      hasMore={hasMore}
      loadingMore={loadingMore}
      onLoadMore={onLoadMore}
      emptyMessage="暂无邀请码"
      columns={[
        {
          header: '邀请码',
          accessorKey: 'displayPrefix',
          cell: (context) => <code>{context.row.original.displayPrefix}…</code>,
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
          cell: (context) => formatDateTime(context.row.original.createdAt),
        },
        {
          header: '有效期',
          accessorKey: 'expiresAt',
          cell: (context) => formatDateTime(context.row.original.expiresAt),
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
                  <Button variant="ghost" size="sm">
                    撤销
                  </Button>
                }
                onConfirm={() => onRevoke(context.row.original.id)}
              />
            ) : null,
        },
      ]}
    />
  );
}
