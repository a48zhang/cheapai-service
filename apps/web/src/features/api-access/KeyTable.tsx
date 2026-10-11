import { KeyRound, MoreHorizontal, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ApiClientError } from '@cheapai/api-client/errors';
import type { KeysApi, KeyMetadata, KeyState } from '@cheapai/api-client/keys';
import { formatDateTime } from '../../shared/lib/datetime';
import { CursorTable } from '../../shared/patterns/CursorTable';
import { Button } from '../../shared/ui/Button';
import { DropdownMenu } from '../../shared/ui/DropdownMenu';
import { ConfirmAction } from '../../shared/ui/ConfirmAction';
import { StatusBadge } from '../../shared/ui/StatusBadge';
import { keyListQueryOptions } from './api';
import { mergePageItems } from '../../shared/lib/pagination';

export interface KeyTableProps {
  readonly api: KeysApi;
  readonly userId: string;
  readonly onEdit: (key: KeyMetadata) => void;
  readonly selectedKeyId: string | null;
  readonly onSelectKey: (key: KeyMetadata | null) => void;
  readonly onChanged: (key: KeyMetadata) => void;
}

const keyStates: readonly { value: KeyState; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '有效' },
  { value: 'expired', label: '已过期' },
  { value: 'revoked', label: '已撤销' },
];

function statusFor(key: KeyMetadata): { label: string; tone: 'success' | 'warning' | 'danger' } {
  if (key.status === 'revoked') return { label: '已撤销', tone: 'danger' };
  if (key.expiresAt !== null && key.expiresAt <= Date.now())
    return { label: '已过期', tone: 'warning' };
  return { label: '有效', tone: 'success' };
}

function canUseForExamples(key: KeyMetadata): boolean {
  return key.status === 'active' && (key.expiresAt === null || key.expiresAt > Date.now());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '暂时无法读取密钥列表。';
}

