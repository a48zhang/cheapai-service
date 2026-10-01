import { DEFAULT_CONFIG } from '../config';
import type { RuntimeConfig } from '../config';
import { prepare } from '../db';
import { createSession, findActiveSessionByHash } from './session-repository';
import type { StoredSession } from './session-repository';
import { generateToken, getTokenDisplayPrefix, hashToken } from './tokens';

export const SESSION_COOKIE_NAME = '__Host-sub2api_session';
export const MIN_SESSION_TTL_MS = 60_000;
export const MAX_SESSION_TTL_MS = 30 * 86_400_000;
const cookieAttributes = 'Path=/; Secure; HttpOnly; SameSite=Lax';

export interface CookieSession {
  /** Internal record; route code chooses its public response separately. */
  session: StoredSession;
  /** The raw credential is returned only here for the Set-Cookie header. */
  setCookie: string;
}

function requireTime(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) {
    throw new TypeError('Invalid session timestamp.');
  }
}

function cookieToken(header: string | null): string | null {
  if (header === null || typeof header !== 'string' || header.length > 16_384) return null;
  let token: string | null = null;
  let matches = 0;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    const name = (separator === -1 ? part : part.slice(0, separator)).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    matches++;
    if (matches > 1) return null;
    token = separator === -1 ? '' : part.slice(separator + 1).trim();
  }
  if (token === null) return null;
  try {
    // Reuse F13's canonical purpose-specific validation; never URI-decode cookies.
    getTokenDisplayPrefix('session', token);
    return token;
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

/** Each successful login creates fresh random token/ID; no input token is reused.
 * Seven-day fixed default, with bounded runtime-config overrides and no sliding expiry.
 */
export async function createCookieSession(
  database: D1Database,
  userId: string,
  now: number,
  config: Pick<RuntimeConfig, 'sessionTtlMs'> = DEFAULT_CONFIG,
): Promise<CookieSession> {
  requireTime(now);
  const ttl = config.sessionTtlMs;
  if (!Number.isSafeInteger(ttl) || ttl < MIN_SESSION_TTL_MS || ttl > MAX_SESSION_TTL_MS) {
    throw new TypeError('Session TTL must be between one minute and thirty days.');
  }
  const expiresAt = now + ttl;
  requireTime(expiresAt);
  const token = generateToken('session');
  const tokenHash = await hashToken('session', token);
  const session = await createSession(database, { id: crypto.randomUUID(), userId, tokenHash, expiresAt }, now);
  // No cookie is returned if the active-user conditional insert or uniqueness check fails.
  return {
    session,
    setCookie: `${SESSION_COOKIE_NAME}=${token}; ${cookieAttributes}; Max-Age=${Math.floor(ttl / 1000)}; Expires=${new Date(expiresAt).toUTCString()}`,
  };
}

/** Invalid or duplicate credentials fail before any database operation. */
export async function readCookieSession(database: D1Database, cookieHeader: string | null, now: number): Promise<StoredSession | null> {
  requireTime(now);
  const token = cookieToken(cookieHeader);
  if (token === null) return null;
  return findActiveSessionByHash(database, await hashToken('session', token), now);
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; ${cookieAttributes}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/** Revoke by possession of the validated raw token, even if expired or user-disabled.
 * A database failure propagates: callers must not report a successful server logout.
 */
export async function revokeCookieSession(database: D1Database, cookieHeader: string | null, now: number): Promise<string> {
  requireTime(now);
  const token = cookieToken(cookieHeader);
  if (token !== null) {
    await prepare(database,
      'UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
      [now, await hashToken('session', token)]).run();
  }
  return clearSessionCookie();
}
