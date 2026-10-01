import { createApiClient, readCsrfCookie } from './client.js';
import { authApi } from './auth.js';
import type { Page } from './types.js';

export type GroupStatus = 'active' | 'disabled';
/** A canonical, non-negative decimal kept as text so the UI never rounds a multiplier. */
export type BillingMultiplier = string;
export interface GroupView { readonly id: string; readonly name: string; readonly status: GroupStatus; readonly version: number; readonly createdAt: number; readonly updatedAt: number; readonly channelIds: readonly string[]; readonly billingMultiplier: BillingMultiplier }
export interface GroupInput { readonly name: string; readonly status?: GroupStatus; readonly channelIds?: readonly string[]; readonly billingMultiplier?: BillingMultiplier }
export type GroupPatch = Partial<GroupInput>;
export type GroupPage = Page<GroupView>;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const isBillingMultiplier = (value: unknown): value is BillingMultiplier => typeof value === 'string' && value.length > 0 && value.length <= 64
  && value.trim() === value && /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/u.test(value);
function invalid(): never { throw new TypeError('Invalid administrator group response.'); }
function decodeGroup(value: unknown): GroupView {
  if (!object(value) || !text(value.id) || !text(value.name, 128) || (value.status !== 'active' && value.status !== 'disabled') || !count(value.version) || value.version < 1
    || !count(value.createdAt) || !count(value.updatedAt) || value.updatedAt < value.createdAt || !Array.isArray(value.channelIds) || value.channelIds.some(id => !text(id)) || new Set(value.channelIds).size !== value.channelIds.length) invalid();
  const billingMultiplier = value.billingMultiplier === undefined ? '1' : value.billingMultiplier;
  if (!isBillingMultiplier(billingMultiplier)) invalid();
  return { id: value.id, name: value.name, status: value.status, version: value.version, createdAt: value.createdAt, updatedAt: value.updatedAt,
    channelIds: [...value.channelIds] as string[], billingMultiplier };
}
export function decodeGroupPage(value: unknown): GroupPage { if (!object(value) || !Array.isArray(value.items) || !(value.nextCursor === null || text(value.nextCursor, 2048))) invalid(); return { items: value.items.map(decodeGroup), nextCursor: value.nextCursor }; }
const client = createApiClient({ getCsrfToken: async () => readCsrfCookie() ?? (await authApi.bootstrap()).csrfToken });
const path = (id: string) => `/api/v1/admin/groups/${encodeURIComponent(id)}`;
export function createAdminGroupsApi(api = client) {
  return Object.freeze({
    async list(options: { readonly cursor?: string | null; readonly status?: GroupStatus } = {}): Promise<GroupPage> { return (await api.get('/api/v1/admin/groups', { query: { ...options, limit: 20 }, decode: decodeGroupPage })).data; },
    async create(input: GroupInput): Promise<GroupView> { return (await api.post('/api/v1/admin/groups', { ...input }, { decode: decodeGroup })).data; },
    async update(id: string, version: number, input: GroupPatch): Promise<GroupView> { return (await api.patch(path(id), { version, ...input }, { decode: decodeGroup })).data; },
  });
}
export const adminGroupsApi = createAdminGroupsApi();
export { decodeGroup };
