import { useMemo } from 'react';
import { flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import type { ColumnDef } from '@tanstack/react-table';
import { Button } from '../ui/Button';

export interface CursorTableProps<T> {
  rows: readonly T[];
  columns: ColumnDef<T, unknown>[];
  hasMore?: boolean | undefined;
  loading?: boolean | undefined;
  loadingMore?: boolean | undefined;
  error?: string | null | undefined;
  onLoadMore?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
  getRowId?: ((row: T) => string) | undefined;
  onRowClick?: ((row: T) => void) | undefined;
  emptyMessage?: string | undefined;
  caption?: string | undefined;
}

/** Display only: pagination is controlled by the feature's server cursor. */
export function CursorTable<T>({
  rows,
  columns,
  hasMore,
  loading,
  loadingMore,
  error,
  onLoadMore,
  onRetry,
  getRowId,
  onRowClick,
  emptyMessage = '暂无记录',
  caption = '记录列表',
}: CursorTableProps<T>) {
  const data = useMemo(() => [...rows], [rows]);
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    ...(getRowId ? { getRowId } : {}),
  });
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-[var(--color-surface-subtle)] text-[var(--color-muted-foreground)]">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    scope="col"
                    className="whitespace-nowrap px-5 py-3 font-medium"
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className={`border-t border-[var(--color-border)] hover:bg-[var(--color-surface-subtle)] ${onRowClick ? 'cursor-pointer' : ''}`}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-5 py-3.5">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {loading && !rows.length ? (
          <p role="status" className="p-8 text-center text-[var(--color-muted-foreground)]">
            正在读取…
          </p>
        ) : !rows.length && !error ? (
          <p className="p-8 text-center text-[var(--color-muted-foreground)]">{emptyMessage}</p>
        ) : null}
      </div>
      {error ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-4 border-t border-[var(--color-border)] p-4"
        >
          <span className="text-[var(--color-destructive)]">{error}</span>
          {onRetry && (
            <Button variant="secondary" onClick={onRetry}>
              重试
            </Button>
          )}
        </div>
      ) : null}
      {hasMore && (
        <div className="border-t border-[var(--color-border)] p-4 text-center">
          <Button
            variant="secondary"
            {...(loadingMore === undefined ? {} : { busy: loadingMore })}
            {...(onLoadMore ? { onClick: onLoadMore } : {})}
          >
            加载更多
          </Button>
        </div>
      )}
    </div>
  );
}
