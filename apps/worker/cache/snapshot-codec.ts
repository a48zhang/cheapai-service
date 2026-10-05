export const SNAPSHOT_SCHEMA_VERSION = 1;
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
    if (!Object.hasOwn(fields, 'data') ||
        fields.schema_version !== SNAPSHOT_SCHEMA_VERSION || !timestamp(fields.observed_at)) return null;
    const age = freshness.now - fields.observed_at;
    if (age < 0 || age >= freshness.maxAgeMs || !validateData(fields.data)) return null;
    return { schema_version: SNAPSHOT_SCHEMA_VERSION, observed_at: fields.observed_at, data: fields.data };
  } catch {
    return null;
  }
}
