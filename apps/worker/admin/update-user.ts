import { batch, prepare } from '../db';
import { ApiError } from '../http';
import { parseConcurrencyLimit, parseRpmLimit } from '../config';
import type { PublicUser } from '../auth/users';
import { buildAuditStatement } from './audit';
import { validateGroupSelection } from '../auth/key-groups';

export interface UpdateUserPatch { status?: 'active' | 'disabled'; groupId?: string; concurrencyLimit?: number | null; rpmLimit?: number | null; allowedGroupIds?: readonly string[] }
export interface UpdateUserContext { actorId: string; operationId: string; now: number }
export interface UpdatedUser extends PublicUser { concurrency_limit: number; rpm_limit: number; version: number; updated_at: number }
const actorSql = `SELECT u.id FROM users u JOIN groups g ON g.id=u.group_id
  WHERE u.id=? AND u.role='admin' AND u.status='active' AND g.status='active'`;
function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value) && value.trim() === value;
}
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }

/** No role/password/balance writes. Guard, CAS and audit all commit in one batch. */
export async function updateUser(database: D1Database, userId: string, expectedVersion: number,
  patch: UpdateUserPatch, context: UpdateUserContext): Promise<UpdatedUser> {
  if (!validId(userId) || !validId(context.actorId) || !validId(context.operationId)
    || !positive(expectedVersion) || expectedVersion >= Number.MAX_SAFE_INTEGER
    || !Number.isSafeInteger(context.now) || context.now < 0) throw new ApiError('invalid_request');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(patch))) throw new ApiError('invalid_request');
  const fields: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(patch)) {
    const descriptor = Object.getOwnPropertyDescriptor(patch, key);
    if (typeof key !== 'string' || !['status', 'groupId', 'concurrencyLimit', 'rpmLimit', 'allowedGroupIds'].includes(key)
      || !descriptor || !('value' in descriptor)) throw new ApiError('invalid_request');
    const value: unknown = descriptor.value;
    if (key === 'concurrencyLimit') { try { fields[key] = parseConcurrencyLimit(value); } catch { throw new ApiError('invalid_request'); } continue; }
    if (key === 'rpmLimit') { try { fields[key] = parseRpmLimit(value); } catch { throw new ApiError('invalid_request'); } continue; }
    if (key === 'allowedGroupIds') { fields[key] = validateGroupSelection(value); continue; }
    if (key === 'status' ? value !== 'active' && value !== 'disabled' : key === 'groupId' ? !validId(value) : !positive(value)) throw new ApiError('invalid_request');
    fields[key] = value;
  }
  if (Object.keys(fields).length === 0) throw new ApiError('invalid_request');
  try {
    if (!await prepare(database, actorSql, [context.actorId]).first()) throw new ApiError('forbidden');
    const before = await prepare<UpdatedUser>(database, `SELECT u.id,u.email_normalized,u.role,u.status,u.group_id,g.status AS group_status,
      CAST(u.balance_units AS TEXT) AS balance_units,u.email_verified_at,u.concurrency_limit,u.rpm_limit,u.version,u.updated_at
      FROM users u JOIN groups g ON g.id=u.group_id WHERE u.id=?`, [userId]).first();
    if (!before) throw new ApiError('not_found');
    if (before.version !== expectedVersion || before.updated_at > context.now) throw new ApiError('conflict');
    const after = { status: fields.status as UpdatedUser['status'] | undefined ?? before.status,
      group_id: fields.groupId as string | undefined ?? before.group_id,
      concurrency_limit: fields.concurrencyLimit as number | undefined ?? before.concurrency_limit,
      rpm_limit: fields.rpmLimit as number | undefined ?? before.rpm_limit, version: expectedVersion + 1 };
    const beforeGrants = (await prepare<{ group_id: string }>(database,
      'SELECT group_id FROM user_group_access WHERE user_id=? ORDER BY group_id', [userId]).all()).rows.map(row => row.group_id);
    const replaceGrants = Object.hasOwn(fields, 'allowedGroupIds') || Object.hasOwn(fields, 'groupId');
    const grants = fields.allowedGroupIds as string[] | undefined ?? (Object.hasOwn(fields,'groupId') ? [after.group_id] : beforeGrants);
    if (!grants.includes(after.group_id)) throw new ApiError('invalid_request');
    const grantStatements = replaceGrants ? [
      prepare(database, `SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM json_each(?) requested WHERE NOT EXISTS(SELECT 1 FROM groups g
          WHERE g.id=requested.value AND (g.status='active' OR EXISTS(SELECT 1 FROM user_group_access a WHERE a.group_id=g.id AND a.user_id=?)))
      ) THEN 1 ELSE json_extract('{}','update_user_group_inactive') END`, [JSON.stringify(grants),userId]),
      prepare(database,'DELETE FROM user_group_access WHERE user_id=?',[userId]),
      prepare(database,'INSERT INTO user_group_access(user_id,group_id,created_at) SELECT ?,value,? FROM json_each(?)',[userId,context.now,JSON.stringify(grants)]),
    ] : [];
    const audit = buildAuditStatement(database, { actor_id: context.actorId, operation_id: context.operationId,
      target_type: 'user', target_id: userId, action: 'user.update', created_at: context.now,
      changes: { before: { status: before.status, group_id: before.group_id, concurrency_limit: before.concurrency_limit,
        rpm_limit: before.rpm_limit, version: before.version, ...(replaceGrants ? { allowed_group_ids: beforeGrants } : {}) }, after: { ...after, ...(replaceGrants ? { allowed_group_ids: grants } : {}) } } });
    const results = await batch(database, [
      prepare(database, `SELECT CASE WHEN EXISTS (${actorSql}) THEN 1 ELSE json_extract('{}','update_user_actor_forbidden') END`, [context.actorId]),
      prepare(database, "SELECT CASE WHEN EXISTS (SELECT id FROM groups WHERE id=? AND (status='active' OR ?=1)) THEN 1 ELSE json_extract('{}','update_user_group_inactive') END",
        [after.group_id, Number(after.group_id === before.group_id && after.status === before.status)]),
      // Count usable administrators in authoritative state INSIDE the transaction.
      // Concurrent attempts cannot both deactivate the final two administrators.
      prepare(database, `SELECT CASE WHEN ?='disabled'
        AND EXISTS (SELECT 1 FROM users u JOIN groups g ON g.id=u.group_id WHERE u.id=? AND u.role='admin' AND u.status='active' AND g.status='active')
        AND NOT EXISTS (SELECT 1 FROM users u JOIN groups g ON g.id=u.group_id WHERE u.id<>? AND u.role='admin' AND u.status='active' AND g.status='active')
        THEN json_extract('{}','update_user_last_admin') ELSE 1 END`, [after.status, userId, userId]),
      prepare<UpdatedUser>(database, `UPDATE users SET status=?,group_id=?,concurrency_limit=?,rpm_limit=?,version=version+1,updated_at=?
        WHERE id=? AND version=? AND updated_at<=? RETURNING id,email_normalized,role,status,group_id,(SELECT status FROM groups WHERE groups.id=users.group_id) AS group_status,
        CAST(balance_units AS TEXT) AS balance_units,email_verified_at,concurrency_limit,rpm_limit,version,updated_at`,
        [after.status, after.group_id, after.concurrency_limit, after.rpm_limit, context.now, userId, expectedVersion, context.now]),
      prepare(database, "SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('{}','update_user_conflict') END"),
      ...grantStatements,
      audit,
    ] as const);
    if (results[3].rows.length !== 1) throw new ApiError('service_unavailable');
    return results[3].rows[0]!;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    for (let cause = error, depth = 0; cause instanceof Error && depth < 4; cause = cause.cause, depth++) {
      if (cause.message.includes('update_user_actor_forbidden')) throw new ApiError('forbidden');
      if (cause.message.includes('update_user_group_inactive')) throw new ApiError('invalid_request');
      if (cause.message.includes('update_user_last_admin') || cause.message.includes('update_user_conflict')) throw new ApiError('conflict');
    }
    throw new ApiError('service_unavailable', { cause: error });
  }
}
