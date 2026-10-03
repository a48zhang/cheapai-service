import { decodeSettlementResult } from '@cheapai/contracts/audit';
import type { ApiClient } from './types.js';
export function createSettlementsApi(client: ApiClient) {
  return Object.freeze({ async retrySettlement(id: string) {
    return (await client.post(`/api/v1/admin/requests/${encodeURIComponent(id)}/retry-settlement`, {}, { decode: decodeSettlementResult })).data;
  } });
}
