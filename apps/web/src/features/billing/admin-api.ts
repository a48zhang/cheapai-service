import { infiniteQueryOptions } from '@tanstack/react-query';
import { createAdminBillingApi } from '@cheapai/api-client/billing';
import type { AdminBillingQuery } from '@cheapai/api-client/billing';
import type { ApiClient } from '@cheapai/api-client/types';
import { nextPageCursor } from '../../shared/lib/pagination';

export type AdminBillingFilters = Omit<AdminBillingQuery, 'cursor'>;

export const adminBillingQueryKeys = Object.freeze({
  root: (actorId: string) => ['billing', actorId, 'admin'] as const,
  list: (actorId: string, filters: AdminBillingFilters) =>
    [...adminBillingQueryKeys.root(actorId), filters] as const,
});

export function adminBillingListQueryOptions(
  client: ApiClient,
  actorId: string,
  filters: AdminBillingFilters = {},
) {
  const api = createAdminBillingApi(client);
  return infiniteQueryOptions({
    queryKey: adminBillingQueryKeys.list(actorId, filters),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api.list({ ...filters, cursor: pageParam }, { signal }),
    getNextPageParam: (last, pages) => nextPageCursor(last, pages, '账单分页'),
  });
}
