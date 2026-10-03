import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { createAdminUsersApi } from '@cheapai/api-client/users';
import type { UserGroup, UserListItem } from '@cheapai/api-client/users';
import type { ApiClient } from '@cheapai/api-client/types';

export type AdminUsersApi = ReturnType<typeof createAdminUsersApi>;
export type UserStatusFilter = 'all' | 'active' | 'disabled';
export interface UserListFilters {
  readonly status: UserStatusFilter;
  readonly groupId: string;
}

export const adminUsersQueryKeys = {
  root: (actorId: string, epoch: number) => ['admin', 'users', actorId, epoch] as const,
  lists: (actorId: string, epoch: number) => [...adminUsersQueryKeys.root(actorId, epoch), 'list'] as const,
  list: (actorId: string, epoch: number, filters: UserListFilters) =>
    [...adminUsersQueryKeys.lists(actorId, epoch), filters.status, filters.groupId] as const,
  details: (actorId: string, epoch: number) => [...adminUsersQueryKeys.root(actorId, epoch), 'detail'] as const,
  detail: (actorId: string, epoch: number, userId: string) =>
    [...adminUsersQueryKeys.details(actorId, epoch), userId] as const,
  groups: (actorId: string, epoch: number) => [...adminUsersQueryKeys.root(actorId, epoch), 'groups'] as const,
};

export function createAdminUsersFeatureApi(client: ApiClient): AdminUsersApi {
  return createAdminUsersApi(client);
}

export function userListQueryOptions(
  api: AdminUsersApi,
  actorId: string,
  epoch: number,
  filters: UserListFilters,
  enabled = true,
) {
  return infiniteQueryOptions({
    queryKey: adminUsersQueryKeys.list(actorId, epoch, filters),
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.list({
      cursor: pageParam,
      ...(filters.status === 'all' ? {} : { status: filters.status }),
      ...(filters.groupId ? { groupId: filters.groupId } : {}),
    }),
    getNextPageParam: (page, pages) => {
      if (page.nextCursor && pages.slice(0, -1).some(previous => previous.nextCursor === page.nextCursor)) {
        throw new Error('用户列表返回了重复游标。');
      }
      return page.nextCursor ?? undefined;
    },
  });
}

export function userDetailQueryOptions(api: AdminUsersApi, actorId: string, epoch: number, userId: string) {
  return queryOptions({
    queryKey: adminUsersQueryKeys.detail(actorId, epoch, userId),
    queryFn: () => api.get(userId),
    enabled: userId.length > 0,
  });
}

export function userGroupsQueryOptions(api: AdminUsersApi, actorId: string, epoch: number) {
  return infiniteQueryOptions({
    queryKey: adminUsersQueryKeys.groups(actorId, epoch),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.groups(pageParam),
    getNextPageParam: (page, pages) => {
      if (page.nextCursor && pages.slice(0, -1).some(previous => previous.nextCursor === page.nextCursor)) {
        throw new Error('分组列表返回了重复游标。');
      }
      return page.nextCursor ?? undefined;
    },
  });
}

export function flattenUserGroups(pages: readonly { readonly items: readonly UserGroup[] }[] | undefined): UserGroup[] {
  const unique = new Map<string, UserGroup>();
  for (const page of pages ?? []) for (const group of page.items) unique.set(group.id, group);
  return [...unique.values()];
}

export function invalidateAdminUsers(queryClient: QueryClient, actorId: string, epoch: number) {
  return queryClient.invalidateQueries({ queryKey: adminUsersQueryKeys.root(actorId, epoch) });
}

export function updateAdminUserCache(queryClient: QueryClient, actorId: string, epoch: number, user: UserListItem) {
  queryClient.setQueryData(adminUsersQueryKeys.detail(actorId, epoch, user.id), user);
  return invalidateAdminUsers(queryClient, actorId, epoch);
}
