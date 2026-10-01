export const EMAIL_PROOF_KEY_MIN_BYTES = 32;
export type EmailProofPurpose = "registration";

export interface EmailProofInput {
  readonly email: string;
  readonly purpose: EmailProofPurpose;
  readonly generation: number;
  readonly code: string;
}

const encoder = new TextEncoder();
const localCharacters = /^[\p{L}\p{N}\p{M}.!#$%&'*+/=?^_`{|}~-]+$/u;
const domainLabel = /^[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}-]*[\p{L}\p{N}\p{M}])?$/u;

/**
 * Application email subset, not complete RFC mailbox parsing or deliverability.
 * Trim and lowercase only. Never remove dots/plus tags, normalize Unicode forms,
 * map IDNA/fullwidth characters, or do DNS. Unicode letters/marks/numbers remain
 * literal UTF-8; canonical-equivalent Unicode spellings remain distinct.
 */
export function normalizeEmail(email: string): string {
  if (typeof email !== "string") throw new TypeError("Invalid email address");
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || /[\s\p{C}]/u.test(normalized) || encoder.encode(normalized).byteLength > 254) {
    throw new TypeError("Invalid email address");
  }
  const parts = normalized.split("@");
  if (parts.length !== 2) throw new TypeError("Invalid email address");
  const local = parts[0]!;
  const domain = parts[1]!;
  if (!localCharacters.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..") ||
    encoder.encode(local).byteLength > 64) throw new TypeError("Invalid email address");
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => !domainLabel.test(label) || encoder.encode(label).byteLength > 63)) {
    throw new TypeError("Invalid email address");
  }
  return normalized;
}

/** Uniform over 000000–999999; rejection sampling removes modulo bias. */
export function generateEmailCode(): string {
  const sample = new Uint32Array(1);
  // Largest multiple of one million below 2^32.
  const exclusiveBound = 4_294_000_000;
  do { crypto.getRandomValues(sample); } while (sample[0]! >= exclusiveBound);
  return (sample[0]! % 1_000_000).toString().padStart(6, "0");
}

function requireKey(keyBytes: Uint8Array): Uint8Array {
  if (!(keyBytes instanceof Uint8Array) || keyBytes.byteLength < EMAIL_PROOF_KEY_MIN_BYTES) {
    throw new TypeError("Email proof key must contain at least 32 bytes");
  }
  // Snapshot injected secret bytes before awaiting Web Crypto; never retain globally.
  return new Uint8Array(keyBytes);
}

function payload(input: EmailProofInput): Uint8Array {
  if (typeof input !== "object" || input === null || input.purpose !== "registration" ||
    !Number.isSafeInteger(input.generation) || input.generation < 1 || typeof input.code !== "string" ||
    input.code.length !== 6 || !/^[0-9]{6}$/.test(input.code)) throw new TypeError("Invalid email proof fields");
  const email = normalizeEmail(input.email);
  // A versioned, unambiguous tuple separates this MAC from every other token use.
  return encoder.encode(JSON.stringify(["sub2api.email-code.v1", email, input.purpose, input.generation, input.code]));
}

function importKey(bytes: Uint8Array, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/** Lowercase 64-character hex, directly compatible with email_challenges.code_mac. */
export async function hashEmailCode(keyBytes: Uint8Array, input: EmailProofInput): Promise<string> {
  const bytes = requireKey(keyBytes);
  const message = payload(input);
  const key = await importKey(bytes, "sign");
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Malformed public proof fields/MACs fail closed. Invalid server keys and crypto
 * runtime failures propagate. Native HMAC verification performs secure comparison;
 * no string equality or timing-dependent manual digest comparison is used.
 * This authenticates fields only: expiry, attempts and consumption belong to A17.
 */
export async function verifyEmailCode(keyBytes: Uint8Array, input: EmailProofInput, expectedMac: unknown): Promise<boolean> {
  const bytes = requireKey(keyBytes);
  if (typeof expectedMac !== "string" || expectedMac.length !== 64 || !/^[0-9a-f]{64}$/.test(expectedMac)) return false;
  let message: Uint8Array;
  try {
    message = payload(input);
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
  const signature = new Uint8Array(32);
  for (let index = 0; index < signature.length; index += 1) {
    signature[index] = Number.parseInt(expectedMac.slice(index * 2, index * 2 + 2), 16);
  }
  const key = await importKey(bytes, "verify");
  return crypto.subtle.verify("HMAC", key, signature, message);
}
