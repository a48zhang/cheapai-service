import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { acquireLease, releaseLease, renewLease } from './leases';
import type { Lease, LeaseState, ReleaseLeaseResult, RenewLeaseResult } from './leases';
import { LeaseStorage } from './storage';
import { consumeRateWindow, RateWindowError } from './rate-window';
import type { RateWindowState } from './rate-window';

export const GATE_RATE_STORAGE_KEY = 'gate:rate-window';
export const GATE_COOLDOWN_STORAGE_KEY = 'gate:cooldown';
export const MAX_COOLDOWN_TTL_MS = 300_000;
export type GateCooldownClass = 'rate_limited' | 'auth_rejected';
export type GateCooldownResult =
  | { active: false; retryAfterMs: 0 }
  | { active: true; cooldownUntil: number; errorClass: GateCooldownClass; retryAfterMs: number };
interface CooldownState { schemaVersion: 1; cooldownUntil: number; errorClass: GateCooldownClass }
export interface GateRateInput { operationId: string; limit: number; windowMs: number }
export interface GateAcquireInput { requestId: string; limit: number; ttlMs: number; rate?: GateRateInput }
export type GateAcquireResult =
  | { granted: true; duplicate: boolean; lease: Lease }
  | { granted: false; reason: 'capacity' | 'rate_limit' | 'cooldown'; retryAfterMs: number };
export type GateRenewResult =
  | { renewed: true; lease: Lease }
  | { renewed: false; reason: Extract<RenewLeaseResult, { renewed: false }>['reason'] };
export type GateReleaseResult =
  | { released: true }
  | { released: false; reason: Extract<ReleaseLeaseResult, { released: false }>['reason'] };

function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new TypeError('Invalid Gate RPC input');
  }
}

