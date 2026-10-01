export interface Lease {
  readonly requestId: string;
  readonly leaseToken: string;
  readonly acquiredAt: number;
  readonly expiresAt: number;
  /** Absent on a newly acquired/L01 lease; acquiredAt is then the time floor. */
  readonly lastRenewedAt?: number;
}

/** Plain JSON data. A DO caller must serialize transitions and persist the result. */
export interface LeaseState {
  readonly schemaVersion: 1;
  readonly leases: readonly Lease[];
}

export type AcquireLeaseResult =
  | { granted: true; duplicate: boolean; lease: Lease; state: LeaseState }
  | { granted: false; reason: 'capacity'; state: LeaseState };

export type ReleaseLeaseResult =
  | { released: true; state: LeaseState }
  | { released: false; reason: 'missing' | 'token_mismatch'; state: LeaseState };

export type RenewLeaseResult =
  | { renewed: true; lease: Lease; state: LeaseState }
  | { renewed: false; reason: 'missing' | 'expired' | 'token_mismatch' | 'clock_regression'; state: LeaseState };

export function createLeaseState(): LeaseState {
  return { schemaVersion: 1, leases: [] };
}

function integer(value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError('Invalid lease numeric argument');
}

function requestId(value: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || /[^A-Za-z0-9_.:-]/.test(value)) {
    throw new TypeError('Invalid lease request ID');
  }
}

function leaseToken(value: string): void {
  if (typeof value !== 'string' || value.length < 32 || value.length > 128 || /[^A-Za-z0-9_-]/.test(value)) {
    throw new TypeError('Invalid lease token');
  }
}

function validateState(state: LeaseState): void {
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.leases)) throw new TypeError('Invalid lease state');
  const ids = new Set<string>();
  const tokens = new Set<string>();
  for (const lease of state.leases) {
    if (!lease || typeof lease !== 'object') throw new TypeError('Invalid stored lease');
    requestId(lease.requestId);
    leaseToken(lease.leaseToken);
    integer(lease.acquiredAt, 0);
    integer(lease.expiresAt, 0);
    if (lease.expiresAt <= lease.acquiredAt || ids.has(lease.requestId) || tokens.has(lease.leaseToken)) {
      throw new TypeError('Invalid stored lease');
    }
    if (lease.lastRenewedAt !== undefined) {
      integer(lease.lastRenewedAt, 0);
      if (lease.lastRenewedAt < lease.acquiredAt || lease.lastRenewedAt >= lease.expiresAt) {
        throw new TypeError('Invalid stored lease renewal time');
      }
    }
    ids.add(lease.requestId);
    tokens.add(lease.leaseToken);
  }
}

/** A lease is expired at expiresAt <= now, including the exact boundary. */
export function pruneExpiredLeases(state: LeaseState, now: number): { state: LeaseState; expired: number } {
  integer(now, 0);
  validateState(state);
  const leases = state.leases.filter((lease) => lease.expiresAt > now).map((lease) => ({
    requestId: lease.requestId, leaseToken: lease.leaseToken,
    acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt,
    ...(lease.lastRenewedAt === undefined ? {} : { lastRenewedAt: lease.lastRenewedAt }),
  }));
  return { state: { schemaVersion: 1, leases }, expired: state.leases.length - leases.length };
}

/**
 * Inject a fresh unpredictable token for each new acquisition (including after
 * release/expiry). Retries with an active request ID return its original token and
 * deadline, even if the caller supplied a different token/TTL or reduced limit.
 */
export function acquireLease(state: LeaseState, input: {
  requestId: string; leaseToken: string; limit: number; ttlMs: number; now: number;
}): AcquireLeaseResult {
  requestId(input.requestId);
  leaseToken(input.leaseToken);
  integer(input.limit, 0);
  integer(input.ttlMs, 1);
  integer(input.now, 0);
  if (!Number.isSafeInteger(input.now + input.ttlMs)) throw new TypeError('Lease expiry exceeds safe timestamp range');
  const cleaned = pruneExpiredLeases(state, input.now).state;
  const existing = cleaned.leases.find((lease) => lease.requestId === input.requestId);
  if (existing) return { granted: true, duplicate: true, lease: { ...existing }, state: cleaned };
  if (cleaned.leases.length >= input.limit) return { granted: false, reason: 'capacity', state: cleaned };
  if (cleaned.leases.some((lease) => lease.leaseToken === input.leaseToken)) {
    throw new TypeError('Lease token is already in use');
  }
  const lease: Lease = {
    requestId: input.requestId, leaseToken: input.leaseToken,
    acquiredAt: input.now, expiresAt: input.now + input.ttlMs,
  };
  return { granted: true, duplicate: false, lease: { ...lease }, state: { schemaVersion: 1, leases: [...cleaned.leases, lease] } };
}

/** Token matching prevents a late release from removing a replacement lease. */
export function releaseLease(state: LeaseState, input: {
  requestId: string; leaseToken: string; now: number;
}): ReleaseLeaseResult {
  requestId(input.requestId);
  leaseToken(input.leaseToken);
  const cleaned = pruneExpiredLeases(state, input.now).state;
  const lease = cleaned.leases.find((candidate) => candidate.requestId === input.requestId);
  if (!lease) return { released: false, reason: 'missing', state: cleaned };
  if (lease.leaseToken !== input.leaseToken) return { released: false, reason: 'token_mismatch', state: cleaned };
  return { released: true, state: { schemaVersion: 1, leases: cleaned.leases.filter((candidate) => candidate.requestId !== input.requestId) } };
}

/** Renew only an existing live token. Never upsert or move its deadline backwards. */
export function renewLease(state: LeaseState, input: {
  requestId: string; leaseToken: string; ttlMs: number; now: number;
}): RenewLeaseResult {
  requestId(input.requestId);
  leaseToken(input.leaseToken);
  integer(input.ttlMs, 1);
  integer(input.now, 0);
  if (!Number.isSafeInteger(input.now + input.ttlMs)) throw new TypeError('Lease expiry exceeds safe timestamp range');
  const cleaned = pruneExpiredLeases(state, input.now).state;
  const previous = state.leases.find((lease) => lease.requestId === input.requestId);
  if (!previous) return { renewed: false, reason: 'missing', state: cleaned };
  if (previous.expiresAt <= input.now) return { renewed: false, reason: 'expired', state: cleaned };
  if (previous.leaseToken !== input.leaseToken) return { renewed: false, reason: 'token_mismatch', state: cleaned };
  if (input.now < (previous.lastRenewedAt ?? previous.acquiredAt)) {
    return { renewed: false, reason: 'clock_regression', state: cleaned };
  }
  const lease: Lease = {
    requestId: previous.requestId, leaseToken: previous.leaseToken,
    acquiredAt: previous.acquiredAt, lastRenewedAt: input.now,
    expiresAt: Math.max(previous.expiresAt, input.now + input.ttlMs),
  };
  return {
    renewed: true, lease: { ...lease },
    state: { schemaVersion: 1, leases: cleaned.leases.map((candidate) => candidate.requestId === input.requestId ? lease : candidate) },
  };
}
