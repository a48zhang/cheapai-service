import { decodeAuditPage, type AuditQuery } from '@cheapai/contracts/audit';
import type { ApiClient } from './types.js';
export type { AuditEntry, AuditPage, AuditQuery } from '@cheapai/contracts/audit';
export function createAdminAuditApi(client: ApiClient) {
  return Object.freeze({ async list(options: AuditQuery = {}) { return (await client.get('/api/v1/admin/audit', { query: { ...options, limit: 20 }, decode: decodeAuditPage })).data; } });
}
