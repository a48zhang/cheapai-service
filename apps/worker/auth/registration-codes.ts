import { buildAuditStatement } from '../admin/audit';
import { batch, prepare } from '../db';
import type { DbValue } from '../db';
import { ApiError } from '../http';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../http';
import { generateToken, getTokenDisplayPrefix, hashToken } from './tokens';

export const REGISTRATION_CODE_LIMITS = Object.freeze({ quantity: 100, lifetimeMs: 30 * 86_400_000 });
export interface GenerateRegistrationCodesInput {
  /** Trusted authenticated actor and server time, never copied from request body. */
  actorId: string;
  now: number;
  operationId: string;
  quantity: number;
  /** Explicit absolute expiry keeps the retry fingerprint stable across time. */
  expiresAt: number;
}
export interface RegistrationCodeMetadata { id: string; displayPrefix: string; ordinal: number; expiresAt: number | null }
export type RegistrationCodeBatchResult =
  | { batchId: string; replayed: false; codes: (RegistrationCodeMetadata & { token: string })[] }
  | { batchId: string; replayed: true; codes: RegistrationCodeMetadata[] };
interface BatchRow { id: string; fingerprint: string; quantity: number }

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
    && !/s2a_(?:invite|key|session)_/.test(value);
}
async function fingerprint(quantity: number, expiresAt: number): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(['registration-codes/v1', quantity, expiresAt]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function findBatch(database: D1Database, input: GenerateRegistrationCodesInput) {
  return prepare<BatchRow>(database,
    'SELECT id,fingerprint,quantity FROM registration_code_batches WHERE actor_id=? AND operation_id=?',
    [input.actorId, input.operationId]).first();
}
async function replay(database: D1Database, row: BatchRow, expected: string): Promise<RegistrationCodeBatchResult> {
  if (row.fingerprint !== expected) throw new ApiError('conflict');
  const codes = (await prepare<RegistrationCodeMetadata>(database,
    'SELECT id,display_prefix AS displayPrefix,ordinal,expires_at AS expiresAt FROM registration_codes WHERE operation_id=? ORDER BY ordinal',
    [row.id]).all()).rows;
  if (codes.length !== row.quantity || codes.some((code, ordinal) => code.ordinal !== ordinal)) throw new ApiError('internal_error');
  // Never regenerate/recover a secret on replay, even after an uncertain response.
  return { batchId: row.id, replayed: true, codes };
}

/** Atomic batch claim + generated hashes + O01 audit. No balances or secrets stored. */
export async function generateRegistrationCodes(database: D1Database, input: GenerateRegistrationCodesInput): Promise<RegistrationCodeBatchResult> {
  if (!validId(input.actorId) || !validId(input.operationId) || !Number.isSafeInteger(input.now) || input.now < 0
    || !Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > REGISTRATION_CODE_LIMITS.quantity
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt < 0) throw new ApiError('invalid_request');
  const actor = await prepare(database, "SELECT id FROM users WHERE id=? AND role='admin' AND status='active'", [input.actorId]).first();
  if (!actor) throw new ApiError('forbidden');
  const payloadFingerprint = await fingerprint(input.quantity, input.expiresAt);
  const existing = await findBatch(database, input);
  if (existing) return replay(database, existing, payloadFingerprint);
  // An expired retry may still read a committed batch above; only new issuance
  // requires a future expiry bounded by the maximum lifetime.
  if (input.expiresAt <= input.now || input.expiresAt - input.now > REGISTRATION_CODE_LIMITS.lifetimeMs) throw new ApiError('invalid_request');
  const batchId = crypto.randomUUID();
  const generated = await Promise.all(Array.from({ length: input.quantity }, async (_, ordinal) => {
    const token = generateToken('invitation');
    return { id: crypto.randomUUID(), ordinal, token, hash: await hashToken('invitation', token),
      displayPrefix: getTokenDisplayPrefix('invitation', token), expiresAt: input.expiresAt };
  }));
  try {
    await batch(database, [
      // This UNIQUE(actor_id, operation_id) insert is the serialization point.
      // Recheck actor permissions inside the same SQL transaction as issuance.
      prepare(database, `INSERT INTO registration_code_batches (id,actor_id,operation_id,fingerprint,quantity,expires_at,created_at)
        SELECT ?,id,?,?,?,?,? FROM users WHERE id=? AND role='admin' AND status='active'`,
        [batchId, input.operationId, payloadFingerprint, input.quantity, input.expiresAt, input.now, input.actorId]),
      prepare(database, 'SELECT CASE WHEN changes()=1 THEN 1 ELSE abs(-9223372036854775808) END AS actor_guard'),
      ...generated.map((code) => prepare(database, `INSERT INTO registration_codes
        (id,code_hash,display_prefix,expires_at,created_by,created_at,operation_id,ordinal) VALUES (?,?,?,?,?,?,?,?)`,
        [code.id, code.hash, code.displayPrefix, code.expiresAt, input.actorId, input.now, batchId, code.ordinal])),
      buildAuditStatement(database, {
        actor_id: input.actorId, action: 'registration_codes.generate', target_type: 'registration_code_batch',
        target_id: batchId, operation_id: batchId, created_at: input.now,
        changes: { quantity: input.quantity, expires_at: input.expiresAt },
      }),
    ]);
  } catch (error) {
    // A competing UNIQUE winner (or an uncertain successful commit) is read back.
    // If no batch committed, propagate the SQL error: never invent replay success.
    const committed = await findBatch(database, input);
    if (committed) return replay(database, committed, payloadFingerprint);
    const stillAuthorized = await prepare(database, "SELECT id FROM users WHERE id=? AND role='admin' AND status='active'", [input.actorId]).first();
    if (!stillAuthorized) throw new ApiError('forbidden');
    throw error;
  }
  return { batchId, replayed: false, codes: generated.map(({ hash: _hash, ...code }) => code) };
}

export interface ListRegistrationCodesInput {
  /** Any active site administrator may list all creators. */
  actorId: string;
  now: number;
  limit?: number;
  cursor?: string;
  createdBy?: string;
}
export type RegistrationCodeStatus = 'unused' | 'used' | 'expired' | 'revoked';
export interface RegistrationCodeListItem extends RegistrationCodeMetadata {
  batchId: string;
  createdBy: string;
  createdAt: number;
  usedBy: string | null;
  usedAt: number | null;
  revokedAt: number | null;
  status: RegistrationCodeStatus;
}
interface ListRow extends RegistrationCodeMetadata {
  batchId: string; createdBy: string; createdAt: number; usedBy: string | null; usedAt: number | null; revokedAt: number | null;
}
type Cursor = [version: 2, actorId: string, createdBy: string | null, snapshotAt: number, createdAt: number, id: string];

function encodeCursor(cursor: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decodeCursor(raw: string, actorId: string, createdBy: string | null, now: number): Cursor {
  try {
    if (raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const binary = atob(raw.replaceAll('-', '+').replaceAll('_', '/'));
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
    if (!Array.isArray(parsed) || parsed.length !== 6 || parsed[0] !== 2 || parsed[1] !== actorId || parsed[2] !== createdBy
      || !Number.isSafeInteger(parsed[3]) || parsed[3] < 0 || parsed[3] > now
      || !Number.isSafeInteger(parsed[4]) || parsed[4] < 0 || parsed[4] > parsed[3]
      || !validId(parsed[5])) throw new Error();
    const cursor = parsed as Cursor;
    if (encodeCursor(cursor) !== raw) throw new Error();
    return cursor;
  } catch { throw new ApiError('invalid_request'); }
}

/** Metadata only: explicit projection never selects a code hash or plaintext.
 * snapshotAt fixes the issuance ceiling and expiry clock, not a database snapshot;
 * usage/revocation metadata reflects committed state when each page is read.
 */
export async function listRegistrationCodes(database: D1Database, input: ListRegistrationCodesInput): Promise<{
  items: RegistrationCodeListItem[]; nextCursor: string | null; snapshotAt: number;
}> {
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  if (!validId(input.actorId) || !Number.isSafeInteger(input.now) || input.now < 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) throw new ApiError('invalid_request');
  const actor = await prepare(database, "SELECT id FROM users WHERE id=? AND role='admin' AND status='active'", [input.actorId]).first();
  if (!actor) throw new ApiError('forbidden');
  if (input.createdBy !== undefined && !validId(input.createdBy)) throw new ApiError('invalid_request');
  const createdBy = input.createdBy ?? null;
  const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor, input.actorId, createdBy, input.now);
  const snapshotAt = cursor?.[3] ?? input.now;
  const projection = 'id,display_prefix AS displayPrefix,ordinal,expires_at AS expiresAt,operation_id AS batchId,created_by AS createdBy,created_at AS createdAt,used_by AS usedBy,used_at AS usedAt,revoked_at AS revokedAt';
  const clauses = ['created_at<=?'];
  const params: DbValue[] = [snapshotAt];
  if (createdBy !== null) { clauses.push('created_by=?'); params.push(createdBy); }
  if (cursor) {
    clauses.push('(created_at<? OR (created_at=? AND id<?))');
    params.push(cursor[4], cursor[4], cursor[5]);
  }
  params.push(limit + 1);
  const page = await prepare<ListRow>(database, `SELECT ${projection} FROM registration_codes WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ?`, params).all();
  const selected = page.rows.slice(0, limit);
  const items = selected.map((row): RegistrationCodeListItem => ({ ...row,
    // Preserve all timestamps even when statuses overlap; revocation takes priority.
    status: row.revokedAt !== null ? 'revoked' : row.usedAt !== null ? 'used'
      : row.expiresAt !== null && row.expiresAt <= snapshotAt ? 'expired' : 'unused',
  }));
  const last = selected.at(-1);
  return { items, snapshotAt, nextCursor: page.rows.length > limit && last
    ? encodeCursor([2, input.actorId, createdBy, snapshotAt, last.createdAt, last.id]) : null };
}

export interface RevokeRegistrationCodeInput { actorId: string; codeId: string; operationId: string; now: number }
export interface RevokeRegistrationCodeResult {
  id: string;
  status: 'revoked' | 'already_revoked' | 'already_used' | 'not_found';
  revokedAt: number | null;
  usedBy: string | null;
  usedAt: number | null;
}
interface RevocationRow { createdAt: number; revokedAt: number | null; usedBy: string | null; usedAt: number | null }
function revocationState(database: D1Database, id: string) {
  return prepare<RevocationRow>(database,
    'SELECT created_at AS createdAt,revoked_at AS revokedAt,used_by AS usedBy,used_at AS usedAt FROM registration_codes WHERE id=?', [id]).first();
}
function terminalRevocation(id: string, row: RevocationRow | null): RevokeRegistrationCodeResult | undefined {
  if (!row) return { id, status: 'not_found', revokedAt: null, usedBy: null, usedAt: null };
  if (row.usedBy !== null || row.revokedAt !== null) return { id,
    status: row.usedBy !== null ? 'already_used' : 'already_revoked', revokedAt: row.revokedAt, usedBy: row.usedBy, usedAt: row.usedAt };
  return undefined;
}

/** Site admins may revoke any unused code. Terminal states never get another audit. */
export async function revokeRegistrationCode(database: D1Database, input: RevokeRegistrationCodeInput): Promise<RevokeRegistrationCodeResult> {
  if (!validId(input.actorId) || !validId(input.codeId) || !validId(input.operationId)
    || !Number.isSafeInteger(input.now) || input.now < 0) throw new ApiError('invalid_request');
  const authorized = () => prepare(database, "SELECT id FROM users WHERE id=? AND role='admin' AND status='active'", [input.actorId]).first();
  if (!await authorized()) throw new ApiError('forbidden');
  const before = await revocationState(database, input.codeId);
  const terminal = terminalRevocation(input.codeId, before);
  if (terminal) return terminal;
  if (input.now < before!.createdAt) throw new ApiError('invalid_request');
  try {
    await batch(database, [
      prepare(database, `UPDATE registration_codes SET revoked_at=? WHERE id=? AND revoked_at IS NULL AND used_by IS NULL
        AND EXISTS (SELECT 1 FROM users WHERE id=? AND role='admin' AND status='active')`, [input.now, input.codeId, input.actorId]),
      prepare(database, 'SELECT CASE WHEN changes()=1 THEN 1 ELSE abs(-9223372036854775808) END AS revocation_guard'),
      buildAuditStatement(database, { actor_id: input.actorId, action: 'registration_codes.revoke', target_type: 'registration_code',
        target_id: input.codeId, operation_id: input.operationId, created_at: input.now,
        changes: { revoked_at: { before: null, after: input.now } } }),
    ]);
  } catch (error) {
    if (!await authorized()) throw new ApiError('forbidden');
    const current = terminalRevocation(input.codeId, await revocationState(database, input.codeId));
    if (current) return current;
    // Unexpected zero updates are conflicts; assertion failure has already rolled
    // back the entire batch, so no orphan audit can remain.
    for (let cause = error, depth = 0; cause instanceof Error && depth < 4; cause = cause.cause, depth++) {
      if (cause.message.includes('integer overflow')) throw new ApiError('conflict');
    }
    throw error;
  }
  return { id: input.codeId, status: 'revoked', revokedAt: input.now, usedBy: null, usedAt: null };
}
