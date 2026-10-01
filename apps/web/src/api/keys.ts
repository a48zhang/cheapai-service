import { createApiClient, readCsrfCookie } from './client.js';
import { authApi } from './auth.js';
import type { Page } from './types.js';

export interface KeyMetadata {
  readonly id: string; readonly userId: string; readonly groupId: string; readonly groupName: string; readonly name: string; readonly displayPrefix: string;
  readonly status: 'active' | 'revoked'; readonly allowedModels: readonly string[] | null;
  readonly expiresAt: number | null; readonly createdAt: number; readonly updatedAt: number; readonly version: number;
}
export interface KeyInput { readonly name: string; readonly expiresAt: number | null; readonly groupId: string }
export interface KeyGroup { readonly id: string; readonly name: string; readonly models: readonly string[] }
export type KeyCreation = { kind: 'created'; key: KeyMetadata; token: string } | { kind: 'replayed'; key: KeyMetadata };
export type KeyState = 'all' | 'active' | 'expired' | 'revoked';
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function invalid(): never { throw new TypeError('Invalid Key metadata.'); }
export function decodeKey(v: unknown): KeyMetadata {
  if (!object(v) || !text(v.id) || !text(v.userId) || !text(v.groupId) || !text(v.groupName) || !text(v.name) || typeof v.displayPrefix !== 'string' || !/^s2a_key_[A-Za-z0-9_-]{8}$/.test(v.displayPrefix)
    || (v.status !== 'active' && v.status !== 'revoked') || !(v.allowedModels === null || (Array.isArray(v.allowedModels) && v.allowedModels.length <= 100 && v.allowedModels.every(text) && new Set(v.allowedModels).size === v.allowedModels.length))
    || !(v.expiresAt === null || time(v.expiresAt)) || !time(v.createdAt) || !time(v.updatedAt) || v.updatedAt < v.createdAt || !time(v.version) || v.version < 1) invalid();
  return { id: v.id, userId: v.userId, groupId: v.groupId, groupName: v.groupName, name: v.name, displayPrefix: v.displayPrefix, status: v.status,
    allowedModels: v.allowedModels === null ? null : [...v.allowedModels] as string[], expiresAt: v.expiresAt,
    createdAt: v.createdAt, updatedAt: v.updatedAt, version: v.version };
}
function decodePage(v: unknown): Page<KeyMetadata> {
  if (!object(v) || !Array.isArray(v.items) || !(v.nextCursor === null || typeof v.nextCursor === 'string')) invalid();
  return { items: v.items.map(decodeKey), nextCursor: v.nextCursor };
}
const path = (id: string) => `/api/v1/keys/${encodeURIComponent(id)}`;
export function createKeysApi(client = createApiClient({ getCsrfToken: async () => readCsrfCookie() ?? (await authApi.bootstrap()).csrfToken })) {
  return Object.freeze({
    async groups(): Promise<readonly KeyGroup[]> { return (await client.get('/api/v1/account/key-groups', { decode: v => {
      if (!object(v) || !Array.isArray(v.items)) invalid();
      return v.items.map(item => { if (!object(item) || !text(item.id) || !text(item.name) || !Array.isArray(item.models) || !item.models.every(text)) invalid(); return { id:item.id,name:item.name,models:[...item.models] as string[] }; });
    } })).data; },
    async list(options: { cursor?: string | null; state?: KeyState } = {}) { return (await client.get('/api/v1/keys', { query: { ...options, limit: 20 }, decode: decodePage })).data; },
    async get(id: string) { return (await client.get(path(id), { decode: decodeKey })).data; },
    async create(input: KeyInput, operationId: string): Promise<KeyCreation> {
      return (await client.post('/api/v1/keys', { ...input }, { idempotencyKey: operationId, decode: v => {
        if (!object(v)) invalid(); const key = decodeKey(v.key);
        if (v.kind === 'replayed') return { kind: 'replayed' as const, key };
        if (v.kind === 'created' && typeof v.token === 'string' && /^s2a_key_[A-Za-z0-9_-]{43}$/.test(v.token)) return { kind: 'created' as const, key, token: v.token };
        return invalid();
      } })).data;
    },
    async update(id: string, version: number, input: KeyInput) { return (await client.patch(path(id), { version, ...input }, { decode: decodeKey })).data; },
    async revoke(id: string, version: number) {
      return (await client.post(`${path(id)}/revoke`, { version }, { decode: v => {
        if (!object(v) || (v.kind !== 'revoked' && v.kind !== 'already_revoked')) invalid();
        return { kind: v.kind, key: decodeKey(v.key) };
      } })).data;
    },
  });
}
export const keysApi = createKeysApi();
