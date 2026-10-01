import { createApiClient, readCsrfCookie } from './client.js';
import { authApi } from './auth.js';
import type { Page } from './types.js';

export interface AuditEntry { readonly id: string; readonly actor_id: string; readonly action: string; readonly target_type: string; readonly target_id: string; readonly operation_id: string; readonly created_at: number; readonly changes: Record<string, unknown> | null; readonly redaction_valid: boolean }
export interface AuditQuery { readonly cursor?: string | null; readonly from?: number; readonly to?: number; readonly actorId?: string; readonly action?: string; readonly targetType?: string; readonly targetId?: string; readonly operationId?: string }
export interface AuditPage extends Page<AuditEntry> { readonly snapshotAt: number }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function invalid(): never { throw new TypeError('Invalid administrator audit response.'); }
function decodeEntry(value: unknown): AuditEntry { if (!object(value) || !text(value.id) || !text(value.actor_id) || !text(value.action, 64) || !text(value.target_type, 64) || !text(value.target_id) || !text(value.operation_id) || !count(value.created_at) || !(value.changes === null || object(value.changes)) || typeof value.redaction_valid !== 'boolean') invalid(); return { id: value.id, actor_id: value.actor_id, action: value.action, target_type: value.target_type, target_id: value.target_id, operation_id: value.operation_id, created_at: value.created_at, changes: value.changes, redaction_valid: value.redaction_valid }; }
export function decodeAuditPage(value: unknown): AuditPage { if (!object(value) || !Array.isArray(value.items) || !count(value.snapshotAt) || !(value.nextCursor === null || text(value.nextCursor, 2048))) invalid(); return { items: value.items.map(decodeEntry), snapshotAt: value.snapshotAt, nextCursor: value.nextCursor }; }
const client = createApiClient({ getCsrfToken: async () => readCsrfCookie() ?? (await authApi.bootstrap()).csrfToken });
export function createAdminAuditApi(api = client) { return Object.freeze({ async list(options: AuditQuery = {}): Promise<AuditPage> { return (await api.get('/api/v1/admin/audit', { query: { ...options, limit: 20 }, decode: decodeAuditPage })).data; } }); }
export const adminAuditApi = createAdminAuditApi();
