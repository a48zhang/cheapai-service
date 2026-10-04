import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { createGroupsApi } from '@cheapai/api-client/groups';
import type {
  GroupInput,
  GroupListQuery,
  GroupPatch,
  GroupStatus,
  GroupView,
} from '@cheapai/api-client/groups';
import type { ApiClient } from '@cheapai/api-client/types';
import { nextPageCursor } from '../../shared/lib/pagination';

export interface AdminGroupsContext {
  readonly client: ApiClient;
  readonly actorId: string;
}

export type GroupListFilters = Omit<GroupListQuery, 'cursor'>;

export const adminGroupsQueryKeys = Object.freeze({
  root: (actorId: string) => ['admin-groups', actorId] as const,
  lists: (actorId: string) => [...adminGroupsQueryKeys.root(actorId), 'list'] as const,
  list: (actorId: string, filters: GroupListFilters = {}) =>
    [...adminGroupsQueryKeys.lists(actorId), filters] as const,
  details: (actorId: string) => [...adminGroupsQueryKeys.root(actorId), 'detail'] as const,
  detail: (actorId: string, groupId: string) =>
    [...adminGroupsQueryKeys.details(actorId), groupId] as const,
  candidates: (actorId: string) => [...adminGroupsQueryKeys.root(actorId), 'candidates'] as const,
});

/** Cursor stays in query page state; the list key only tracks actor and status filters. */
export function groupListQueryOptions(context: AdminGroupsContext, filters: GroupListFilters = {}) {
  const api = createGroupsApi(context.client);
  return infiniteQueryOptions({
    queryKey: adminGroupsQueryKeys.list(context.actorId, filters),
    queryFn: ({ pageParam, signal }) => api.list({ ...filters, cursor: pageParam }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (page, pages) => nextPageCursor(page, pages, '分组列表'),
  });
}

/** Detail IDs are cache keys as received; the transport client encodes them as one segment. */
export function groupDetailQueryOptions(context: AdminGroupsContext, groupId: string) {
  const api = createGroupsApi(context.client);
  return queryOptions({
    queryKey: adminGroupsQueryKeys.detail(context.actorId, groupId),
    queryFn: ({ signal }) => api.get(groupId, { signal }),
    enabled: groupId.length > 0,
  });
}

export function groupCandidatesQueryOptions(context: AdminGroupsContext, enabled = true) {
  const api = createGroupsApi(context.client);
  return queryOptions({
    queryKey: adminGroupsQueryKeys.candidates(context.actorId),
    enabled,
    queryFn: ({ signal }) => api.listAll({}, { signal }),
  });
}

/** One owner updates detail and refreshes both list and setup candidate views. */
export function recordGroupSaved(
  queryClient: QueryClient,
  actorId: string,
  group: GroupView,
): Promise<void> {
  const detailKey = adminGroupsQueryKeys.detail(actorId, group.id);
  void queryClient.cancelQueries({ queryKey: detailKey, exact: true });
  queryClient.setQueryData<GroupView>(detailKey, (current) =>
    current && current.version > group.version ? current : group,
  );
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: adminGroupsQueryKeys.lists(actorId) }),
    queryClient.invalidateQueries({ queryKey: adminGroupsQueryKeys.candidates(actorId) }),
  ]).then(() => undefined);
}

export type { GroupInput, GroupListQuery, GroupPatch, GroupStatus, GroupView };
