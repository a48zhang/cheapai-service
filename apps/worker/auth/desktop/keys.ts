import { ApiError } from '../../http';
import type { AuthenticatedDesktopSession } from './authenticate';
import { verifyToken } from '../tokens';
import { DESKTOP_KEY_MAX_TTL_MS } from './types';
import { decryptDesktopKey, encryptDesktopKey } from './key-cipher';
import type { DesktopKeyEncryptionKey, DesktopKeyring } from './key-cipher';
import { commitDesktopSessionKeyCreation, DesktopKeyError, findDesktopSessionKeyState, prepareDesktopSessionKeyCreation } from './key-repository';
import type { DesktopSessionKeyState } from './key-repository';

export { DesktopKeyError };
export type { DesktopKeyFailureReason } from './key-repository';

export interface DesktopCurrentKey {
  readonly keyId: string;
  readonly key: string;
  readonly expiresAt: number;
}

export type DesktopKeySessionIdentity = AuthenticatedDesktopSession['session'];

function validText(value: unknown, max = 128): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validateSessionState(
  state: DesktopSessionKeyState | null,
  identity: DesktopKeySessionIdentity,
  now: number,
): DesktopSessionKeyState {
  if (state === null || !validText(identity.id) || !validText(identity.user_id)
    || !time(identity.expires_at) || !time(state.created_at) || !time(state.expires_at)
    || state.expires_at <= state.created_at || !time(state.key_generation)
    || state.id !== identity.id || state.user_id !== identity.user_id || state.expires_at !== identity.expires_at
    || (state.revoked_at !== null && !time(state.revoked_at))) throw new DesktopKeyError('binding_unavailable');
  if (state.revoked_at !== null) throw new DesktopKeyError('session_revoked');
  if (state.expires_at <= now || state.created_at > now) throw new DesktopKeyError('session_expired');
  if (state.user_status !== 'active' || !time(state.user_created_at)) throw new DesktopKeyError('user_inactive');
  if (state.user_created_at > now) throw new DesktopKeyError('user_inactive');
  if (!validText(state.default_group_id) || state.default_group_status !== 'active'
    || !time(state.default_group_created_at) || state.default_group_created_at > now
    || state.authorized_default_group_id !== state.default_group_id) throw new DesktopKeyError('group_unavailable');

  if (state.current_key_id === null) {
    if (state.current_key_ciphertext !== null || state.key_id !== null || state.key_generation !== 0) {
      throw new DesktopKeyError('binding_unavailable');
    }
  } else if (!validText(state.current_key_id) || typeof state.current_key_ciphertext !== 'string'
    || state.current_key_ciphertext.length === 0 || state.key_id !== state.current_key_id || state.key_generation < 1) {
    throw new DesktopKeyError('binding_unavailable');
  }
  return state;
}

async function readCurrentKey(
  state: DesktopSessionKeyState,
  keyring: DesktopKeyring,
): Promise<DesktopCurrentKey | null> {
  if (state.current_key_id === null) return null;
  if (state.key_user_id !== state.user_id || state.key_desktop_session_id !== state.id || state.key_kind !== 'api'
    || !validText(state.key_group_id) || !time(state.key_created_at) || !time(state.key_updated_at)
    || state.key_updated_at < state.key_created_at || !time(state.key_version) || state.key_version < 1
    || !time(state.key_expires_at) || state.key_expires_at <= state.key_created_at || state.key_expires_at > state.expires_at
    || typeof state.key_hash !== 'string' || !/^[0-9a-f]{64}$/.test(state.key_hash)) {
    throw new DesktopKeyError('binding_unavailable');
  }
  if (state.key_group_status !== 'active' || state.authorized_key_group_id !== state.key_group_id) {
    throw new DesktopKeyError('group_unavailable');
  }
  if (state.key_status === 'revoked') throw new DesktopKeyError('key_revoked');
  if (state.key_status !== 'active') throw new DesktopKeyError('binding_unavailable');

  try {
    const key = await decryptDesktopKey(state.current_key_ciphertext!, state.id, state.current_key_id, keyring);
    if (!await verifyToken('apiKey', key, state.key_hash)) throw new DesktopKeyError('binding_unavailable');
    return { keyId: state.current_key_id, key, expiresAt: state.key_expires_at };
  } catch (error) {
    if (error instanceof DesktopKeyError) throw error;
    throw new DesktopKeyError('binding_unavailable');
  }
}

function nextExpiry(now: number, sessionExpiresAt: number): number {
  const remaining = sessionExpiresAt - now;
  return remaining <= DESKTOP_KEY_MAX_TTL_MS ? sessionExpiresAt : now + DESKTOP_KEY_MAX_TTL_MS;
}

/** Return the same live API Key for this session, or atomically create/rotate one. */
export async function getOrCreateCurrentKey(
  database: D1Database,
  session: DesktopKeySessionIdentity,
  now: number,
  activeKey: DesktopKeyEncryptionKey,
  keyring: DesktopKeyring,
): Promise<DesktopCurrentKey> {
  if (!time(now)) throw new ApiError('service_unavailable');
  try {
    const state = validateSessionState(await findDesktopSessionKeyState(database, session.id), session, now);
    const current = await readCurrentKey(state, keyring);
    if (current !== null && current.expiresAt > now) return current;

    const expiresAt = nextExpiry(now, state.expires_at);
    if (expiresAt <= now) throw new DesktopKeyError('session_expired');
    const creation = await prepareDesktopSessionKeyCreation(database, state, now, expiresAt);
    const ciphertext = await encryptDesktopKey(creation.candidate.token, state.id, creation.candidate.id, activeKey);
    const committed = await commitDesktopSessionKeyCreation(database, state, now, creation, ciphertext);
    if (committed.kind === 'committed') {
      return { keyId: creation.candidate.id, key: creation.candidate.token, expiresAt };
    }

    // A concurrent request may have won the same generation. Read its stored
    // binding and return that exact credential rather than issuing another.
    const winnerState = validateSessionState(await findDesktopSessionKeyState(database, state.id), session, now);
    const winner = await readCurrentKey(winnerState, keyring);
    if (winner !== null && winner.expiresAt > now) return winner;
    throw new DesktopKeyError('key_creation_unavailable');
  } catch (error) {
    if (error instanceof DesktopKeyError) throw error;
    throw new ApiError('service_unavailable', { cause: error });
  }
}
