import { batch, prepare } from '../db';
import { parseConcurrencyLimit, parseRpmLimit } from '../config';
import type { DbValue } from '../db';
import { ApiError, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../http';
import { validateUpstreamBaseUrl } from '../gateway/upstream-url';
import { buildAuditStatement } from './audit';
import { encryptChannelSecret } from '../catalog/channel-secrets';
import { getChannelById, channelProjection as projection, decodeChannelRow as view, channelText as text, channelId as idValue } from '../catalog/channels';
import type { ChannelView, ChannelRow, ChannelEncryptionKey } from '../catalog/channels';
export { getChannelById, readChannelForForwarding } from '../catalog/channels';
export type { ChannelView, ChannelEncryptionKey } from '../catalog/channels';

export interface CreateChannelInput {
  name: string; baseUrl: string; upstreamKey: string;
  concurrencyLimit?: number | null; rpmLimit?: number | null; priority?: number; status?: 'active' | 'disabled';
}
export type ChannelPatch = Partial<CreateChannelInput>;
export interface ChannelAuditContext { actorId: string; operationId: string; now: number }
export interface ChannelPageOptions { limit?: number; cursor?: string; status?: 'active' | 'disabled' }
export interface ChannelPage { items: ChannelView[]; nextCursor: string | null }

const fields = ['name', 'baseUrl', 'upstreamKey', 'concurrencyLimit', 'rpmLimit', 'priority', 'status'] as const;

function inputObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new ApiError('invalid_request');
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) throw new ApiError('invalid_request');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || descriptor.value === undefined) throw new ApiError('invalid_request');
    result[key] = descriptor.value;
  }
  return result;
}
function rpm(value: unknown): number { try { return parseRpmLimit(value); } catch { throw new ApiError('invalid_request'); } }
function concurrency(value: unknown): number { try { return parseConcurrencyLimit(value); } catch { throw new ApiError('invalid_request'); } }
function integer(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new ApiError('invalid_request');
  return value;
}
function url(value: unknown): string {
  try { return validateUpstreamBaseUrl(text(value, 2048)).toString(); }
  catch { throw new ApiError('invalid_request'); }
}
function status(value: unknown): 'active' | 'disabled' {
  if (value !== 'active' && value !== 'disabled') throw new ApiError('invalid_request');
  return value;
}
function auditContext(context: ChannelAuditContext): ChannelAuditContext {
  return { actorId: idValue(context.actorId), operationId: idValue(context.operationId), now: integer(context.now) };
}
async function encrypt(key: unknown, id: string, encryption: ChannelEncryptionKey | undefined): Promise<string> {
  const plaintext = text(key, 16384); // An omitted key is handled by update; empty never means deletion.
  if (!encryption) throw new ApiError('service_unavailable');
  try { return await encryptChannelSecret(plaintext, id, encryption.keyVersion, encryption.key); }
  catch { throw new ApiError('service_unavailable'); }
}
function writeError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  // Only classify our fixed SQL guard marker; never expose underlying DB errors.
  if (error instanceof Error && error.message.includes('channel_write_conflict')) throw new ApiError('conflict');
  throw new ApiError('service_unavailable');
}
function requireOneChange(database: D1Database) {
  // changes() observes the immediately preceding write on the SAME D1 batch.
  // Invalid JSON path is a deliberate SQL error, so zero rows rolls back audit
  // and business state rather than merely detecting the conflict after commit.
  return prepare(database, "SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('{}', 'channel_write_conflict') END AS matched");
}

/** Caller must authorize administrator access; this module performs no HTTP I/O. */
export async function createChannel(database: D1Database, input: CreateChannelInput, context: ChannelAuditContext, encryption: ChannelEncryptionKey): Promise<ChannelView> {
  const values = inputObject(input, fields);
  const audit = auditContext(context);
  const id = crypto.randomUUID();
  const row = { id, name: text(values.name, 200), base_url: url(values.baseUrl),
    status: status(Object.hasOwn(values, 'status') ? values.status : 'active'), priority: integer(Object.hasOwn(values, 'priority') ? values.priority : 0),
    concurrency_limit: concurrency(values.concurrencyLimit), rpm_limit: rpm(values.rpmLimit) };
  const ciphertext = await encrypt(values.upstreamKey, id, encryption);
  try {
    const results = await batch(database, [
      prepare<ChannelRow>(database, `INSERT INTO channels (id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,1,?,?) RETURNING ${projection}`,
      [id, row.name, row.base_url, ciphertext, encryption.keyVersion, row.status, row.priority, row.concurrency_limit, row.rpm_limit, audit.now, audit.now]),
      requireOneChange(database),
      buildAuditStatement(database, { actor_id: audit.actorId, operation_id: audit.operationId, created_at: audit.now,
        action: 'channel.create', target_type: 'channel', target_id: id,
        changes: { status: row.status, priority: row.priority, concurrency_limit: row.concurrency_limit, rpm_limit: row.rpm_limit,
          config_version: 1, credential_changed: true, name_changed: true, base_url_changed: true } }),
    ] as const);
    const saved = results[0].rows[0];
    if (!saved) throw new ApiError('service_unavailable');
    return view(saved);
  } catch (error) { return writeError(error); }
}

