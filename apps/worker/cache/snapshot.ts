export const SNAPSHOT_SCHEMA_VERSION = 1;
// KV expirationTtl is in seconds and must be >= 60. Application freshness is
// independent and can be shorter: https://developers.cloudflare.com/kv/api/write-key-value-pairs/
export const MIN_KV_EXPIRATION_TTL_SECONDS = 60;

export interface Snapshot<T> {
  readonly schema_version: typeof SNAPSHOT_SCHEMA_VERSION;
  /** UTC milliseconds captured at the START of the authoritative D1 read. */
  readonly observed_at: number;
  readonly data: T;
}

export interface SnapshotFreshness {
  readonly now: number;
  readonly maxAgeMs: number;
}

export type SnapshotDataValidator<T> = (value: unknown) => value is T;

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Encoding never samples a clock or replaces observed_at during retries/copies. */
export function encodeSnapshot<T>(snapshot: Snapshot<T>): string | null {
  try {
    if (!snapshot || snapshot.schema_version !== SNAPSHOT_SCHEMA_VERSION || !timestamp(snapshot.observed_at)) return null;
    return JSON.stringify({ schema_version: snapshot.schema_version, observed_at: snapshot.observed_at, data: snapshot.data });
  } catch {
    return null;
  }
}

/** Null means miss: malformed, mismatched schema, future, expired or invalid data.
 * Each consumer validates its own payload, including money strings and config
 * versions. A fresh cache entry never constitutes permission or billing truth.
 */
export function decodeSnapshot<T>(
  encoded: string | null,
  freshness: SnapshotFreshness,
  validateData: SnapshotDataValidator<T>,
): Snapshot<T> | null {
  try {
    if (typeof encoded !== 'string' || !timestamp(freshness.now) ||
        !Number.isSafeInteger(freshness.maxAgeMs) || freshness.maxAgeMs <= 0) return null;
    const value: unknown = JSON.parse(encoded);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const fields = value as Record<string, unknown>;
    if (Object.keys(fields).length !== 3 || !Object.hasOwn(fields, 'data') ||
        fields.schema_version !== SNAPSHOT_SCHEMA_VERSION || !timestamp(fields.observed_at)) return null;
    const age = freshness.now - fields.observed_at;
    if (age < 0 || age >= freshness.maxAgeMs || !validateData(fields.data)) return null;
    return { schema_version: SNAPSHOT_SCHEMA_VERSION, observed_at: fields.observed_at, data: fields.data };
  } catch {
    return null;
  }
}

/** Reads do not write, refresh timestamps or use stale-while-revalidate. Caller
 * falls back to authoritative D1 on null, including KV errors and negative cache.
 */
export async function readSnapshot<T>(
  kv: KVNamespace,
  key: string,
  freshness: SnapshotFreshness,
  validateData: SnapshotDataValidator<T>,
): Promise<Snapshot<T> | null> {
  try {
    // Do not equate KV's edge cacheTtl with application freshness.
    return decodeSnapshot(await kv.get(key, 'text'), freshness, validateData);
  } catch {
    return null;
  }
}

/** Best-effort backfill only. Does not retry, perform CAS, or change D1 state.
 * Concurrent older writes may replace newer KV values; the original observed_at
 * remains in the envelope so they cannot become artificially young.
 */
export async function writeSnapshot<T>(
  kv: KVNamespace,
  key: string,
  snapshot: Snapshot<T>,
  freshness: SnapshotFreshness,
  validateData: SnapshotDataValidator<T>,
): Promise<boolean> {
  try {
    const encoded = encodeSnapshot(snapshot);
    const checked = decodeSnapshot(encoded, freshness, validateData);
    if (encoded === null || checked === null) return false;
    const remainingMs = freshness.maxAgeMs - (freshness.now - checked.observed_at);
    const expirationTtl = Math.max(MIN_KV_EXPIRATION_TTL_SECONDS, Math.ceil(remainingMs / 1000));
    await kv.put(key, encoded, { expirationTtl });
    return true;
  } catch {
    // A failed/429 cache put must not fail the authoritative read or transaction.
    return false;
  }
}
