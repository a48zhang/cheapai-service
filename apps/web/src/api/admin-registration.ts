import { createApiClient, readCsrfCookie } from './client.js';
import { authApi } from './auth.js';
export interface AdminRegistrationSettings {
  registrationMode: 'closed' | 'open' | 'invite' | null; emailVerificationEnabled: boolean | null;
  version: number | null; updatedAt: number | null; valid: boolean; ready: boolean; emailAvailable: boolean;
  issues: readonly ('missing_settings' | 'invalid_settings' | 'email_unavailable')[];
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function invalid(): never { throw new TypeError('Invalid administrator registration response.'); }
function decodeSettings(v: unknown): AdminRegistrationSettings {
  if (!object(v) || !(v.registrationMode === null || v.registrationMode === 'closed' || v.registrationMode === 'open' || v.registrationMode === 'invite')
    || !(v.emailVerificationEnabled === null || typeof v.emailVerificationEnabled === 'boolean') || !(v.version === null || count(v.version) && v.version > 0)
    || !(v.updatedAt === null || count(v.updatedAt)) || typeof v.valid !== 'boolean' || typeof v.ready !== 'boolean' || typeof v.emailAvailable !== 'boolean'
    || !Array.isArray(v.issues) || !v.issues.every(x => x === 'missing_settings' || x === 'invalid_settings' || x === 'email_unavailable')) invalid();
  return { registrationMode: v.registrationMode, emailVerificationEnabled: v.emailVerificationEnabled, version: v.version,
    updatedAt: v.updatedAt, valid: v.valid, ready: v.ready, emailAvailable: v.emailAvailable, issues: [...v.issues] as AdminRegistrationSettings['issues'] };
}
const client = createApiClient({ getCsrfToken: async () => readCsrfCookie() ?? (await authApi.bootstrap()).csrfToken });
const settingsPath = '/api/v1/admin/registration/settings';
const codesPath = '/api/v1/admin/registration/codes';
export interface CodeMetadata { id: string; displayPrefix: string; ordinal: number; expiresAt: number | null }
export interface CodeListItem extends CodeMetadata { batchId: string; createdBy: string; createdAt: number; usedBy: string | null; usedAt: number | null; revokedAt: number | null; status: 'unused' | 'used' | 'expired' | 'revoked' }
export type CodeBatch = { batchId: string; replayed: true; codes: CodeMetadata[] } | { batchId: string; replayed: false; codes: (CodeMetadata & { token: string })[] };
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
const nullableTime = (v: unknown): v is number | null => v === null || count(v);
function codeMetadata(v: unknown): CodeMetadata {
  if (!object(v) || !text(v.id) || typeof v.displayPrefix !== 'string' || !/^s2a_invite_[A-Za-z0-9_-]{8}$/.test(v.displayPrefix) || !count(v.ordinal) || !nullableTime(v.expiresAt)) invalid();
  return { id: v.id, displayPrefix: v.displayPrefix, ordinal: v.ordinal, expiresAt: v.expiresAt };
}
function codeItem(v: unknown): CodeListItem {
  const base = codeMetadata(v);
  if (!object(v) || !text(v.batchId) || !text(v.createdBy) || !count(v.createdAt) || !(v.usedBy === null || text(v.usedBy))
    || !nullableTime(v.usedAt) || !nullableTime(v.revokedAt) || !['unused', 'used', 'expired', 'revoked'].includes(typeof v.status === 'string' ? v.status : '')) invalid();
  return { ...base, batchId: v.batchId, createdBy: v.createdBy, createdAt: v.createdAt, usedBy: v.usedBy, usedAt: v.usedAt, revokedAt: v.revokedAt, status: v.status as CodeListItem['status'] };
}
export const adminRegistrationApi = Object.freeze({
  async settings() { return (await client.get(settingsPath, { decode: decodeSettings })).data; },
  async updateSettings(version: number, registrationMode: 'closed' | 'open' | 'invite', emailVerificationEnabled: boolean) {
    return (await client.patch(settingsPath, { version, registrationMode, emailVerificationEnabled }, { decode: decodeSettings })).data;
  },
  async codes(options: { cursor?: string | null; creatorFilter?: string } = {}) {
    return (await client.get(codesPath, { query: { ...options, limit: 20 }, decode: v => {
      if (!object(v) || !Array.isArray(v.items) || !(v.nextCursor === null || text(v.nextCursor) || typeof v.nextCursor === 'string') || !count(v.snapshotAt)) invalid();
      return { items: v.items.map(codeItem), nextCursor: v.nextCursor as string | null, snapshotAt: v.snapshotAt };
    } })).data;
  },
  async revokeCode(id: string) {
    return (await client.post(`${codesPath}/${encodeURIComponent(id)}/revoke`, {}, { decode: v => {
      if (!object(v) || !text(v.id) || (v.status !== 'revoked' && v.status !== 'already_revoked') || !nullableTime(v.revokedAt)) invalid();
      return { id: v.id, status: v.status, revokedAt: v.revokedAt };
    } })).data;
  },
  async createCodes(input: { quantity: number; expiresAt: number }, operationId: string): Promise<CodeBatch> {
    return (await client.post(codesPath, { ...input }, { idempotencyKey: operationId, decode: v => {
      if (!object(v) || !text(v.batchId) || typeof v.replayed !== 'boolean' || !Array.isArray(v.codes) || v.codes.length < 1 || v.codes.length > 100) invalid();
      if (v.replayed) return { batchId: v.batchId, replayed: true as const, codes: v.codes.map(codeMetadata) };
      return { batchId: v.batchId, replayed: false as const, codes: v.codes.map(code => {
        const base = codeMetadata(code); if (!object(code) || typeof code.token !== 'string' || !/^s2a_invite_[A-Za-z0-9_-]{43}$/.test(code.token)) invalid();
        return { ...base, token: code.token };
      }) };
    } })).data;
  },
});
