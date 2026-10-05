import { DEFAULT_CONFIG } from '../config';
import { batch, prepare } from '../db';
import { ApiError } from '../http';
import { normalizeEmail } from '../auth/email-proof';
import { hashPassword, validatePasswordInput } from '../auth/password';
import { readDefaultGroupId } from '../auth/registration-settings';
import type { PublicUser } from '../auth/users';
import { buildAuditStatement } from './audit';

export interface CreateUserInput { email: string; password: string; groupId?: string }
export interface CreateUserContext { actorId: string; operationId: string; now: number }

function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value)) {
    throw new ApiError('invalid_request');
  }
  return value;
}

/** A05 authorizes the route; this use case rechecks the actor inside its transaction.
 * Only email/password/group are accepted. Role, starting balance, status and source
 * are fixed by server SQL, never selected by request properties.
 */
export async function createUser(database: D1Database, input: CreateUserInput, context: CreateUserContext): Promise<PublicUser> {
  if (input === null || typeof input !== 'object' || Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) throw new ApiError('invalid_request');
  const fields: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !['email', 'password', 'groupId'].includes(key) ||
        !descriptor || !('value' in descriptor) || descriptor.value === undefined) throw new ApiError('invalid_request');
    fields[key] = descriptor.value;
  }
  let email: string;
  try { email = normalizeEmail(fields.email as string); } catch { throw new ApiError('invalid_request'); }
  if (!validatePasswordInput(fields.password).valid) throw new ApiError('invalid_request');
  const password = fields.password as string;
  const actorId = identifier(context.actorId);
  const operationId = identifier(context.operationId);
  const now = context.now;
  if (!Number.isSafeInteger(now) || now < 0) throw new ApiError('invalid_request');
  const selectedGroup = fields.groupId === undefined ? undefined : identifier(fields.groupId);
  const id = crypto.randomUUID();
  try {
    const actorSql = `SELECT u.id FROM users u JOIN groups g ON g.id=u.group_id
      WHERE u.id=? AND u.role='admin' AND u.status='active' AND g.status='active'`;
    if (!await prepare(database, actorSql, [actorId]).first()) throw new ApiError('forbidden');
    const groupId = selectedGroup ?? await readDefaultGroupId(database);
    if (!groupId || !await prepare(database, "SELECT id FROM groups WHERE id=? AND status='active'", [groupId]).first()) {
      throw new ApiError('invalid_request');
    }
    if (await prepare(database, 'SELECT id FROM users WHERE email_normalized=?', [email]).first()) throw new ApiError('conflict');
    const audit = buildAuditStatement(database, {
      actor_id: actorId, operation_id: operationId, created_at: now,
      action: 'user.create', target_type: 'user', target_id: id,
      changes: { role: 'user', status: 'active', group_id: groupId, balance_units: 0, password_changed: true },
    });
    // Includes PasswordBusyError: overload is a safe 503, never a partial user.
    const passwordHash = await hashPassword(password);
    const results = await batch(database, [
      // SQL assertion failures abort the whole batch, unlike a zero-row write.
      prepare(database, `SELECT CASE WHEN EXISTS (${actorSql}) THEN 1
        ELSE json_extract('{}', 'create_user_actor_forbidden') END`, [actorId]),
      prepare(database, `SELECT CASE WHEN EXISTS (SELECT id FROM groups WHERE id=? AND status='active') THEN 1
        ELSE json_extract('{}', 'create_user_group_inactive') END`, [groupId]),
      prepare<PublicUser>(database, `INSERT INTO users
        (id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
        VALUES (?,?,?,'user','active',?,0,?,?,'admin',?,?)
        RETURNING id,email_normalized,role,status,group_id,'active' AS group_status,
          CAST(balance_units AS TEXT) AS balance_units,email_verified_at`,
      [id, email, passwordHash, groupId, DEFAULT_CONFIG.defaultUserConcurrency, DEFAULT_CONFIG.defaultUserRpm, now, now]),
      audit,
    ] as const);
    const user = results[2].rows[0];
    if (!user) throw new ApiError('service_unavailable');
    return user;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error) {
      if (error.message.includes('create_user_actor_forbidden')) throw new ApiError('forbidden');
      if (error.message.includes('create_user_group_inactive')) throw new ApiError('invalid_request');
      if (error.message.includes('UNIQUE constraint failed: users.email_normalized')) throw new ApiError('conflict');
    }
    throw new ApiError('service_unavailable', { cause: error });
  }
}
