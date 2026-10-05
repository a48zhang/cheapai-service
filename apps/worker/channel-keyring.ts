import type { ChannelEncryptionKey } from './catalog/channels';
import type { ChannelKeyring } from './catalog/channel-secrets';
import type { Env } from './env';
import { ApiError } from './http';

export const CHANNEL_KEYRING_LIMITS = Object.freeze({ entries: 16, bytes: 8192 });
type KeyringBindings = Pick<Env, 'CHANNEL_KEYRING_JSON' | 'CHANNEL_ACTIVE_KEY_VERSION'>;
export interface ResolvedChannelKeyring { active: ChannelEncryptionKey; keyring: ChannelKeyring }
function validVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

/** Call lazily after authorization. No cache: rotation is visible on
 * the next request. G consumers can reuse the retained-version map to decrypt.
 */
export function readChannelKeyring(bindings: KeyringBindings): ResolvedChannelKeyring {
  try {
    const raw = bindings.CHANNEL_KEYRING_JSON;
    const activeVersion = bindings.CHANNEL_ACTIVE_KEY_VERSION;
    if (typeof raw !== 'string' || raw.length === 0) throw new Error('CHANNEL_KEYRING_JSON is missing or empty.');
    if (raw.length > CHANNEL_KEYRING_LIMITS.bytes || new TextEncoder().encode(raw).byteLength > CHANNEL_KEYRING_LIMITS.bytes)
      throw new Error('CHANNEL_KEYRING_JSON exceeds the size limit.');
    if (!validVersion(activeVersion)) throw new Error('CHANNEL_ACTIVE_KEY_VERSION is missing or invalid.');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('CHANNEL_KEYRING_JSON must be a JSON object.');
    const entries = Object.entries(parsed);
    if (entries.length < 1 || entries.length > CHANNEL_KEYRING_LIMITS.entries) throw new Error('CHANNEL_KEYRING_JSON must contain 1 to 16 keys.');
    const keyring = new Map<string, Uint8Array>();
    for (const [version, encoded] of entries) {
      if (!validVersion(version)) throw new Error('CHANNEL_KEYRING_JSON contains an invalid version name.');
      if (typeof encoded !== 'string' || encoded.length !== 44 || !/^[A-Za-z0-9+/]{43}=$/.test(encoded))
        throw new Error('CHANNEL_KEYRING_JSON keys must be 32-byte standard base64 values.');
      const binary = atob(encoded);
      if (binary.length !== 32 || btoa(binary) !== encoded) throw new Error('CHANNEL_KEYRING_JSON contains a noncanonical base64 key.');
      keyring.set(version, Uint8Array.from(binary, character => character.charCodeAt(0)));
    }
    const key = keyring.get(activeVersion);
    if (!key) throw new Error('CHANNEL_ACTIVE_KEY_VERSION is not present in CHANNEL_KEYRING_JSON.');
    return { active: { keyVersion: activeVersion, key }, keyring };
  } catch (error) {
    // Neither Secret text, version labels nor parser diagnostics enter responses.
    throw new ApiError('service_unavailable', { cause: error });
  }
}
