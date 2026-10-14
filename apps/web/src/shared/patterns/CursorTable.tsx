import { useMemo } from 'react';
import { flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import type { ColumnDef, RowData } from '@tanstack/react-table';
import { AsyncState } from './AsyncState';
import { Button } from '../ui/Button';

declare module '@tanstack/react-table' {
  // The type parameters are required to match TanStack's merged interface.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    align?: 'left' | 'center' | 'right';
    numeric?: boolean;
    width?: number | string;
  }
}

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
  const displayColumns = useMemo(
    () =>
      columns.map((column) =>
        column.size === undefined
          ? column
          : {
              ...column,
              meta: { ...column.meta, width: column.meta?.width ?? column.size },
            },
      ),
    [columns],
  );
  const table = useReactTable({
    data,
    columns: displayColumns,
    getCoreRowModel: getCoreRowModel(),
    ...(getRowId ? { getRowId } : {}),
  });
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="overflow-x-auto">
        <table className="console-table w-full text-left text-sm leading-6">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-[var(--color-surface-subtle)] text-[var(--color-ink-secondary)]">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    scope="col"
                    className="whitespace-nowrap px-4 py-3 font-medium"
                    style={{
                      textAlign: header.column.columnDef.meta?.align,
                      width: header.column.columnDef.meta?.width,
                    }}
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
                className={`border-t border-[var(--color-border)] hover:bg-[var(--color-surface-subtle)] ${onRowClick ? 'cursor-pointer focus-visible:outline-offset-[-3px]' : ''}`}
                onClick={
                  onRowClick
                    ? (event) => {
                        if (
                          !event.defaultPrevented &&
                          !(event.target as Element).closest(
                            'a, button, input, select, textarea, [role="button"]',
                          )
                        ) {
                          onRowClick(row.original);
                        }
                      }
                    : undefined
                }
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={
                  onRowClick
                    ? (event) => {
                        if (
                          event.target === event.currentTarget &&
                          (event.key === 'Enter' || event.key === ' ')
                        ) {
                          event.preventDefault();
                          onRowClick(row.original);
                        }
                      }
                    : undefined
                }
              >
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    className={`px-4 py-3 align-middle ${cell.column.columnDef.meta?.numeric ? 'whitespace-nowrap tabular-nums' : ''}`}
                    style={{ textAlign: cell.column.columnDef.meta?.align }}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {loading && !rows.length ? (
          <AsyncState status="loading" loadingLabel="正在读取…" className="p-8 text-center" />
        ) : !rows.length && !error ? (
          <p className="p-8 text-center text-[var(--color-ink-secondary)]">{emptyMessage}</p>
        ) : null}
      </div>
      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-4 border-t border-[var(--color-border)] p-4"
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