export function KeyTable({
  api,
  userId,
  onEdit,
  selectedKeyId,
  onSelectKey,
  onChanged,
}: KeyTableProps) {
  const [state, setState] = useState<KeyState>('all');
  const [confirmingKey, setConfirmingKey] = useState<KeyMetadata | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [operationMessage, setOperationMessage] = useState('');
  const [operationError, setOperationError] = useState('');
  const query = useInfiniteQuery({
    ...keyListQueryOptions(api, userId, state),
    enabled: userId !== 'anonymous',
  });
  const rows = useMemo(
    () =>
      mergePageItems(
        query.data?.pages,
        (candidate, current) => candidate.version - current.version,
      ),
    [query.data],
  );

  useEffect(() => {
    const usableKeys = rows.filter(canUseForExamples);
    if (selectedKeyId === null) {
      const firstUsableKey = usableKeys[0];
      if (firstUsableKey) onSelectKey(firstUsableKey);
      return;
    }
    const selectedRow = rows.find((key) => key.id === selectedKeyId);
    if (selectedRow) onSelectKey(canUseForExamples(selectedRow) ? selectedRow : null);
  }, [rows, selectedKeyId, onSelectKey]);

  const revoke = async (key: KeyMetadata) => {
    if (revokingId !== null) return;
    setRevokingId(key.id);
    setOperationMessage('');
    setOperationError('');
    try {
      const result = await api.revoke(key.id, key.version);
      onChanged(result.key);
      setOperationMessage(
        result.kind === 'already_revoked' ? '该密钥已撤销，无需重复操作。' : '密钥已撤销。',
      );
    } catch (error) {
      setOperationError(
        error instanceof ApiClientError && error.status === 409
          ? '密钥已发生变化。请刷新列表并核对状态后再操作。'
          : `撤销结果尚未确认。请刷新列表核对状态；不会自动重试。${error instanceof Error ? ` ${error.message}` : ''}`,
      );
      onChanged(key);
    } finally {
      setRevokingId(null);
    }
  };

  const columns: ColumnDef<KeyMetadata, unknown>[] = [
    {
      id: 'name',
      header: '名称',
      cell: ({ row }) => (
        <div className="flex min-w-40 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
            <KeyRound size={19} aria-hidden="true" />
          </span>
          <span className="font-medium text-[var(--color-foreground)]">{row.original.name}</span>
        </div>
      ),
    },
    {
      id: 'secret',
      header: '密钥摘要',
      cell: ({ row }) => (
        <code className="whitespace-nowrap text-sm text-[var(--color-muted-foreground)]">
          {row.original.displayPrefix}…
        </code>
      ),
    },
    {
      id: 'status',
      header: '状态',
      cell: ({ row }) => {
        const status = statusFor(row.original);
        return (
          <StatusBadge tone={status.tone} className="whitespace-nowrap">
            {status.label}
          </StatusBadge>
        );
      },
    },
    {
      accessorKey: 'expiresAt',
      header: '到期时间',
      cell: ({ row }) =>
        row.original.expiresAt === null ? '不过期' : formatDateTime(row.original.expiresAt),
    },
    { accessorKey: 'groupName', header: '授权分组' },
    {
      id: 'actions',
      header: '操作',
      cell: ({ row }) => (
        <div className="flex items-center gap-2 whitespace-nowrap">
          <Button
            variant="ghost"
            size="sm"
            disabled={!canUseForExamples(row.original) || selectedKeyId === row.original.id}
            onClick={() => onSelectKey(row.original)}
          >
            {selectedKeyId === row.original.id ? '已选用' : '用于接入'}
          </Button>
          {row.original.status !== 'revoked' && (
            <DropdownMenu
              trigger={
                <Button variant="ghost" size="sm" aria-label={`密钥操作：${row.original.name}`}>
                  <MoreHorizontal size={19} aria-hidden="true" />
                </Button>
              }
              items={[
                { label: '编辑', onSelect: () => onEdit(row.original) },
                {
                  label: '撤销',
                  destructive: true,
                  onSelect: () => setConfirmingKey(row.original),
                },
              ]}
            />
          )}
        </div>
      ),
    },
  ];

  return (
    <section
      aria-labelledby="key-table-title"
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 sm:p-6 space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 id="key-table-title" className="text-xl font-semibold">
          API 密钥
        </h2>
        <div className="flex items-center gap-2">
          <select
            aria-label="密钥状态"
            value={state}
            onChange={(event) => setState(event.currentTarget.value as KeyState)}
            className="min-h-10 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[15px]"
          >
            {keyStates.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            size="sm"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw size={16} aria-hidden="true" />
            刷新
          </Button>
        </div>
      </div>
      {operationMessage && (
        <p role="status" className="text-sm text-[var(--color-success)]">
          {operationMessage}
        </p>
      )}
      {operationError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--color-danger-line)] bg-[var(--color-danger-soft)] p-3 text-sm text-[var(--color-danger)]"
        >
          <span>{operationError}</span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setOperationError('');
              void query.refetch();
            }}
          >
            重新读取
          </Button>
        </div>
      )}
      {!rows.length && !query.isPending && !query.isError ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] p-5 text-sm text-[var(--color-muted-foreground)]">
          <p>还没有 API 密钥。创建密钥后即可接入。</p>
        </div>
      ) : (
        <CursorTable
          rows={rows}
          columns={columns}
          caption="个人 API 密钥列表"
          emptyMessage="暂无密钥"
          loading={query.isPending}
          error={query.isError ? errorMessage(query.error) : null}
          onRetry={() => {
            void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch());
          }}
          hasMore={query.hasNextPage}
          loadingMore={query.isFetchingNextPage}
          onLoadMore={() => {
            void query.fetchNextPage();
          }}
          getRowId={(key) => key.id}
        />
      )}
      {confirmingKey && (
        <ConfirmAction
          open={confirmingKey !== null}
          onOpenChange={(open) => {
            if (!open) setConfirmingKey(null);
          }}
          title="撤销密钥"
          description={`撤销“${confirmingKey.name}”后，使用该密钥的请求将无法继续。此操作不可恢复。`}
          confirmLabel="确认撤销"
          cancelLabel="暂不撤销"
          busy={revokingId === confirmingKey.id}
          onConfirm={() => {
            void revoke(confirmingKey);
          }}
        />
      )}
      <p className="text-sm leading-6 text-[var(--color-muted-foreground)]">
        完整密钥仅在创建时显示，列表中的摘要用于辨认。
      </p>
    </section>
  );
}
