export type SecretKeyring = ReadonlyMap<string, Uint8Array>;

interface SecretEnvelope {
  algorithm: 'A256GCM';
  format_version: 1;
  key_version: string;
  nonce: string;
  ciphertext: string;
}

export class SecretEnvelopeError extends Error {
  constructor(options?: ErrorOptions) {
    super('Secret envelope operation failed.', options);
    this.name = 'SecretEnvelopeError';
  }
}

const encoder = new TextEncoder();

function validVersion(version: unknown): version is string {
  return typeof version === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version);
}

async function importKey(key: Uint8Array | undefined, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new SecretEnvelopeError();
  return crypto.subtle.importKey('raw', new Uint8Array(key), 'AES-GCM', false, [usage]);
}

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new SecretEnvelopeError();
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (encode(bytes) !== value) throw new SecretEnvelopeError();
  return bytes;
}

function additionalData(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > 4096) throw new SecretEnvelopeError();
  return new Uint8Array(value);
}

/** Encrypts with the shared versioned AES-256-GCM JSON envelope. */
export async function encryptSecretEnvelope(
  plaintext: string,
  keyVersion: string,
  key: Uint8Array,
  aad: Uint8Array,
): Promise<string> {
  try {
    if (typeof plaintext !== 'string' || plaintext.length === 0 || !validVersion(keyVersion)) throw new SecretEnvelopeError();
    const cryptoKey = await importKey(key, 'encrypt');
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: additionalData(aad), tagLength: 128 }, cryptoKey, encoder.encode(plaintext),
    );
    const envelope: SecretEnvelope = {
      algorithm: 'A256GCM', format_version: 1, key_version: keyVersion,
      nonce: encode(nonce), ciphertext: encode(new Uint8Array(encrypted)),
    };
    return JSON.stringify(envelope);
  } catch (error) {
    throw new SecretEnvelopeError({ cause: error });
  }
}

/** Decrypts only with the envelope's retained key version and caller's AAD. */
export async function decryptSecretEnvelope(
  encrypted: string,
  keyring: SecretKeyring,
  aadForVersion: (keyVersion: string) => Uint8Array,
): Promise<string> {
  try {
    const envelope: unknown = JSON.parse(encrypted);
    if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) throw new SecretEnvelopeError();
    const fields = envelope as Record<string, unknown>;
    if (Object.keys(fields).length !== 5 || fields.algorithm !== 'A256GCM' || fields.format_version !== 1 ||
        !validVersion(fields.key_version)) throw new SecretEnvelopeError();
    const aad = additionalData(aadForVersion(fields.key_version));
    const nonce = decode(fields.nonce);
    const ciphertext = decode(fields.ciphertext);
    if (nonce.length !== 12 || ciphertext.length <= 16) throw new SecretEnvelopeError();
    const cryptoKey = await importKey(keyring.get(fields.key_version), 'decrypt');
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, cryptoKey, ciphertext,
    );
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plaintext);
  } catch (error) {
    throw new SecretEnvelopeError({ cause: error });
  }
}
