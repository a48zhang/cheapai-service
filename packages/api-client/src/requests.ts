import { decodeRequest, decodeRequestPage } from '@cheapai/contracts/requests';
import type { AdminRequestQuery, RequestPage, RequestQuery, RequestRecord } from '@cheapai/contracts/requests';
import type { ApiClient } from './types.js';

export type {
  BillingStatus,
  AdminRequestQuery,
  ExecutionStatus,
  PriceSnapshot,
  Protocol,
  PublicUsage,
  RequestError,
  RequestPage,
  RequestQuery,
  RequestRecord,
  RequestSource,
  TokenCounts,
  UsageQuality,
  UsageSemantics,
} from '@cheapai/contracts/requests';
export { decodeRequest, decodeRequestPage } from '@cheapai/contracts/requests';

const requestPath = (id: string, admin: boolean) => `${admin ? '/api/v1/admin/requests' : '/api/v1/usage/requests'}/${encodeURIComponent(id)}`;

function createScopedRequestsApi(api: ApiClient, admin: boolean) {
  const collection = admin ? '/api/v1/admin/requests' : '/api/v1/usage/requests';
  return Object.freeze({
    async list(options: RequestQuery | AdminRequestQuery = {}): Promise<RequestPage> {
      return (await api.get(collection, { query: { ...options, limit: 20 }, decode: decodeRequestPage })).data;
    },
    async get(id: string): Promise<RequestRecord> {
      return (await api.get(requestPath(id, admin), { decode: decodeRequest })).data;
    },
  });
}

/** Personal request history; authorization scope is supplied by the server session. */
export function createRequestsApi(api: ApiClient) {
  const scoped = createScopedRequestsApi(api, false);
  return Object.freeze({ list: scoped.list as (options?: RequestQuery) => Promise<RequestPage>, get: scoped.get });
}

/** Administrator request history uses its own route and cache scope. */
export function createAdminRequestsApi(api: ApiClient) {
  const scoped = createScopedRequestsApi(api, true);
  return Object.freeze({ list: scoped.list as (options?: AdminRequestQuery) => Promise<RequestPage>, get: scoped.get });
}
