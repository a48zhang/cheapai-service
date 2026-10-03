import { decodePublicUser } from '@cheapai/contracts/auth';
import { decodeUser, decodeUserPage, decodeBalanceAdjustment, userGroupPageSchema, adminKeyRevocationSchema, type UserInput, type UserPatch, type BalanceAdjustmentInput } from '@cheapai/contracts/users';
import type { ApiClient } from './types.js';
export type { UserListItem, UserInput, UserPatch, UserGroup, UserPage, BalanceAdjustmentInput, BalanceAdjustmentResult } from '@cheapai/contracts/users';

export function createAdminUsersApi(client: ApiClient) {
  const path = (id: string) => `/api/v1/admin/users/${encodeURIComponent(id)}`;
  return Object.freeze({
    async list(options: { cursor?: string | null; status?: 'active' | 'disabled'; groupId?: string } = {}) {
      return (await client.get('/api/v1/admin/users', { query: { ...options, limit: 20 }, decode: decodeUserPage })).data;
    },
    async get(id: string) { return (await client.get(path(id), { decode: decodeUser })).data; },
    async groups(cursor: string | null = null) {
      return (await client.get('/api/v1/admin/groups', { query: { cursor, status: 'active', limit: 100 }, decode: value => userGroupPageSchema.parse(value) })).data;
    },
    async create(input: UserInput) { return (await client.post('/api/v1/admin/users', { ...input }, { decode: decodePublicUser })).data; },
    async update(id: string, version: number, input: UserPatch) { return (await client.patch(path(id), { version, ...input }, { decode: decodePublicUser })).data; },
    async adjust(userId: string, input: BalanceAdjustmentInput, operationId: string) {
      return (await client.post(`${path(userId)}/balance-adjustments`, { ...input }, { idempotencyKey: operationId, decode: decodeBalanceAdjustment })).data;
    },
    async revokeKey(id: string, version: number) {
      return (await client.post(`/api/v1/admin/keys/${encodeURIComponent(id)}/revoke`, { version }, { decode: value => adminKeyRevocationSchema.parse(value) })).data;
    },
  });
}
export const createUsersApi = createAdminUsersApi;
export type AdminUsersApi = ReturnType<typeof createAdminUsersApi>;
