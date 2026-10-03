import { infiniteQueryOptions } from '@tanstack/react-query';
import { createAdminAuditApi } from '@cheapai/api-client/audit';
import type { AuditQuery } from '@cheapai/contracts/audit';
import type { ApiClient } from '@cheapai/api-client/types';
export function auditQueryOptions(client: ApiClient, actorId: string, filters: Omit<AuditQuery, 'cursor'>) {
  return infiniteQueryOptions({ queryKey: ['audit', actorId, 'admin', filters], initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => createAdminAuditApi(client).list({ ...filters, cursor: pageParam }),
    getNextPageParam: (last, pages) => {
      if (last.nextCursor && pages.slice(0, -1).some(page => page.nextCursor === last.nextCursor)) throw new Error('审计分页返回重复游标。');
      return last.nextCursor ?? undefined;
    },
  });
}
