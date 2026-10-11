import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { createAdminUsersFeatureApi, userListQueryOptions } from '../../features/admin-users/api';
import type { UserStatusFilter } from '../../features/admin-users/api';
import { invalidateAdminUsers } from '../../features/admin-users/api';
import { UserForm } from '../../features/admin-users/UserForm';
import { useSession } from '../../features/session/public';
import { UserTable } from '../../features/admin-users/UserTable';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { FilterBar } from '../../shared/patterns/FilterBar';
import { PageHeader } from '../../shared/patterns/PageHeader';
import { Field } from '../../shared/ui/Field';
import { groupCandidatesQueryOptions } from '../../features/admin-groups/api';
import { Select } from '../../shared/ui/Select';
import { Button } from '../../shared/ui/Button';
import { mergePageItems } from '../../shared/lib/pagination';

const statusItems = [
  { value: 'all', label: '全部状态' },
  { value: 'active', label: '启用' },
  { value: 'disabled', label: '停用' },
] as const;

function parseStatus(value: string | null): UserStatusFilter {
  return value === 'active' || value === 'disabled' ? value : 'all';
}

export default function UsersPage() {
  const { client, user, epoch, isAdmin } = useSession();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  const status = parseStatus(searchParams.get('status'));
  const groupId = searchParams.get('groupId')?.trim() ?? '';
  const actorId = user?.id ?? 'anonymous-admin';
  const api = useMemo(() => createAdminUsersFeatureApi(client), [client]);
  const users = useInfiniteQuery(
    userListQueryOptions(api, actorId, epoch, { status, groupId }, isAdmin),
  );
  const groups = useQuery(groupCandidatesQueryOptions({ client, actorId }, isAdmin));
  const rows = mergePageItems(
    users.data?.pages,
    (candidate, current) => candidate.version - current.version,
  );
  const groupItems = [
    { value: 'all', label: '全部访问组' },
    ...(groups.data ?? []).map((group) => ({ value: group.id, label: group.name })),
  ];
  if (groupId && !groupItems.some((item) => item.value === groupId)) {
    groupItems.push({
      value: groupId,
      label: rows.find((row) => row.group_id === groupId)?.group_name ?? '当前分组',
    });
  }
  const error = users.isError
    ? users.error instanceof Error
      ? users.error.message
      : '用户列表读取失败。'
    : null;

  function applyFilters(nextStatus: UserStatusFilter, nextGroupId: string) {
    const next = new URLSearchParams(searchParams);
    next.delete('cursor');
    if (nextStatus === 'all') next.delete('status');
    else next.set('status', nextStatus);
    if (nextGroupId) next.set('groupId', nextGroupId);
    else next.delete('groupId');
    setSearchParams(next, { replace: true });
  }

  return (
    <section className="space-y-4">
      <PageHeader
        heading="用户管理"
        actions={<Button onClick={() => setCreateOpen(true)}>创建普通用户</Button>}
      />
      <FilterBar
        onReset={() => {
          applyFilters('all', '');
        }}
      >
        <Field label="状态">
          <Select
            aria-label="按账户状态筛选"
            value={status}
            items={statusItems}
            onValueChange={(value) => {
              if (value === 'all' || value === 'active' || value === 'disabled')
                applyFilters(value, groupId);
            }}
          />
        </Field>
        <Field label="访问组" className="min-w-48">
          <Select
            aria-label="按访问组筛选"
            value={groupId || 'all'}
            items={groupItems}
            disabled={groups.isPending || groups.isError}
            onValueChange={(value) => applyFilters(status, value === 'all' ? '' : value)}
          />
        </Field>
      </FilterBar>
      {groups.isError && (
        <ApiErrorNotice
          error={groups.error}
          onRetry={() => {
            void groups.refetch();
          }}
        />
      )}
      {!isAdmin && <ApiErrorNotice error={new Error('此页面需要管理员权限。')} />}
      <UserTable
        rows={rows}
        loading={users.isPending && isAdmin}
        loadingMore={users.isFetchingNextPage}
        hasMore={users.hasNextPage}
        error={isAdmin ? error : null}
        onLoadMore={() => {
          void users.fetchNextPage();
        }}
        onRetry={() => {
          if (users.isFetchNextPageError) void users.fetchNextPage();
          else void users.refetch();
        }}
      />
      {createOpen && (
        <UserForm
          open
          mode="create"
          api={api}
          actorId={actorId}
          epoch={epoch}
          onOpenChange={(open) => {
            setCreateOpen(open);
            if (!open) void invalidateAdminUsers(queryClient, actorId, epoch);
          }}
          onSaved={() => {
            void invalidateAdminUsers(queryClient, actorId, epoch);
            setCreateOpen(false);
          }}
        />
      )}
    </section>
  );
}
