import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { createAccountApi } from '@cheapai/api-client/account';
import type { AccountApi } from '@cheapai/api-client/account';
import { createBillingApi } from '@cheapai/api-client/billing';
import type { BillingApi, BillingQuery } from '@cheapai/api-client/billing';
import type { ApiClient } from '@cheapai/api-client/types';
import { nextPageCursor } from '../../shared/lib/pagination';

export type BillingFilters = Pick<
  BillingQuery,
  'kind' | 'requestId' | 'createdFrom' | 'createdBefore'
>;

export const billingQueryKeys = Object.freeze({
  root: (userId: string) => ['billing', 'personal', userId] as const,
  list: (userId: string, filters: BillingFilters) =>
    [...billingQueryKeys.root(userId), 'list', filters] as const,
  balance: (userId: string) => [...billingQueryKeys.root(userId), 'balance'] as const,
});

export function createPersonalBillingApi(client: ApiClient): BillingApi {
  return createBillingApi(client, false);
}

export function createPersonalAccountApi(client: ApiClient): AccountApi {
  return createAccountApi(client);
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
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
}

export function personalBalanceQueryOptions(api: AccountApi, userId: string) {
  return queryOptions({
    queryKey: billingQueryKeys.balance(userId),
    queryFn: ({ signal }) => api.balance({ signal }),
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
}

/** Mark the signed-in user's balance and all date/filter pages stale after a known charge. */
export function invalidatePersonalBilling(queryClient: QueryClient, userId: string): Promise<void> {
  return queryClient
    .invalidateQueries({ queryKey: billingQueryKeys.root(userId) })
    .then(() => undefined);
}
