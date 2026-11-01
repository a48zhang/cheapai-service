import { queryOptions } from '@tanstack/react-query';
import { createCatalogApi } from '@cheapai/api-client/catalog';
import type { ApiClient } from '@cheapai/api-client/types';

export const catalogQueryKey = ['public-catalog'] as const;
export function catalogGroupsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: [...catalogQueryKey, 'groups'],
    queryFn: ({ signal }) => createCatalogApi(client).groups({ signal }),
    retry: false,
    staleTime: 60_000,
  });
}
export function catalogModelsQuery(client: ApiClient, groupId: string) {
  return queryOptions({
    queryKey: [...catalogQueryKey, 'models', groupId],
    queryFn: ({ signal }) => createCatalogApi(client).list(groupId, { signal }),
    enabled: groupId.length > 0,
    retry: false,
    staleTime: 60_000,
  });
}
