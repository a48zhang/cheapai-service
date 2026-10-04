import { decryptSecretEnvelope, encryptSecretEnvelope } from '../../catalog/secret-envelope';
import type { SecretKeyring } from '../../catalog/secret-envelope';

export type DesktopKeyring = SecretKeyring;

export interface DesktopKeyEncryptionKey {
  readonly keyVersion: string;
  readonly key: Uint8Array;
}

export class DesktopKeyCipherError extends Error {
  constructor() {
    super('Desktop Key encryption failed.');
    this.name = 'DesktopKeyCipherError';
  }
}

const encoder = new TextEncoder();

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Purpose and both owning identifiers are authenticated with every desktop Key. */
function aad(sessionId: string, keyId: string, keyVersion: string): Uint8Array {
  if (!validIdentity(sessionId) || !validIdentity(keyId)) throw new DesktopKeyCipherError();
  return encoder.encode(JSON.stringify(['sub2api/desktop-key', 1, 'A256GCM', sessionId, keyId, keyVersion]));
}

/** Encrypt the one-time API Key before its secret is persisted in desktop_sessions. */
export async function encryptDesktopKey(
  token: string,
  sessionId: string,
  keyId: string,
  activeKey: DesktopKeyEncryptionKey,
): Promise<string> {
  try {
    if (activeKey === null || typeof activeKey !== 'object' ||
        typeof activeKey.keyVersion !== 'string' || !(activeKey.key instanceof Uint8Array)) throw new DesktopKeyCipherError();
    return await encryptSecretEnvelope(token, activeKey.keyVersion, activeKey.key, aad(sessionId, keyId, activeKey.keyVersion));
  } catch {
    throw new DesktopKeyCipherError();
  }
}

/** Recover only for the same session/key pair and a retained configured key version. */
export async function decryptDesktopKey(
  encrypted: string,
  sessionId: string,
  keyId: string,
  keyring: DesktopKeyring,
): Promise<string> {
  try {
    if (!validIdentity(sessionId) || !validIdentity(keyId)) throw new DesktopKeyCipherError();
    return await decryptSecretEnvelope(encrypted, keyring, version => aad(sessionId, keyId, version));
  } catch {
    throw new DesktopKeyCipherError();
  }
}
