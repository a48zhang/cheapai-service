import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { createAdminRegistrationApi } from '@cheapai/api-client/registration-admin';
import type { ApiClient } from '@cheapai/api-client/types';
import { nextPageCursor } from '../../shared/lib/pagination';

export const registrationKeys = {
  root: (userId: string) => ['admin-registration', userId, 'admin'] as const,
};

export function registrationSettingsQuery(client: ApiClient, userId: string) {
  return queryOptions({
    queryKey: [...registrationKeys.root(userId), 'settings'],
    queryFn: ({ signal }) => createAdminRegistrationApi(client).settings({ signal }),
  });
}

export function registrationCodesQuery(client: ApiClient, userId: string, creatorFilter?: string) {
  return infiniteQueryOptions({
    queryKey: [...registrationKeys.root(userId), 'codes', creatorFilter],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      createAdminRegistrationApi(client).codes(
        {
          cursor: pageParam,
          ...(creatorFilter === undefined ? {} : { creatorFilter }),
        },
        { signal },
      ),
    getNextPageParam: (last, pages) => nextPageCursor(last, pages, '邀请码分页'),
  });
}