/** Internal binding RPC only. The DO's clock and persisted state control admission. */
export class Gate extends DurableObject<Env> {
  #readCooldown(now: number): CooldownState | undefined {
    const raw = this.ctx.storage.kv.get<unknown>(GATE_COOLDOWN_STORAGE_KEY);
    if (raw === undefined) return undefined;
    let state: CooldownState;
    try {
      if (typeof raw !== 'string') throw new TypeError();
      const parsed: unknown = JSON.parse(raw);
      fields(parsed, ['schemaVersion', 'cooldownUntil', 'errorClass']);
      state = parsed as CooldownState;
      if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.cooldownUntil) || state.cooldownUntil < 0
        || state.cooldownUntil - now > MAX_COOLDOWN_TTL_MS
        || (state.errorClass !== 'rate_limited' && state.errorClass !== 'auth_rejected')) throw new TypeError();
    } catch { throw new TypeError('Invalid Gate cooldown state'); }
    if (state.cooldownUntil <= now) {
      this.ctx.storage.kv.delete(GATE_COOLDOWN_STORAGE_KEY);
      return undefined;
    }
    return state;
  }

  /** Validate persisted rate state by replaying a known ID, discarding the probe. */
  #readRate(now: number): RateWindowState | undefined {
    const raw = this.ctx.storage.kv.get<unknown>(GATE_RATE_STORAGE_KEY);
    if (raw === undefined) return undefined;
    let state: RateWindowState;
    try {
      if (typeof raw !== 'string') throw new RateWindowError('invalid_state');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !('operationIds' in parsed) || !Array.isArray(parsed.operationIds)) {
        throw new RateWindowError('invalid_state');
      }
      state = parsed as RateWindowState;
      // L04 validates schema version, sizes and every accepted ID. An empty window
      // uses a throwaway probe; no probe result or ID is written to storage.
      consumeRateWindow(state, {
        now: state.lastSeenMs, windowMs: state.windowMs, limit: state.limit,
        operationId: state.operationIds[0] ?? 'gate-validation',
      });
    } catch {
      throw new RateWindowError('invalid_state');
    }
    if (now < state.lastSeenMs) throw new RateWindowError('clock_regression');
    if (state.windowStartMs + state.windowMs <= now) {
      this.ctx.storage.kv.delete(GATE_RATE_STORAGE_KEY);
      return undefined;
    }
    return state;
  }

  #rateInput(input: GateRateInput, now: number): void {
    fields(input, ['operationId', 'limit', 'windowMs']);
    // Reuse L04's parameter validation without changing the authoritative counter.
    consumeRateWindow(undefined, { ...input, now });
  }

  async #transaction<T>(operation: (now: number, leases: LeaseStorage) => T): Promise<T> {
    return this.ctx.storage.transaction(async (txn) => {
      const now = Date.now();
      const leases = new LeaseStorage(this.ctx.storage);
      leases.read(now);
      this.#readRate(now);
      this.#readCooldown(now);
      const result = operation(now, leases);
      const active = leases.read(now).leases;
      const rate = this.#readRate(now);
      const cooldown = this.#readCooldown(now);
      let next: number | undefined;
      for (const lease of active) next = next === undefined ? lease.expiresAt : Math.min(next, lease.expiresAt);
      if (rate) next = next === undefined ? rate.windowStartMs + rate.windowMs : Math.min(next, rate.windowStartMs + rate.windowMs);
      if (cooldown) next = next === undefined ? cooldown.cooldownUntil : Math.min(next, cooldown.cooldownUntil);
      // Alarm scheduling belongs to the same SQLite transaction as admission.
      if (next === undefined) await txn.deleteAlarm();
      else await txn.setAlarm(next);
      return result;
    });
  }

  async acquire(input: GateAcquireInput): Promise<GateAcquireResult> {
    fields(input, ['requestId', 'limit', 'ttlMs'], ['rate']);
    return this.#transaction((now, leases) => {
      if (input.rate !== undefined) this.#rateInput(input.rate, now);
      const cooldown = this.#readCooldown(now);
      if (cooldown) return { granted: false, reason: 'cooldown', retryAfterMs: cooldown.cooldownUntil - now } as const;
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
      const result = leases.update<GateAcquireResult & { state: LeaseState }>(now, (state) => {
        const candidate = acquireLease(state, { requestId: input.requestId, leaseToken: token, limit: input.limit, ttlMs: input.ttlMs, now });
        if (!candidate.granted) {
          const nextExpiry = state.leases.reduce((earliest, lease) => Math.min(earliest, lease.expiresAt), Infinity);
          return { state, granted: false, reason: 'capacity', retryAfterMs: Number.isFinite(nextExpiry) ? nextExpiry - now : 0 };
        }
        if (!candidate.duplicate && input.rate !== undefined) {
          const rate = consumeRateWindow(this.#readRate(now), { ...input.rate, now });
          this.ctx.storage.kv.put(GATE_RATE_STORAGE_KEY, JSON.stringify(rate.state));
          if (!rate.allowed) return { state, granted: false, reason: 'rate_limit', retryAfterMs: rate.retryAfterMs };
        }
        return { state: candidate.state, granted: true, duplicate: candidate.duplicate, lease: candidate.lease };
      });
      return result.granted
        ? { granted: true, duplicate: result.duplicate, lease: result.lease }
        : { granted: false, reason: result.reason, retryAfterMs: result.retryAfterMs };
    });
  }

  async renew(input: { requestId: string; leaseToken: string; ttlMs: number }): Promise<GateRenewResult> {
    fields(input, ['requestId', 'leaseToken', 'ttlMs']);
    return this.#transaction((now, leases) => {
      const result = leases.update(now, (state) => renewLease(state, { ...input, now }));
      return result.renewed ? { renewed: true, lease: result.lease } : { renewed: false, reason: result.reason };
    });
  }

  async release(input: { requestId: string; leaseToken: string }): Promise<GateReleaseResult> {
    fields(input, ['requestId', 'leaseToken']);
    return this.#transaction((now, leases) => {
      const result = leases.update(now, (state) => releaseLease(state, { ...input, now }));
      return result.released ? { released: true } : { released: false, reason: result.reason };
    });
  }

  async rateCheck(input: GateRateInput): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number }> {
    fields(input, ['operationId', 'limit', 'windowMs']);
    return this.#transaction((now) => {
      const result = consumeRateWindow(this.#readRate(now), { ...input, now });
      this.ctx.storage.kv.put(GATE_RATE_STORAGE_KEY, JSON.stringify(result.state));
      return { allowed: result.allowed, remaining: result.remaining, retryAfterMs: result.retryAfterMs };
    });
  }

  /** Observe quota without recording an operation; only expiry/alarm housekeeping may write. */
  async ratePeek(input: { limit: number; windowMs: number }): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number }> {
    fields(input, ['limit', 'windowMs']);
    return this.#transaction((now) => {
      this.#rateInput({ ...input, operationId: 'gate-peek-validation' }, now);
      const state = this.#readRate(now);
      if (state && (state.limit !== input.limit || state.windowMs !== input.windowMs)) {
        throw new RateWindowError('configuration_changed');
      }
      const remaining = input.limit - (state?.operationIds.length ?? 0);
      const allowed = remaining > 0;
      const end = state ? state.windowStartMs + state.windowMs : (Math.floor(now / input.windowMs) + 1) * input.windowMs;
      return { allowed, remaining, retryAfterMs: allowed ? 0 : end - now };
    });
  }

  /** Channel callers set a short operational hint, never a permanent channel status. */
  async setCooldown(input: { ttlMs: number; errorClass: GateCooldownClass }): Promise<GateCooldownResult> {
    fields(input, ['ttlMs', 'errorClass']);
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > MAX_COOLDOWN_TTL_MS
      || (input.errorClass !== 'rate_limited' && input.errorClass !== 'auth_rejected')) throw new TypeError('Invalid Gate cooldown input');
    return this.#transaction((now) => {
      const until = now + input.ttlMs;
      if (!Number.isSafeInteger(until)) throw new TypeError('Invalid Gate cooldown deadline');
      const previous = this.#readCooldown(now);
      // Keep the class associated with the winning deadline; retries never shorten it.
      const state: CooldownState = previous && previous.cooldownUntil >= until
        ? previous : { schemaVersion: 1, cooldownUntil: until, errorClass: input.errorClass };
      this.ctx.storage.kv.put(GATE_COOLDOWN_STORAGE_KEY, JSON.stringify(state));
      return { active: true, cooldownUntil: state.cooldownUntil, errorClass: state.errorClass, retryAfterMs: state.cooldownUntil - now } as const;
    });
  }

  async getCooldown(): Promise<GateCooldownResult> {
    return this.#transaction((now) => {
      const state = this.#readCooldown(now);
      return state
        ? { active: true, cooldownUntil: state.cooldownUntil, errorClass: state.errorClass, retryAfterMs: state.cooldownUntil - now } as const
        : { active: false, retryAfterMs: 0 } as const;
    });
  }

  override async alarm(): Promise<void> {
    await this.#transaction(() => undefined);
  }

  override fetch(_request: Request): Response {
    return Response.json(
      {
        error: {
          code: 'not_implemented',
          message: 'Gate HTTP access is not supported; use the internal binding.',
        },
      },
      { status: 501 },
    );
  }
}
