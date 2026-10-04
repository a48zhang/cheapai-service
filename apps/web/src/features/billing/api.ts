import { infiniteQueryOptions } from '@tanstack/react-query';
import { createBillingApi } from '@cheapai/api-client/billing';
import type { BillingApi, BillingQuery } from '@cheapai/api-client/billing';
import type { ApiClient } from '@cheapai/api-client/types';
import { nextPageCursor } from '../../shared/lib/pagination';

export type BillingFilters = Pick<BillingQuery, 'kind' | 'requestId'>;

export const billingQueryKeys = Object.freeze({
  root: (userId: string) => ['billing', 'personal', userId] as const,
  list: (userId: string, filters: BillingFilters) =>
    [...billingQueryKeys.root(userId), 'list', filters] as const,
});

export function createPersonalBillingApi(client: ApiClient): BillingApi {
  return createBillingApi(client, false);
}

/** Infinite cursor query; each page is bound to the same user and filter set. */
export function billingListQueryOptions(
  api: BillingApi,
  userId: string,
  filters: BillingFilters = {},
) {
  return infiniteQueryOptions({
    queryKey: billingQueryKeys.list(userId, filters),
    queryFn: ({ pageParam, signal }) => api.list({ ...filters, cursor: pageParam }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (page, pages) => nextPageCursor(page, pages, '账单列表'),
  });
}
