import { describe, expect, it } from 'vitest';
import { acquireLease, createLeaseState, pruneExpiredLeases, releaseLease, renewLease } from '../../apps/worker/limits/leases';
import type { LeaseState } from '../../apps/worker/limits/leases';

const tokenA = 'A'.repeat(43);
const tokenB = 'B'.repeat(43);
const input = { requestId: 'request-a', leaseToken: tokenA, limit: 1, ttlMs: 90_000, now: 1_000 };
const initial = () => acquireLease(createLeaseState(), input).state;

describe('pure serializable lease transitions', () => {
  it('acquires until capacity and leaves the source snapshot untouched', () => {
    const source = createLeaseState();
    const first = acquireLease(source, input);
    expect(first.granted).toBe(true);
    expect(source.leases).toHaveLength(0);
    expect(first.state.leases[0]).toEqual({ requestId: 'request-a', leaseToken: tokenA, acquiredAt: 1_000, expiresAt: 91_000 });
    const before = JSON.stringify(first.state);
    expect(acquireLease(first.state, { ...input, requestId: 'request-b', leaseToken: tokenB }))
      .toEqual({ granted: false, reason: 'capacity', state: first.state });
    expect(JSON.stringify(first.state)).toBe(before);
  });

  it('returns the original lease on retry without extending TTL or occupying another slot', () => {
    const state = initial();
    const duplicate = acquireLease(state, { ...input, leaseToken: tokenB, now: 20_000, ttlMs: 180_000, limit: 0 });
    expect(duplicate.granted).toBe(true);
    if (duplicate.granted) {
      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.lease).toEqual(state.leases[0]);
    }
    expect(duplicate.state.leases).toHaveLength(1);
  });

  it('treats zero limit as closed to new acquisition', () => {
    expect(acquireLease(createLeaseState(), { ...input, limit: 0 }).granted).toBe(false);
  });

  it('does not expire early and frees capacity at the exact expiry timestamp', () => {
    const state = initial();
    expect(pruneExpiredLeases(state, 90_999).expired).toBe(0);
    expect(pruneExpiredLeases(state, 91_000)).toEqual({ state: createLeaseState(), expired: 1 });
    const replacement = acquireLease(state, { ...input, now: 91_000, leaseToken: tokenB });
    expect(replacement.granted).toBe(true);
    if (replacement.granted) {
      expect(replacement.duplicate).toBe(false);
      expect(replacement.lease.leaseToken).toBe(tokenB);
      expect(replacement.lease.expiresAt).toBe(181_000);
    }
    expect(state.leases).toHaveLength(1);
  });

  it('prunes only expired leases and repeated cleanup is idempotent', () => {
    const second = acquireLease(initial(), { ...input, requestId: 'request-b', leaseToken: tokenB, limit: 2, now: 2_000 });
    const pruned = pruneExpiredLeases(second.state, 91_000);
    expect(pruned.expired).toBe(1);
    expect(pruned.state.leases.map((lease) => lease.requestId)).toEqual(['request-b']);
    expect(pruneExpiredLeases(pruned.state, 91_000)).toEqual({ state: pruned.state, expired: 0 });
  });

  it('releases by request and token, with duplicate release a no-op', () => {
    const state = initial();
    const released = releaseLease(state, { requestId: input.requestId, leaseToken: tokenA, now: 2_000 });
    expect(released).toEqual({ released: true, state: createLeaseState() });
    expect(releaseLease(released.state, { requestId: input.requestId, leaseToken: tokenA, now: 3_000 }))
      .toEqual({ released: false, reason: 'missing', state: createLeaseState() });
    expect(state.leases).toHaveLength(1);
  });

  it('rejects stale release tokens after the same request gets a replacement lease', () => {
    const state = acquireLease(initial(), { ...input, now: 91_000, leaseToken: tokenB }).state;
    expect(releaseLease(state, { requestId: input.requestId, leaseToken: tokenA, now: 92_000 }))
      .toEqual({ released: false, reason: 'token_mismatch', state });
    expect(releaseLease(state, { requestId: 'other-request', leaseToken: tokenB, now: 92_000 }).released).toBe(false);
  });

  it('release of an expired lease reports missing and cleans it', () => {
    expect(releaseLease(initial(), { requestId: input.requestId, leaseToken: tokenA, now: 91_000 }))
      .toEqual({ released: false, reason: 'missing', state: createLeaseState() });
  });

  it('round-trips through JSON and handles prototype-like request IDs safely', () => {
    const source = acquireLease(createLeaseState(), { ...input, requestId: '__proto__' }).state;
    const restored = JSON.parse(JSON.stringify(source)) as LeaseState;
    expect(releaseLease(restored, { requestId: '__proto__', leaseToken: tokenA, now: 2_000 }).released).toBe(true);
    expect(Object.hasOwn({}, 'leaseToken')).toBe(false);
  });

  it.each([
    { limit: -1 }, { limit: 0.5 }, { limit: NaN }, { ttlMs: 0 }, { ttlMs: -1 },
    { ttlMs: Infinity }, { now: -1 }, { now: 0.5 }, { now: Number.MAX_SAFE_INTEGER },
    { requestId: '' }, { requestId: 'request\n' }, { requestId: 'x'.repeat(129) },
    { leaseToken: '' }, { leaseToken: 'x'.repeat(31) }, { leaseToken: tokenA + '\n' },
  ])('rejects invalid arguments without mutating state (case %#)', (invalid) => {
    const state = initial();
    const snapshot = JSON.stringify(state);
    expect(() => acquireLease(state, { ...input, ...invalid })).toThrow(TypeError);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('rejects active token reuse without modifying either lease', () => {
    const state = initial();
    expect(() => acquireLease(state, { ...input, requestId: 'request-b', limit: 2 })).toThrow('already in use');
    expect(state).toEqual(initial());
  });

  it('validates corrupt restored state before a transition', () => {
    const state = initial();
    for (const corrupt of [
      { schemaVersion: 2, leases: [] },
      { schemaVersion: 1, leases: [...state.leases, ...state.leases] },
      { schemaVersion: 1, leases: [{ ...state.leases[0], expiresAt: 1_000 }] },
      { schemaVersion: 1, leases: [null] },
    ]) {
      const before = JSON.stringify(corrupt);
      expect(() => pruneExpiredLeases(corrupt as LeaseState, 1_000)).toThrow(TypeError);
      expect(JSON.stringify(corrupt)).toBe(before);
    }
  });

  it('invalid release/cleanup cannot damage a valid snapshot', () => {
    const state = initial();
    const before = JSON.stringify(state);
    expect(() => releaseLease(state, { requestId: input.requestId, leaseToken: 'short', now: 2_000 })).toThrow(TypeError);
    expect(() => releaseLease(state, { requestId: input.requestId, leaseToken: tokenA, now: NaN })).toThrow(TypeError);
    expect(() => pruneExpiredLeases(state, -1)).toThrow(TypeError);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('capacity rejection may prune expired entries but never removes active leases', () => {
    const state = acquireLease(initial(), { ...input, requestId: 'request-b', leaseToken: tokenB, limit: 2, now: 2_000 }).state;
    const result = acquireLease(state, { ...input, requestId: 'request-c', leaseToken: 'C'.repeat(43), now: 91_000 });
    expect(result.granted).toBe(false);
    expect(result.state.leases.map((lease) => lease.requestId)).toEqual(['request-b']);
    expect(state.leases).toHaveLength(2);
  });
});

describe('lease renewal and late messages', () => {
  const renewal = { requestId: input.requestId, leaseToken: tokenA, ttlMs: 90_000, now: 30_000 };

  it('extends the matching live lease and preserves identity and the source snapshot', () => {
    const state = initial();
    const snapshot = JSON.stringify(state);
    const result = renewLease(state, renewal);
    expect(result.renewed).toBe(true);
    if (result.renewed) {
      expect(result.lease).toEqual({ requestId: input.requestId, leaseToken: tokenA, acquiredAt: 1_000, expiresAt: 120_000, lastRenewedAt: 30_000 });
    }
    expect(result.state.leases).toHaveLength(1);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('repeating the same renewal is idempotent and a shorter TTL never reduces expiry', () => {
    const first = renewLease(initial(), renewal);
    expect(renewLease(first.state, renewal)).toEqual(first);
    const shorter = renewLease(first.state, { ...renewal, ttlMs: 1, now: 31_000 });
    expect(shorter.renewed).toBe(true);
    expect(shorter.state.leases[0]?.expiresAt).toBe(120_000);
    expect(shorter.state.leases[0]?.lastRenewedAt).toBe(31_000);
    expect(shorter.state.leases).toHaveLength(1);
  });

  it('rejects renewed messages that arrive after a matching release without reviving state', () => {
    const state = renewLease(initial(), renewal).state;
    const released = releaseLease(state, { ...renewal, now: 31_000 }).state;
    const late = renewLease(released, { ...renewal, now: 32_000 });
    expect(late).toEqual({ renewed: false, reason: 'missing', state: createLeaseState() });
    expect(renewLease(late.state, { ...renewal, now: 33_000 }).state.leases).toHaveLength(0);
  });

  it('rejects an old token when the request ID belongs to a replacement lease', () => {
    const released = releaseLease(initial(), { ...input, now: 2_000 }).state;
    const replacement = acquireLease(released, { ...input, leaseToken: tokenB, now: 3_000 }).state;
    expect(renewLease(replacement, { ...renewal, now: 4_000 }))
      .toEqual({ renewed: false, reason: 'token_mismatch', state: replacement });
    expect(renewLease(replacement, { ...renewal, requestId: 'other-request', leaseToken: tokenB, now: 4_000 }).renewed).toBe(false);
  });

  it('accepts just before expiry but never at or after expiry', () => {
    expect(renewLease(initial(), { ...renewal, now: 90_999 }).renewed).toBe(true);
    for (const now of [91_000, 91_001]) {
      expect(renewLease(initial(), { ...renewal, now }))
        .toEqual({ renewed: false, reason: 'expired', state: createLeaseState() });
    }
  });

  it('rejects times earlier than acquisition or the last accepted renewal', () => {
    const state = initial();
    expect(renewLease(state, { ...renewal, now: 999 }))
      .toEqual({ renewed: false, reason: 'clock_regression', state });
    const updated = renewLease(state, renewal).state;
    const snapshot = JSON.stringify(updated);
    expect(renewLease(updated, { ...renewal, now: 29_999 }))
      .toEqual({ renewed: false, reason: 'clock_regression', state: updated });
    expect(JSON.stringify(updated)).toBe(snapshot);
  });

  it('keeps renewal history across JSON storage, cleanup and duplicate acquire', () => {
    const state = renewLease(initial(), renewal).state;
    const restored = JSON.parse(JSON.stringify(state)) as LeaseState;
    const cleaned = pruneExpiredLeases(restored, 31_000).state;
    const duplicate = acquireLease(cleaned, { ...input, now: 31_000, ttlMs: 999_999 }).state;
    expect(duplicate).toEqual(state);
    expect(renewLease(duplicate, { ...renewal, now: 29_999 }).renewed).toBe(false);
  });

  it.each([{ ttlMs: 0 }, { ttlMs: -1 }, { ttlMs: 0.5 }, { now: -1 }, { now: NaN }, { now: Number.MAX_SAFE_INTEGER }, { leaseToken: 'short' }])(
    'invalid renewal case %# never changes the input snapshot', (invalid) => {
      const state = initial();
      const before = JSON.stringify(state);
      expect(() => renewLease(state, { ...renewal, ...invalid })).toThrow(TypeError);
      expect(JSON.stringify(state)).toBe(before);
    },
  );

  it.each([999, 91_000, NaN])('rejects corrupt persisted renewal timestamps (case %#)', (lastRenewedAt) => {
    const state = { schemaVersion: 1, leases: [{ ...initial().leases[0], lastRenewedAt }] };
    expect(() => renewLease(state as LeaseState, renewal)).toThrow(TypeError);
  });
});
