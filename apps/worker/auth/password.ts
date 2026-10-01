import { argon2idAsync } from '@noble/hashes/argon2.js';

/** OWASP minimum Argon2id profile; changing it requires an explicit format migration. */
export const PASSWORD_HASH_PROFILE = Object.freeze({
  algorithm: 'argon2id', version: 19,
  memoryKiB: 19_456, iterations: 2, parallelism: 1,
  saltBytes: 16, hashBytes: 32,
});

export const PASSWORD_INPUT_LIMITS = Object.freeze({
  minCharacters: 6, maxCharacters: 128, maxUtf8Bytes: 512,
});

/** Per-isolate budget only; no distributed limit and no waiting queue. */
export const PASSWORD_KDF_CONCURRENCY = 1;
let activeKdfs = 0;

/** HTTP callers may map this transient overload to 503 without exposing secrets. */
export class PasswordBusyError extends Error {
  readonly code = 'PASSWORD_BUSY';
  constructor() {
    super('Password hashing is busy');
    this.name = 'PasswordBusyError';
  }
}
export type PasswordInputValidation =
  | { valid: true; characters: number; utf8Bytes: number }
  | { valid: false; reason: 'invalid_type' | 'invalid_unicode' | 'too_short' | 'too_long' | 'too_many_bytes' };

/** Count Unicode scalar values, not UTF-16 units or grapheme clusters. Never normalize. */
export function validatePasswordInput(password: unknown): PasswordInputValidation {
  if (typeof password !== 'string') return { valid: false, reason: 'invalid_type' };
  // Each scalar occupies at most two UTF-16 units; reject giant inputs before scanning.
  if (password.length > PASSWORD_INPUT_LIMITS.maxCharacters * 2) return { valid: false, reason: 'too_long' };
  let characters = 0;
  let utf8Bytes = 0;
  for (const character of password) {
    const point = character.codePointAt(0)!;
    // TextEncoder replaces lone surrogates, creating password aliases; reject them.
    if (point >= 0xd800 && point <= 0xdfff) return { valid: false, reason: 'invalid_unicode' };
    characters++;
    utf8Bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (characters > PASSWORD_INPUT_LIMITS.maxCharacters) return { valid: false, reason: 'too_long' };
    if (utf8Bytes > PASSWORD_INPUT_LIMITS.maxUtf8Bytes) return { valid: false, reason: 'too_many_bytes' };
  }
  if (characters < PASSWORD_INPUT_LIMITS.minCharacters) return { valid: false, reason: 'too_short' };
  return { valid: true, characters, utf8Bytes };
}

const PHC_PREFIX = '$argon2id$v=19$m=19456,t=2,p=1$';
const PHC_LENGTH = PHC_PREFIX.length + 22 + 1 + 43;

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/=+$/, '');
}

function decodeBase64(encoded: string, byteLength: number): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+$/.test(encoded)) return null;
  try {
    const binary = atob(encoded + '='.repeat((4 - encoded.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    // Reject aliases with nonzero pad bits, not merely decodable base64.
    return bytes.length === byteLength && encodeBase64(bytes) === encoded ? bytes : null;
  } catch {
    return null;
  }
}

function parseHash(encoded: unknown): { salt: Uint8Array; hash: Uint8Array } | null {
  if (typeof encoded !== 'string' || encoded.length !== PHC_LENGTH || !encoded.startsWith(PHC_PREFIX)) return null;
  // This version supports exactly one reviewed profile. Never allocate memory from
  // untrusted PHC work factors; unknown versions/profiles fail closed before KDF.
  const fields = encoded.slice(PHC_PREFIX.length).split('$');
  if (fields.length !== 2 || fields[0]?.length !== 22 || fields[1]?.length !== 43) return null;
  const salt = decodeBase64(fields[0], PASSWORD_HASH_PROFILE.saltBytes);
  const hash = decodeBase64(fields[1], PASSWORD_HASH_PROFILE.hashBytes);
  return salt && hash ? { salt, hash } : null;
}

async function derive(password: string, salt: Uint8Array): Promise<Uint8Array> {
  if (activeKdfs >= PASSWORD_KDF_CONCURRENCY) throw new PasswordBusyError();
  activeKdfs++;
  let passwordBytes: Uint8Array | undefined;
  try {
    passwordBytes = new TextEncoder().encode(password);
    return await argon2idAsync(passwordBytes, salt, {
      version: PASSWORD_HASH_PROFILE.version,
      m: PASSWORD_HASH_PROFILE.memoryKiB,
      t: PASSWORD_HASH_PROFILE.iterations,
      p: PASSWORD_HASH_PROFILE.parallelism,
      dkLen: PASSWORD_HASH_PROFILE.hashBytes,
      maxmem: PASSWORD_HASH_PROFILE.memoryKiB * 1024,
      asyncTick: 10,
    });
  } finally {
    // Keep the slot across the awaited KDF, releasing on success and rejection.
    activeKdfs--;
    passwordBytes?.fill(0);
  }
}

/** PHC-encoded Argon2id with an independent CSPRNG salt. No persistence or logging. */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string') throw new TypeError('Password must be a string');
  const validation = validatePasswordInput(password);
  if (!validation.valid) throw new RangeError(`Invalid password input: ${validation.reason}`);
  const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_HASH_PROFILE.saltBytes));
  const hash = await derive(password, salt);
  try {
    return PHC_PREFIX + encodeBase64(salt) + '$' + encodeBase64(hash);
  } finally {
    hash.fill(0);
  }
}

/** Wrong credentials/formats return false; KDF/runtime failures propagate. */
export async function verifyPassword(password: unknown, encoded: unknown): Promise<boolean> {
  if (typeof password !== 'string' || !validatePasswordInput(password).valid) return false;
  const parsed = parseHash(encoded);
  if (!parsed) return false;
  const actual = await derive(password, parsed.salt);
  try {
    return crypto.subtle.timingSafeEqual(actual, parsed.hash);
  } finally {
    actual.fill(0);
    parsed.hash.fill(0);
  }
}
