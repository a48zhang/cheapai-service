import { decodeSnapshot, encodeSnapshot } from '../cache/snapshot-codec';
import type { Snapshot, SnapshotDataValidator, SnapshotFreshness } from '../cache/snapshot-codec';

// KV expirationTtl is in seconds and must be >= 60. Application freshness is
// independent and can be shorter: https://developers.cloudflare.com/kv/api/write-key-value-pairs/
export const MIN_KV_EXPIRATION_TTL_SECONDS = 60;

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
