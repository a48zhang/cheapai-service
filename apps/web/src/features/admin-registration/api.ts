import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { createAdminRegistrationApi } from '@cheapai/api-client/registration-admin';
import type { ApiClient } from '@cheapai/api-client/types';
export const registrationKeys = { root: (userId: string) => ['admin-registration', userId, 'admin'] as const };
export function registrationSettingsQuery(client: ApiClient, userId: string) {
  return queryOptions({ queryKey: [...registrationKeys.root(userId), 'settings'], queryFn: () => createAdminRegistrationApi(client).settings() });
}
export function registrationCodesQuery(client: ApiClient, userId: string, creatorFilter?: string) {
  return infiniteQueryOptions({ queryKey: [...registrationKeys.root(userId), 'codes', creatorFilter], initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => createAdminRegistrationApi(client).codes({ cursor: pageParam, ...(creatorFilter === undefined ? {} : { creatorFilter }) }),
    getNextPageParam: (last, pages) => {
      if (last.nextCursor && pages.slice(0, -1).some(page => page.nextCursor === last.nextCursor)) throw new Error('邀请码分页返回重复游标。');
      return last.nextCursor ?? undefined;
    },
  });
}
