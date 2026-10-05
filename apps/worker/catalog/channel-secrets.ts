import { decryptSecretEnvelope, encryptSecretEnvelope } from './secret-envelope';
import type { SecretKeyring } from './secret-envelope';

export type ChannelKeyring = SecretKeyring;

export class ChannelSecretError extends Error {
  constructor(options?: ErrorOptions) {
    super('Channel secret operation failed.', options);
    this.name = 'ChannelSecretError';
  }
}

const encoder = new TextEncoder();

function validVersion(version: unknown): version is string {
  return typeof version === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version);
}

/** Keep the original channel AAD bytes stable for existing stored envelopes. */
function aad(channelId: string, version: string): Uint8Array {
  if (typeof channelId !== 'string' || channelId.length === 0 || channelId.trim() !== channelId ||
      /[\u0000-\u001f\u007f]/.test(channelId) || !validVersion(version)) {
    throw new ChannelSecretError();
  }
  return encoder.encode(JSON.stringify(['sub2api/channel-secret', 1, 'A256GCM', channelId, version]));
}

/** Returns a JSON envelope suitable for secret_ciphertext; key material stays with the caller. */
export async function encryptChannelSecret(
  plaintext: string,
  channelId: string,
  keyVersion: string,
  key: Uint8Array,
): Promise<string> {
  try {
    return await encryptSecretEnvelope(plaintext, keyVersion, key, aad(channelId, keyVersion));
  } catch (error) {
    throw new ChannelSecretError({ cause: error });
  }
}

/** Selects only the envelope's version; no fallback to a different key or version. */
export async function decryptChannelSecret(
  encrypted: string,
  channelId: string,
  keyring: ChannelKeyring,
): Promise<string> {
  try {
    return await decryptSecretEnvelope(encrypted, keyring, version => aad(channelId, version));
  } catch (error) {
    throw new ChannelSecretError({ cause: error });
  }
}
