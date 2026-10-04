/** Desktop access tokens are independent of browser Cookie sessions. */
export const DESKTOP_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const DESKTOP_KEY_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Private D1 projection. Never serialize this row as an HTTP response; the
 * token hash and encrypted current Key are server-side persistence details.
 */
export interface StoredDesktopSession {
  id: string;
  token_hash: string;
  user_id: string;
  expires_at: number;
  revoked_at: number | null;
  current_key_id: string | null;
  current_key_ciphertext: string | null;
  key_generation: number;
  created_at: number;
}

/** Machine-readable outcomes for desktop session authentication. Transient
 * storage/crypto/network failures use the existing service_unavailable/API
 * error path rather than being mislabeled as an invalid or expired token.
 */
export type DesktopSessionFailureReason =
  | 'invalid_token'
  | 'session_expired'
  | 'session_revoked'
  | 'user_inactive'
  | 'group_unavailable';
