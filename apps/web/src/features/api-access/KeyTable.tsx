import { useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { ApiClientError } from '@cheapai/api-client/errors';
import type { KeysApi, KeyMetadata, KeyState } from '@cheapai/api-client/keys';
import { formatDateTime } from '../../shared/lib/datetime';
import { CursorTable } from '../../shared/patterns/CursorTable';
import { Button } from '../../shared/ui/Button';
import { ConfirmAction } from '../../shared/ui/ConfirmAction';
import { StatusBadge } from '../../shared/ui/StatusBadge';
import { useInfiniteQuery } from '@tanstack/react-query';
import { keyListQueryOptions } from './api';

export interface KeyTableProps {
  readonly api: KeysApi;
  readonly userId: string;
  readonly onCreate: () => void;
  readonly onEdit: (key: KeyMetadata) => void;
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
  if (key.expiresAt !== null && key.expiresAt <= Date.now()) return { label: '已过期', tone: 'warning' };
  return { label: '有效', tone: 'success' };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '暂时无法读取 Key 列表。';
}

export function KeyTable({ api, userId, onCreate, onEdit, onChanged }: KeyTableProps) {
  const [state, setState] = useState<KeyState>('all');
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [operationMessage, setOperationMessage] = useState('');
  const [operationError, setOperationError] = useState('');
  const query = useInfiniteQuery({ ...keyListQueryOptions(api, userId, state), enabled: userId !== 'anonymous' });
  const rows = query.data?.pages.flatMap(page => page.items) ?? [];

  const revoke = async (key: KeyMetadata) => {
    if (revokingId !== null) return;
    setRevokingId(key.id);
    setOperationMessage('');
    setOperationError('');
    try {
      const result = await api.revoke(key.id, key.version);
      onChanged(result.key);
      setOperationMessage(result.kind === 'already_revoked' ? '该 Key 已撤销，无需重复操作。' : 'Key 已撤销。');
    } catch (error) {
      setOperationError(error instanceof ApiClientError && error.status === 409
        ? 'Key 已发生变化。请刷新列表并核对状态后再操作。'
        : `撤销结果尚未确认。请刷新列表核对状态；不会自动重试。${error instanceof Error ? ` ${error.message}` : ''}`);
      onChanged(key);
    } finally {
      setRevokingId(null);
    }
  };

  const columns: ColumnDef<KeyMetadata, unknown>[] = [
    {
      id: 'name',
      header: '名称 / 掩码',
      cell: ({ row }) => <div className="min-w-40 space-y-1">
        <p className="font-medium text-[var(--color-foreground)]">{row.original.name}</p>
        <code className="break-all text-xs text-[var(--color-muted-foreground)]">{row.original.displayPrefix}…</code>
      </div>,
    },
    {
      id: 'status',
      header: '状态',
      cell: ({ row }) => {
        const status = statusFor(row.original);
        return <StatusBadge tone={status.tone}>{status.label}</StatusBadge>;
      },
    },
    {
      accessorKey: 'expiresAt',
      header: '到期时间',
      cell: ({ row }) => row.original.expiresAt === null ? '不过期' : formatDateTime(row.original.expiresAt),
    },
    { accessorKey: 'groupName', header: '授权分组' },
    {
      id: 'actions',
      header: '操作',
      cell: ({ row }) => <div className="flex min-w-48 flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => onEdit(row.original)}>
          {row.original.status === 'revoked' ? '查看' : '编辑 / 撤销'}
        </Button>
        {row.original.status !== 'revoked' && <ConfirmAction
          trigger={<Button variant="danger" size="sm">撤销 Key</Button>}
          title="撤销 API Key"
          description={`撤销“${row.original.name}”后，使用该 Key 的请求将无法继续。此操作不可恢复。`}
          confirmLabel="确认撤销"
          cancelLabel="暂不撤销"
          busy={revokingId === row.original.id}
          onConfirm={() => { void revoke(row.original); }}
        />}
      </div>,
    },
  ];

  return <section aria-labelledby="key-table-title" className="space-y-4">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><h2 id="key-table-title" className="text-lg font-semibold">个人 Key 列表</h2>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">密钥明文只在创建时提供；列表仅显示掩码。</p></div>
      <Button onClick={onCreate}><span aria-hidden="true">＋</span> 创建 Key</Button>
    </div>
    <div className="flex flex-wrap items-end gap-3">
      <label htmlFor="key-state-filter" className="grid gap-1.5 text-sm font-medium">状态
        <select id="key-state-filter" value={state} onChange={event => setState(event.currentTarget.value as KeyState)}
          className="min-h-10 min-w-36 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]">
          {keyStates.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>刷新</Button>
    </div>
    {operationMessage && <p role="status" className="text-sm text-emerald-800">{operationMessage}</p>}
    {operationError && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
      <span>{operationError}</span><Button variant="secondary" size="sm" onClick={() => { setOperationError(''); void query.refetch(); }}>重新读取</Button>
    </div>}
    {!rows.length && !query.isPending && !query.isError
      ? <div className="rounded-xl border border-dashed border-[var(--color-border)] p-5 text-sm text-[var(--color-muted-foreground)]">
        <p>暂无 Key。创建独立密钥，用于你的应用或客户端。</p>
        <Button variant="ghost" className="mt-2" onClick={onCreate}>创建第一个 Key <span aria-hidden="true">→</span></Button>
      </div>
      : <CursorTable
        rows={rows}
        columns={columns}
        caption="个人 API Key 列表"
        emptyMessage="暂无 Key"
        loading={query.isPending}
        error={query.isError ? errorMessage(query.error) : null}
        onRetry={() => { void query.refetch(); }}
        hasMore={query.hasNextPage}
        loadingMore={query.isFetchingNextPage}
        onLoadMore={() => { void query.fetchNextPage(); }}
        getRowId={key => key.id}
      />}
  </section>;
}
