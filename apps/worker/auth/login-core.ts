import { ApiError } from '../http';
import { beginLoginAttempt } from '../limits/auth-rate-limit';
import type { AuthGateNamespace, AuthRateConfig } from '../limits/auth-rate-limit';
import { normalizeEmail } from './email-proof';
import { verifyPassword } from './password';
import { findInternalAuthUserByEmail } from './users';
import type { InternalAuthUser, PublicUser } from './users';

export interface LoginCoreDependencies {
  database: D1Database;
  gates: AuthGateNamespace;
  now(): number;
  rateConfig?: AuthRateConfig;
}

export interface LoginInput { email: string; password: string }

/** Credential storage is selected by the caller. A failed `issue` must leave no
 * usable credential behind; `revoke` cleans only the exact returned credential,
 * scoped to the verified user.
 */
export interface LoginCredentialIssuer<Credential> {
  issue(userId: string, now: number): Promise<Credential>;
  revoke(userId: string, credential: Credential, now: number): Promise<void>;
}

export interface LoginCoreResult<Credential> {
  user: PublicUser;
  credential: Credential;
}

export class LoginRateError extends ApiError {
  constructor(readonly retryAfterMs: number) { super('rate_limited'); }
}

function parseInput(input: unknown): LoginInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
      || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
      || Reflect.ownKeys(input).length !== 2) throw new ApiError('invalid_request');
  for (const key of Reflect.ownKeys(input)) {
    if (key !== 'email' && key !== 'password') throw new ApiError('invalid_request');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor)) throw new ApiError('invalid_request');
  }
  const values = input as Record<string, unknown>;
  if (typeof values.email !== 'string' || typeof values.password !== 'string' || values.password.length > 256) {
    throw new ApiError('invalid_request');
  }
  try { return { email: normalizeEmail(values.email), password: values.password }; }
  catch { throw new ApiError('invalid_request'); }
}

function active(user: InternalAuthUser | null): user is InternalAuthUser {
  return user !== null && user.status === 'active' && user.group_status === 'active';
}

function sameIdentity(before: InternalAuthUser, current: InternalAuthUser | null): current is InternalAuthUser {
  return active(current) && current.id === before.id && current.email_normalized === before.email_normalized
    && current.password_hash === before.password_hash && current.role === before.role && current.group_id === before.group_id;
}

function publicUser(user: InternalAuthUser): PublicUser {
  return { id: user.id, email_normalized: user.email_normalized, role: user.role, status: user.status,
    group_id: user.group_id, group_status: user.group_status, balance_units: user.balance_units,
    email_verified_at: user.email_verified_at };
}

function clock(dependencies: LoginCoreDependencies): number {
  const now = dependencies.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new ApiError('service_unavailable');
  return now;
}

/** Shared account-password verification. `trustedIp` and dependencies come from
 * server context, never request JSON. The caller owns HTTP, CSRF and credential
 * transport. This returns uniform credential errors, not a constant-time lookup.
 */
export async function loginWithCredential<Credential>(
  dependencies: LoginCoreDependencies,
  input: unknown,
  trustedIp: string,
  issuer: LoginCredentialIssuer<Credential>,
): Promise<LoginCoreResult<Credential>> {
  const credentials = parseInput(input);
  try {
    const admission = await beginLoginAttempt(dependencies.gates,
      { email: credentials.email, trustedIp }, dependencies.rateConfig);
    if (!admission.allowed) throw new LoginRateError(admission.retryAfterMs);

    const original = await findInternalAuthUserByEmail(dependencies.database, credentials.email);
    if (!active(original)) {
      await admission.recordFailure();
      throw new ApiError('unauthorized');
    }

    // Do not catch KDF overload/runtime errors here: they are service failures,
    // not incorrect credentials, and must never increment account failures.
    if (!await verifyPassword(credentials.password, original.password_hash)) {
      await admission.recordFailure();
      throw new ApiError('unauthorized');
    }

    const verified = await findInternalAuthUserByEmail(dependencies.database, credentials.email);
    if (!sameIdentity(original, verified)) throw new ApiError('unauthorized');

    const credential = await issuer.issue(verified.id, clock(dependencies));
    let current: InternalAuthUser | null;
    try {
      // Credential creation itself should atomically check user.active. This
      // final read also covers role/group/password changes in the async gap.
      current = await findInternalAuthUserByEmail(dependencies.database, credentials.email);
      if (!sameIdentity(verified, current)) throw new ApiError('unauthorized');
    } catch (error) {
      // Never return the new credential if revalidation fails. Revoke only the
      // credential just issued; even failed cleanup cannot disclose its secret.
      await issuer.revoke(verified.id, credential, clock(dependencies));
      throw error;
    }
    return { user: publicUser(current), credential };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // Includes PasswordBusyError and native D1/DO/crypto failures. No raw error,
    // hash, user-existence detail or credential is exposed through this boundary.
    throw new ApiError('service_unavailable');
  }
}
