import { infiniteQueryOptions } from '@tanstack/react-query';
import { createAdminAuditApi } from '@cheapai/api-client/audit';
import type { AuditQuery } from '@cheapai/contracts/audit';
import type { ApiClient } from '@cheapai/api-client/types';

import { nextPageCursor } from '../../shared/lib/pagination';

export function auditQueryOptions(
  client: ApiClient,
  actorId: string,
  filters: Omit<AuditQuery, 'cursor'>,
) {
  return infiniteQueryOptions({
    queryKey: ['audit', actorId, 'admin', filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      createAdminAuditApi(client).list({ ...filters, cursor: pageParam }, { signal }),
    getNextPageParam: (last, pages) => nextPageCursor(last, pages, '审计分页'),
  });
}
