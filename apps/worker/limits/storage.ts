import { createLeaseState, pruneExpiredLeases } from './leases';
import type { LeaseState } from './leases';

export const LEASE_STORAGE_KEY = 'gate:leases';

/** Narrow SQLite-backed DO storage surface; ctx.storage satisfies this directly. */
export interface LeaseStorageBackend {
  readonly kv: Pick<SyncKvStorage, 'get' | 'put'>;
  transactionSync<T>(callback: () => T): T;
}

export class LeaseStorageError extends Error {
  readonly code = 'LEASE_STORAGE_INVALID';
  constructor() {
    super('Stored lease state is corrupt or uses an unsupported schema version');
    this.name = 'LeaseStorageError';
  }
}

function validateNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid lease storage timestamp');
}

function restore(raw: unknown, now: number): LeaseState {
  if (raw === undefined) return createLeaseState();
  try {
    if (typeof raw !== 'string') throw new LeaseStorageError();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !('schemaVersion' in parsed) || parsed.schemaVersion !== 1) {
      throw new LeaseStorageError();
    }
    // Pure rules validate every entry (including expired entries) before pruning.
    return pruneExpiredLeases(parsed as LeaseState, now).state;
  } catch {
    // Never include raw storage/lease tokens in an exception or silently reset it.
    throw new LeaseStorageError();
  }
}

/**
 * No cached copy: every operation reads durable state inside transactionSync.
 * Only synchronous, pure state transitions belong here; do not do I/O in callbacks.
 * Native SQLite rollback protects all writes if validation, transition or put fails.
 */
export class LeaseStorage {
  constructor(private readonly storage: LeaseStorageBackend) {}

  /** Recover and durably prune at the injected current time. No write if unchanged. */
  read(now: number): LeaseState {
    return this.update(now, (state) => ({ state })).state;
  }

  /** Compose directly with acquireLease/releaseLease/renewLease from leases.ts. */
  update<Result extends { state: LeaseState }>(
    now: number,
    transition: (state: LeaseState) => Result,
  ): Result {
    validateNow(now);
    return this.storage.transactionSync(() => {
      const raw = this.storage.kv.get<unknown>(LEASE_STORAGE_KEY);
      const state = restore(raw, now);
      const result = transition(state);
      if (!result || typeof result !== 'object' || 'then' in result) {
        throw new TypeError('Lease transition must return a synchronous state result');
      }
      const canonical = pruneExpiredLeases(result.state, now).state;
      const encoded = JSON.stringify(canonical);
      if (encoded !== raw && !(raw === undefined && canonical.leases.length === 0)) {
        this.storage.kv.put(LEASE_STORAGE_KEY, encoded);
      }
      return { ...result, state: canonical };
    });
  }
}