export async function updateChannel(database: D1Database, id: string, expectedVersion: number, patch: ChannelPatch, context: ChannelAuditContext, encryption?: ChannelEncryptionKey): Promise<ChannelView> {
  idValue(id); integer(expectedVersion, 1);
  if (expectedVersion === Number.MAX_SAFE_INTEGER) throw new ApiError('conflict');
  const values = inputObject(patch, fields);
  if (Object.keys(values).length === 0) throw new ApiError('invalid_request');
  const audit = auditContext(context);
  const current = await getChannelById(database, id);
  if (!current) throw new ApiError('not_found');
  if (current.configVersion !== expectedVersion) throw new ApiError('conflict');
  const updated = { name: current.name, baseUrl: current.baseUrl, status: current.status, priority: current.priority,
    concurrencyLimit: current.concurrencyLimit, rpmLimit: current.rpmLimit };
  if (Object.hasOwn(values, 'name')) updated.name = text(values.name, 200);
  if (Object.hasOwn(values, 'baseUrl')) updated.baseUrl = url(values.baseUrl);
  if (Object.hasOwn(values, 'status')) updated.status = status(values.status);
  if (Object.hasOwn(values, 'priority')) updated.priority = integer(values.priority);
  if (Object.hasOwn(values, 'concurrencyLimit')) updated.concurrencyLimit = concurrency(values.concurrencyLimit);
  if (Object.hasOwn(values, 'rpmLimit')) updated.rpmLimit = rpm(values.rpmLimit);
  const changesCredential = Object.hasOwn(values, 'upstreamKey');
  const ciphertext = changesCredential ? await encrypt(values.upstreamKey, id, encryption) : null;
  const assignments = ['name=?', 'base_url=?', 'status=?', 'priority=?', 'concurrency_limit=?', 'rpm_limit=?', 'config_version=config_version+1', 'updated_at=max(updated_at,?)'];
  const params: DbValue[] = [updated.name, updated.baseUrl, updated.status, updated.priority, updated.concurrencyLimit, updated.rpmLimit, audit.now];
  if (changesCredential) { assignments.push('secret_ciphertext=?', 'secret_key_version=?'); params.push(ciphertext, encryption!.keyVersion); }
  params.push(id, expectedVersion);
  try {
    const results = await batch(database, [
      prepare<ChannelRow>(database, `UPDATE channels SET ${assignments.join(',')} WHERE id=? AND config_version=? RETURNING ${projection}`, params),
      requireOneChange(database),
      buildAuditStatement(database, { actor_id: audit.actorId, operation_id: audit.operationId, created_at: audit.now,
        action: 'channel.update', target_type: 'channel', target_id: id,
        changes: { before: { status: current.status, priority: current.priority, concurrency_limit: current.concurrencyLimit, rpm_limit: current.rpmLimit, config_version: expectedVersion },
          after: { status: updated.status, priority: updated.priority, concurrency_limit: updated.concurrencyLimit, rpm_limit: updated.rpmLimit, config_version: expectedVersion + 1 },
          credential_changed: changesCredential, name_changed: current.name !== updated.name, base_url_changed: current.baseUrl !== updated.baseUrl } }),
    ] as const);
    const saved = results[0].rows[0];
    if (!saved) throw new ApiError('service_unavailable');
    return view(saved);
  } catch (error) { return writeError(error); }
}

export async function listChannels(database: D1Database, options: ChannelPageOptions = {}): Promise<ChannelPage> {
  const values = inputObject(options, ['limit', 'cursor', 'status']);
  const limit = integer(Object.hasOwn(values, 'limit') ? values.limit : DEFAULT_PAGE_LIMIT, 1);
  if (limit > MAX_PAGE_LIMIT) throw new ApiError('invalid_request');
  const filter = values.status === undefined ? null : status(values.status);
  let time: number | null = null;
  let id: string | null = null;
  if (Object.hasOwn(values, 'cursor')) {
    try {
      const token = text(values.cursor, 1024);
      if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error();
      const raw = atob(token.replace(/-/g, '+').replace(/_/g, '/'));
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== 1 || parsed[3] !== filter) throw new Error();
      time = integer(parsed[1]); id = idValue(parsed[2]);
      if (btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== token) throw new Error();
    } catch { throw new ApiError('invalid_request'); }
  }
  const result = await prepare<ChannelRow>(database, `SELECT ${projection} FROM channels
    WHERE (? IS NULL OR status=?) AND (? IS NULL OR created_at<? OR (created_at=? AND id<?))
    ORDER BY created_at DESC,id DESC LIMIT ?`, [filter, filter, time, time, time, id, limit + 1]).all();
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  const nextCursor = result.rows.length > limit && last
    ? btoa(JSON.stringify([1, last.created_at, last.id, filter])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : null;
  return { items: rows.map(view), nextCursor };
}
