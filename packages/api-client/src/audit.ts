import { decodeAuditPage, type AuditQuery } from '@cheapai/contracts/audit';
import type { ApiClient, ApiReadOptions } from './types.js';
export type { AuditEntry, AuditPage, AuditQuery } from '@cheapai/contracts/audit';
export function createAdminAuditApi(client: ApiClient) {
  return Object.freeze({
    async list(options: AuditQuery = {}, readOptions?: ApiReadOptions) {
      return (
        await client.get('/api/v1/admin/audit', {
          query: { ...options, limit: 20 },
          decode: decodeAuditPage,
          ...(readOptions?.signal === undefined ? {} : { signal: readOptions.signal }),
        })
      ).data;
    },
  });
}
