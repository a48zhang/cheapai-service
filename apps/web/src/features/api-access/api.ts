import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { createKeysApi } from '@cheapai/api-client/keys';
import type { KeysApi, KeyState } from '@cheapai/api-client/keys';
import type { ApiClient } from '@cheapai/api-client/types';
import { nextPageCursor } from '../../shared/lib/pagination';

export const apiAccessKeysQueryKeys = {
  all: (userId: string) => ['api-access', 'keys', userId] as const,
  groups: (userId: string) => [...apiAccessKeysQueryKeys.all(userId), 'groups'] as const,
  lists: (userId: string) => [...apiAccessKeysQueryKeys.all(userId), 'list'] as const,
  list: (userId: string, state: KeyState) =>
    [...apiAccessKeysQueryKeys.lists(userId), state] as const,
};

/** All Key data is scoped to its owner so one user's records cannot render for another. */
export function createApiAccessApi(client: ApiClient): KeysApi {
  return createKeysApi(client);
}

export function keyGroupsQueryOptions(api: KeysApi, userId: string) {
  return queryOptions({
    queryKey: apiAccessKeysQueryKeys.groups(userId),
    queryFn: ({ signal }) => api.groups({ signal }),
  });
}

export function keyListQueryOptions(api: KeysApi, userId: string, state: KeyState) {
  return infiniteQueryOptions({
    queryKey: apiAccessKeysQueryKeys.list(userId, state),
    queryFn: ({ pageParam, signal }) => api.list({ cursor: pageParam, state }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (page, pages) => nextPageCursor(page, pages, '密钥列表'),
  });
}

export function invalidateApiAccessKeys(queryClient: QueryClient, userId: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: apiAccessKeysQueryKeys.all(userId) });
}
