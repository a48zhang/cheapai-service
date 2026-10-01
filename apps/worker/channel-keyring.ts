import type { ChannelEncryptionKey } from './admin/channel-repository';
import type { ChannelKeyring } from './admin/channel-secrets';
import type { Env } from './env';
import { ApiError } from './http';

export const CHANNEL_KEYRING_LIMITS = Object.freeze({ entries: 16, bytes: 8192 });
type KeyringBindings = Pick<Env, 'CHANNEL_KEYRING_JSON' | 'CHANNEL_ACTIVE_KEY_VERSION'>;
export interface ResolvedChannelKeyring { active: ChannelEncryptionKey; keyring: ChannelKeyring }
function validVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

/** Call lazily after authorization. No cache or logging: rotation is visible on
 * the next request. G consumers can reuse the retained-version map to decrypt.
 */
export function readChannelKeyring(bindings: KeyringBindings): ResolvedChannelKeyring {
  try {
    const raw = bindings.CHANNEL_KEYRING_JSON;
    const activeVersion = bindings.CHANNEL_ACTIVE_KEY_VERSION;
    if (typeof raw !== 'string' || raw.length > CHANNEL_KEYRING_LIMITS.bytes
      || new TextEncoder().encode(raw).byteLength > CHANNEL_KEYRING_LIMITS.bytes || !validVersion(activeVersion)) throw new Error();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    const entries = Object.entries(parsed);
    if (entries.length < 1 || entries.length > CHANNEL_KEYRING_LIMITS.entries) throw new Error();
    const keyring = new Map<string, Uint8Array>();
    for (const [version, encoded] of entries) {
      if (!validVersion(version) || typeof encoded !== 'string' || encoded.length !== 44 || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error();
      const binary = atob(encoded);
      if (binary.length !== 32 || btoa(binary) !== encoded) throw new Error();
      keyring.set(version, Uint8Array.from(binary, character => character.charCodeAt(0)));
    }
    const key = keyring.get(activeVersion);
    if (!key) throw new Error();
    return { active: { keyVersion: activeVersion, key }, keyring };
  } catch {
    // Neither Secret text, version labels nor parser diagnostics enter responses.
    throw new ApiError('service_unavailable');
  }
}
