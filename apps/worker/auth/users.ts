import { prepare } from '../db';

export interface PublicUser {
  id: string;
  email_normalized: string;
  role: 'user' | 'admin';
  status: 'active' | 'disabled';
  group_id: string;
  group_status: 'active' | 'disabled';
  balance_units: string;
  email_verified_at: number | null;
}

export interface InternalAuthUser extends PublicUser {
  /** Internal password verification only. Non-enumerable to prevent accidental JSON exposure. */
  readonly password_hash: string;
}

export interface UserIdentityScope {
  /** Must come from trusted authentication context, never a query/body parameter. */
  readonly userId: string;
}

const publicColumns = `u.id, u.email_normalized, u.role, u.status, u.group_id,
  g.status AS group_status, CAST(u.balance_units AS TEXT) AS balance_units, u.email_verified_at`;

function validateNormalizedEmail(email: string): void {
  // This is an input precondition, not the registration normalization policy.
  // A13 owns canonicalization. Do not silently trim, lowercase, or rewrite here.
  if (typeof email !== 'string' || email.length > 254 || email !== email.toLowerCase() ||
      /[\u0000-\u001f\u007f]/.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new TypeError('Expected a normalized email address.');
  }
}

function validateUserId(userId: string): void {
  if (typeof userId !== 'string' || !userId.trim() || /[\u0000-\u001f\u007f]/.test(userId)) {
    throw new TypeError('Expected a user identity.');
  }
}

/** Internal credential lookup only; callers must separately verify the password
 * and enforce user/group status. Disabled rows intentionally remain distinguishable.
 */
export async function findInternalAuthUserByEmail(
  database: D1Database,
  normalizedEmail: string,
): Promise<InternalAuthUser | null> {
  validateNormalizedEmail(normalizedEmail);
  const row = await prepare<InternalAuthUser>(database,
    `SELECT ${publicColumns}, u.password_hash FROM users u
     JOIN groups g ON g.id = u.group_id WHERE u.email_normalized = ?`, [normalizedEmail]).first();
  if (row === null) return null;
  const { password_hash, ...publicFields } = row;
  return Object.defineProperty(publicFields, 'password_hash', {
    value: password_hash, enumerable: false, writable: false, configurable: false,
  }) as InternalAuthUser;
}

/** Self-service lookup only: both requested ID and authenticated ID constrain SQL.
 * This is not an administrator lookup and does not grant privilege from a role flag.
 */
export async function findPublicUserById(
  database: D1Database,
  requestedUserId: string,
  identity: UserIdentityScope,
): Promise<PublicUser | null> {
  validateUserId(requestedUserId);
  validateUserId(identity.userId);
  return prepare<PublicUser>(database,
    `SELECT ${publicColumns} FROM users u JOIN groups g ON g.id = u.group_id
     WHERE u.id = ? AND u.id = ?`, [requestedUserId, identity.userId]).first();
}
