import { createApiClient, readCsrfCookie } from './client.js';
import { authApi } from './auth.js';
import { decodeRequest, decodeRequestPage, type RequestPage, type RequestQuery, type RequestRecord } from './requests.js';

const client = createApiClient({ getCsrfToken: async () => readCsrfCookie() ?? (await authApi.bootstrap()).csrfToken });
const path = (id: string) => `/api/v1/admin/requests/${encodeURIComponent(id)}`;
export function createAdminRequestsApi(api = client) {
  return Object.freeze({
    async list(options: RequestQuery = {}): Promise<RequestPage> { return (await api.get('/api/v1/admin/requests', { query: { ...options, limit: 20 }, decode: decodeRequestPage })).data; },
    async get(id: string): Promise<RequestRecord> { return (await api.get(path(id), { decode: decodeRequest })).data; },
    /** The endpoint accepts only an empty JSON object and has no idempotency
     * header. A retry remains safe because the server verifies immutable evidence. */
    async retrySettlement(id: string): Promise<{ status: 'settled' | 'already_settled'; requestId: string; entryId: string; costUnits: string }> {
      return (await api.post(`${path(id)}/retry-settlement`, {}, { decode: value => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid settlement response.');
        const body = value as Record<string, unknown>;
        if ((body.status !== 'settled' && body.status !== 'already_settled') || typeof body.requestId !== 'string' || !body.requestId
          || typeof body.entryId !== 'string' || !body.entryId || typeof body.costUnits !== 'string' || !/^(?:0|-?[1-9][0-9]*)$/u.test(body.costUnits)) throw new TypeError('Invalid settlement response.');
        return { status: body.status as 'settled' | 'already_settled', requestId: body.requestId, entryId: body.entryId, costUnits: body.costUnits };
      } })).data;
    },
  });
}
export const adminRequestsApi = createAdminRequestsApi();
