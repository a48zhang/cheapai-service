import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { createGroupsApi } from '@cheapai/api-client/groups';
import type { GroupInput, GroupListQuery, GroupPatch, GroupStatus, GroupView } from '@cheapai/api-client/groups';
import type { ApiClient } from '@cheapai/api-client/types';

export interface AdminGroupsContext {
  readonly client: ApiClient;
  readonly actorId: string;
}

export type GroupListFilters = Omit<GroupListQuery, 'cursor'>;

export const adminGroupsQueryKeys = Object.freeze({
  root: (actorId: string) => ['admin-groups', actorId] as const,
  lists: (actorId: string) => [...adminGroupsQueryKeys.root(actorId), 'list'] as const,
  list: (actorId: string, filters: GroupListFilters = {}) => [...adminGroupsQueryKeys.lists(actorId), filters] as const,
  details: (actorId: string) => [...adminGroupsQueryKeys.root(actorId), 'detail'] as const,
  detail: (actorId: string, groupId: string) => [...adminGroupsQueryKeys.details(actorId), groupId] as const,
});

/** Cursor stays in query page state; the list key only tracks actor and status filters. */
export function groupListQueryOptions(context: AdminGroupsContext, filters: GroupListFilters = {}) {
  const api = createGroupsApi(context.client);
  return infiniteQueryOptions({
    queryKey: adminGroupsQueryKeys.list(context.actorId, filters),
    queryFn: ({ pageParam }) => api.list({ ...filters, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
}

/** Detail IDs are cache keys as received; the transport client encodes them as one segment. */
export function groupDetailQueryOptions(context: AdminGroupsContext, groupId: string) {
  const api = createGroupsApi(context.client);
  return queryOptions({
    queryKey: adminGroupsQueryKeys.detail(context.actorId, groupId),
    queryFn: () => api.get(groupId),
    enabled: groupId.length > 0,
  });
}

/** Group writes use the group version, independently of channel or user versions. */
export function createGroupCommands(context: AdminGroupsContext) {
  const api = createGroupsApi(context.client);
  return Object.freeze({
    create: (input: GroupInput) => api.create(input),
    update: (id: string, version: number, patch: GroupPatch) => api.update(id, version, patch),
  });
}

export function invalidateAdminGroups(queryClient: QueryClient, actorId: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: adminGroupsQueryKeys.root(actorId) });
}

export type { GroupInput, GroupListQuery, GroupPatch, GroupStatus, GroupView };
