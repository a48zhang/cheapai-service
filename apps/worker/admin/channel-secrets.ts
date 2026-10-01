export type ChannelKeyring = ReadonlyMap<string, Uint8Array>;

interface EncryptedChannelSecret {
  algorithm: 'A256GCM';
  format_version: 1;
  key_version: string;
  nonce: string;
  ciphertext: string;
}

export class ChannelSecretError extends Error {
  constructor() {
    super('Channel secret operation failed.');
    this.name = 'ChannelSecretError';
  }
}

const encoder = new TextEncoder();

function validVersion(version: unknown): version is string {
  return typeof version === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version);
}

function aad(channelId: string, version: string): Uint8Array {
  if (typeof channelId !== 'string' || channelId.length === 0 || channelId.trim() !== channelId ||
      /[\u0000-\u001f\u007f]/.test(channelId) || !validVersion(version)) {
    throw new ChannelSecretError();
  }
  return encoder.encode(JSON.stringify(['sub2api/channel-secret', 1, 'A256GCM', channelId, version]));
}

async function importKey(key: Uint8Array | undefined, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new ChannelSecretError();
  return crypto.subtle.importKey('raw', new Uint8Array(key), 'AES-GCM', false, [usage]);
}

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new ChannelSecretError();
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (encode(bytes) !== value) throw new ChannelSecretError();
  return bytes;
}

/** Returns a JSON envelope suitable for secret_ciphertext; key material stays with the caller. */
export async function encryptChannelSecret(
  plaintext: string,
  channelId: string,
  keyVersion: string,
  key: Uint8Array,
): Promise<string> {
  try {
    if (typeof plaintext !== 'string' || plaintext.length === 0) throw new ChannelSecretError();
    const additionalData = aad(channelId, keyVersion);
    const cryptoKey = await importKey(key, 'encrypt');
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData, tagLength: 128 }, cryptoKey, encoder.encode(plaintext),
    );
    const envelope: EncryptedChannelSecret = {
      algorithm: 'A256GCM', format_version: 1, key_version: keyVersion,
      nonce: encode(nonce), ciphertext: encode(new Uint8Array(encrypted)),
    };
    return JSON.stringify(envelope);
  } catch {
    throw new ChannelSecretError();
  }
}

/** Selects only the envelope's version; no fallback to a different key or version. */
export async function decryptChannelSecret(
  encrypted: string,
  channelId: string,
  keyring: ChannelKeyring,
): Promise<string> {
  try {
    const envelope: unknown = JSON.parse(encrypted);
    if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) throw new ChannelSecretError();
    const fields = envelope as Record<string, unknown>;
    if (Object.keys(fields).length !== 5 || fields.algorithm !== 'A256GCM' || fields.format_version !== 1 ||
        !validVersion(fields.key_version)) throw new ChannelSecretError();
    const additionalData = aad(channelId, fields.key_version);
    const nonce = decode(fields.nonce);
    const ciphertext = decode(fields.ciphertext);
    if (nonce.length !== 12 || ciphertext.length <= 16) throw new ChannelSecretError();
    const cryptoKey = await importKey(keyring.get(fields.key_version), 'decrypt');
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData, tagLength: 128 }, cryptoKey, ciphertext,
    );
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plaintext);
  } catch {
    throw new ChannelSecretError();
  }
}
