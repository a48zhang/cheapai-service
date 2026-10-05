export const TOKEN_SECRET_BYTES = 32;
export const TOKEN_PREFIXES = Object.freeze({
  apiKey: 's2a_key_',
  session: 's2a_session_',
  desktopSession: 's2a_desktop_',
  invitation: 's2a_invite_',
});
export type TokenKind = keyof typeof TOKEN_PREFIXES;

// Exactly 32 bytes in canonical, unpadded base64url (last two pad bits zero).
const SECRET_ENCODING = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const HASH_ENCODING = /^[a-f0-9]{64}$/;

function prefixFor(kind: TokenKind): string {
  if (typeof kind !== 'string' || !Object.hasOwn(TOKEN_PREFIXES, kind)) {
    throw new TypeError('Invalid token kind');
  }
  return TOKEN_PREFIXES[kind];
}

function isValidToken(prefix: string, token: unknown): token is string {
  return typeof token === 'string'
    && token.length === prefix.length + 43
    && token.startsWith(prefix)
    && SECRET_ENCODING.test(token.slice(prefix.length));
}

export class TokenFormatError extends TypeError {}

function requireToken(kind: TokenKind, token: unknown): string {
  const prefix = prefixFor(kind);
  if (!isValidToken(prefix, token)) throw new TokenFormatError('Invalid token format');
  return token;
}

/** Generate 256 random bits with Web Crypto; never use this for numeric email codes. */
export function generateToken(kind: TokenKind): string {
  const prefix = prefixFor(kind);
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_SECRET_BYTES));
  const secret = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return prefix + secret;
}

/** SHA-256 of the entire ASCII token, including its purpose prefix. Not a password KDF. */
export async function hashToken(kind: TokenKind, token: string): Promise<string> {
  const input = new TextEncoder().encode(requireToken(kind, token));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Public identification metadata only; never use it for authentication or uniqueness. */
export function getTokenDisplayPrefix(kind: TokenKind, token: string): string {
  const validated = requireToken(kind, token);
  // Expose 8 of 43 secret characters; more than 200 secret bits remain undisclosed.
  return validated.slice(0, TOKEN_PREFIXES[kind].length + 8);
}

function decodeHash(hash: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hash.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Malformed credentials fail closed. Crypto/runtime errors propagate to the caller. */
export async function verifyToken(kind: TokenKind, token: unknown, expectedHash: unknown): Promise<boolean> {
  const prefix = prefixFor(kind);
  if (!isValidToken(prefix, token) || typeof expectedHash !== 'string'
    || expectedHash.length !== 64 || !HASH_ENCODING.test(expectedHash)) {
    return false;
  }
  const actualHash = await hashToken(kind, token);
  // Workers' native Web Crypto extension compares equal-length buffers safely.
  return crypto.subtle.timingSafeEqual(decodeHash(actualHash), decodeHash(expectedHash));
}
