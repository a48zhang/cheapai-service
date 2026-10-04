import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
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
import { Input } from '../../shared/ui/Input';
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
  const [groupDraft, setGroupDraft] = useState(searchParams.get('groupId') ?? '');
  const [createOpen, setCreateOpen] = useState(false);
  const status = parseStatus(searchParams.get('status'));
  const groupId = searchParams.get('groupId')?.trim() ?? '';
  const actorId = user?.id ?? 'anonymous-admin';
  const api = useMemo(() => createAdminUsersFeatureApi(client), [client]);
  const users = useInfiniteQuery(
    userListQueryOptions(api, actorId, epoch, { status, groupId }, isAdmin),
  );
  const rows = mergePageItems(
    users.data?.pages,
    (candidate, current) => candidate.version - current.version,
  );
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
        eyebrow="用户与授权"
        heading="用户管理"
        description="按服务端支持的状态和分组筛选用户；余额与访问设置以服务端安全投影为准。"
        actions={<Button onClick={() => setCreateOpen(true)}>创建普通用户</Button>}
      />
      <FilterBar
        onReset={() => {
          setGroupDraft('');
          applyFilters('all', '');
        }}
      >
        <Field label="账户状态">
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
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            applyFilters(status, groupDraft.trim());
          }}
        >
          <Field label="分组 ID" description="精确匹配服务端分组 ID。">
            <Input
              value={groupDraft}
              onChange={(event) => setGroupDraft(event.currentTarget.value)}
              maxLength={128}
              autoComplete="off"
            />
          </Field>
          <Button type="submit" variant="secondary">
            应用
          </Button>
        </form>
      </FilterBar>
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
