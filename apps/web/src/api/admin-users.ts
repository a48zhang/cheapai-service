import { createApiClient, readCsrfCookie } from './client.js';
import { authApi } from './auth.js';
import type { PublicUser } from './auth.js';
export interface UserListItem extends PublicUser { allowed_group_ids: readonly string[]; group_name: string; concurrency_limit: number; rpm_limit: number; created_at: number; updated_at: number; version: number }
export interface UserPatch { status: 'active' | 'disabled'; groupId: string; concurrencyLimit: number; rpmLimit: number; allowedGroupIds?: readonly string[] }
export interface UserGroup { id: string; name: string; status: 'active' | 'disabled' }
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 254;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function invalid(): never { throw new TypeError('Invalid user response.'); }
// Backend create/update PublicUser is snake_case too; camelCase is request-only.
function publicUser(v: unknown): PublicUser {
  if (!record(v) || !text(v.id) || !text(v.email_normalized) || !text(v.group_id) || (v.role !== 'user' && v.role !== 'admin')
    || (v.status !== 'active' && v.status !== 'disabled') || (v.group_status !== 'active' && v.group_status !== 'disabled')
    || typeof v.balance_units !== 'string' || !/^(?:0|-?[1-9][0-9]*)$/.test(v.balance_units) || !(v.email_verified_at === null || count(v.email_verified_at))) invalid();
  return { id: v.id, email_normalized: v.email_normalized, group_id: v.group_id, role: v.role, status: v.status, group_status: v.group_status, balance_units: v.balance_units, email_verified_at: v.email_verified_at };
}
function row(v: unknown): UserListItem {
  const user = publicUser(v);
  if (!record(v) || !Array.isArray(v.allowed_group_ids) || !v.allowed_group_ids.every(text) || !text(v.group_name) || !count(v.concurrency_limit) || v.concurrency_limit < 1 || !count(v.rpm_limit) || v.rpm_limit < 1
    || !count(v.created_at) || !count(v.updated_at) || !count(v.version) || v.version < 1) invalid();
  return { ...user, allowed_group_ids: v.allowed_group_ids as string[], group_name: v.group_name, concurrency_limit: v.concurrency_limit, rpm_limit: v.rpm_limit, created_at: v.created_at, updated_at: v.updated_at, version: v.version };
}
const client = createApiClient({ getCsrfToken: async () => readCsrfCookie() ?? (await authApi.bootstrap()).csrfToken });
export const adminUsersApi = Object.freeze({
  async list(options: { cursor?: string | null; status?: 'active' | 'disabled'; groupId?: string } = {}) {
    return (await client.get('/api/v1/admin/users', { query: { ...options, limit: 20 }, decode: v => {
      if (!record(v) || !Array.isArray(v.items) || !(v.nextCursor === null || typeof v.nextCursor === 'string') || !count(v.snapshotAt)) invalid();
      return { items: v.items.map(row), nextCursor: v.nextCursor, snapshotAt: v.snapshotAt };
    } })).data;
  },
  async groups(cursor: string | null = null) {
    return (await client.get('/api/v1/admin/groups', { query: { cursor, status: 'active', limit: 100 }, decode: v => {
      if (!record(v) || !Array.isArray(v.items) || !(v.nextCursor === null || typeof v.nextCursor === 'string')) invalid();
      return { items: v.items.map((g): UserGroup => { if (!record(g) || !text(g.id) || !text(g.name) || (g.status !== 'active' && g.status !== 'disabled')) invalid(); return { id: g.id, name: g.name, status: g.status }; }), nextCursor: v.nextCursor };
    } })).data;
  },
  async create(input: { email: string; password: string; groupId?: string }) {
    return (await client.post('/api/v1/admin/users', { email: input.email, password: input.password, ...(input.groupId === undefined ? {} : { groupId: input.groupId }) }, { decode: publicUser })).data;
  },
  async update(id: string, version: number, input: UserPatch) {
    return (await client.patch(`/api/v1/admin/users/${encodeURIComponent(id)}`, { version, status: input.status, groupId: input.groupId, concurrencyLimit: input.concurrencyLimit, rpmLimit: input.rpmLimit, ...(input.allowedGroupIds ? { allowedGroupIds: input.allowedGroupIds } : {}) }, { decode: publicUser })).data;
  },
});
