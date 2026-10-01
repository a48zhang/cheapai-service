import type { GateAcquireInput } from './gate';
import type { Lease } from './leases';
import { MAX_RATE_WINDOW_OPERATIONS } from './rate-window';

// Workers exposes RPC disposal without requiring the ESNext lib in app config.
const RPC_DISPOSE = (Symbol as SymbolConstructor & { readonly dispose: symbol }).dispose;

export interface LeaseBinding {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): {
    acquire(input: GateAcquireInput): Promise<unknown>;
    renew(input: { requestId: string; leaseToken: string; ttlMs: number }): Promise<unknown>;
    release(input: { requestId: string; leaseToken: string }): Promise<unknown>;
  };
}
export interface LeaseSubject { readonly kind: 'user' | 'channel'; readonly id: string }
export interface LeaseHandle extends Lease { readonly subject: LeaseSubject }
export interface LeaseAcquireInput {
  /** Server-generated logical operation ID; never copy a request body/header ID. */
  requestId: string;
  limit: number;
  ttlMs: number;
  rate?: { limit: number; windowMs: number };
}
export type LeaseAcquireOutcome =
  | { granted: true; duplicate: boolean; handle: LeaseHandle }
  | { granted: false; reason: 'capacity' | 'rate_limit' | 'cooldown'; retryAfterMs: number };
export type LeaseRenewOutcome =
  | { renewed: true; handle: LeaseHandle }
  | { renewed: false; reason: 'missing' | 'expired' | 'token_mismatch' | 'clock_regression' };
export type LeaseReleaseOutcome =
  | { released: true }
  | { released: false; reason: 'missing' | 'token_mismatch' };
export type LeaseClientErrorCode = 'invalid_input' | 'invalid_handle' | 'invalid_response' | 'remote_rejected' | 'unavailable';

export class LeaseClientError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: LeaseClientErrorCode) {
    super(`Internal lease client: ${code}`);
    this.name = 'LeaseClientError';
    this.retryable = code === 'unavailable';
  }
}

function record(value: unknown, required: readonly string[], optional: readonly string[], code: LeaseClientErrorCode): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some((key) => !Object.hasOwn(value, key))
    || Reflect.ownKeys(value).some((key) => {
      if (code === 'invalid_response' && key === RPC_DISPOSE && typeof (value as Record<symbol, unknown>)[RPC_DISPOSE] === 'function') return false;
      return typeof key !== 'string' || (!required.includes(key) && !optional.includes(key));
    })) {
    throw new LeaseClientError(code);
  }
  return value as Record<string, unknown>;
}

function safeInteger(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function remoteError(error: unknown): LeaseClientError {
  if (error && typeof error === 'object') {
    const info = error as { name?: unknown; code?: unknown };
    if (info.name === 'TypeError' || info.name === 'RangeError'
      || (typeof info.code === 'string' && ['invalid_parameters', 'configuration_changed', 'invalid_state', 'state_limit_exceeded', 'LEASE_STORAGE_INVALID'].includes(info.code))) {
      return new LeaseClientError('remote_rejected');
    }
  }
  return new LeaseClientError('unavailable');
}

function parseLease(value: unknown, requestId: string): Lease {
  const lease = record(value, ['requestId', 'leaseToken', 'acquiredAt', 'expiresAt'], ['lastRenewedAt'], 'invalid_response');
  if (lease.requestId !== requestId || typeof lease.leaseToken !== 'string' || lease.leaseToken.length !== 64
    || /[^a-f0-9]/.test(lease.leaseToken) || !safeInteger(lease.acquiredAt, 0)
    || !safeInteger(lease.expiresAt, 0) || lease.expiresAt <= lease.acquiredAt
    || (Object.hasOwn(lease, 'lastRenewedAt') && (!safeInteger(lease.lastRenewedAt, lease.acquiredAt) || lease.lastRenewedAt >= lease.expiresAt))) {
    throw new LeaseClientError('invalid_response');
  }
  return {
    requestId, leaseToken: lease.leaseToken, acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt,
    ...(lease.lastRenewedAt === undefined ? {} : { lastRenewedAt: lease.lastRenewedAt as number }),
  };
}

/**
 * One trusted subject per client. Retain the client alongside issued handles.
 * No HTTP transport, automatic retries, local quota counters or generated lease tokens.
 * A transport failure can leave an admitted lease: retry the same internal requestId
 * to recover it, or rely on DO expiry; never assume the acquisition did not commit.
 */
export class LeaseClient {
  readonly subject: LeaseSubject;
  readonly #stub: ReturnType<LeaseBinding['get']>;
  readonly #handles = new WeakSet<object>();

  constructor(binding: LeaseBinding, subject: LeaseSubject) {
    record(subject, ['kind', 'id'], [], 'invalid_input');
    if ((subject.kind !== 'user' && subject.kind !== 'channel') || typeof subject.id !== 'string'
      || subject.id.length < 1 || subject.id.length > 128 || /[^A-Za-z0-9_-]/.test(subject.id)) {
      throw new LeaseClientError('invalid_input');
    }
    this.subject = Object.freeze({ kind: subject.kind, id: subject.id });
    try {
      this.#stub = binding.get(binding.idFromName(`${subject.kind}:${subject.id}`));
    } catch (error) {
      throw remoteError(error);
    }
    if (!this.#stub || (['acquire', 'renew', 'release'] as const).some((method) => typeof this.#stub[method] !== 'function')) {
      throw new LeaseClientError('invalid_response');
    }
  }

  #issue(lease: Lease): LeaseHandle {
    const handle = Object.freeze({ ...lease, subject: this.subject });
    this.#handles.add(handle);
    return handle;
  }

  #requireHandle(handle: LeaseHandle): void {
    if (!handle || typeof handle !== 'object' || !this.#handles.has(handle)
      || handle.subject.kind !== this.subject.kind || handle.subject.id !== this.subject.id) {
      throw new LeaseClientError('invalid_handle');
    }
  }

  async #call<T>(invoke: () => Promise<unknown>, parse: (value: unknown) => T): Promise<T> {
    let raw: unknown;
    try { raw = await invoke(); } catch (error) { throw remoteError(error); }
    try {
      return parse(raw);
    } finally {
      // Cloudflare adds this disposer to RPC object results. Handles contain only
      // validated copied data, so no remote object needs to outlive this call.
      if (raw && typeof raw === 'object') {
        const dispose = (raw as Record<symbol, unknown>)[RPC_DISPOSE];
        if (typeof dispose === 'function') {
          try { dispose.call(raw); } catch { throw new LeaseClientError('invalid_response'); }
        }
      }
    }
  }

  async acquire(input: LeaseAcquireInput): Promise<LeaseAcquireOutcome> {
    record(input, ['requestId', 'limit', 'ttlMs'], ['rate'], 'invalid_input');
    if (typeof input.requestId !== 'string' || input.requestId.length < 1 || input.requestId.length > 128
      || /[^A-Za-z0-9._:-]/.test(input.requestId) || !/^[A-Za-z0-9]/.test(input.requestId)
      || !safeInteger(input.limit, 0) || !safeInteger(input.ttlMs, 1)) throw new LeaseClientError('invalid_input');
    let rate: GateAcquireInput['rate'];
    if (input.rate !== undefined) {
      record(input.rate, ['limit', 'windowMs'], [], 'invalid_input');
      if (!safeInteger(input.rate.limit, 0) || input.rate.limit > MAX_RATE_WINDOW_OPERATIONS || !safeInteger(input.rate.windowMs, 1)) {
        throw new LeaseClientError('invalid_input');
      }
      rate = { limit: input.rate.limit, windowMs: input.rate.windowMs, operationId: input.requestId };
    }
    const rpcInput: GateAcquireInput = { requestId: input.requestId, limit: input.limit, ttlMs: input.ttlMs, ...(rate ? { rate } : {}) };
    return this.#call(() => this.#stub.acquire(rpcInput), (raw): LeaseAcquireOutcome => {
      const result = record(raw, ['granted'], ['duplicate', 'lease', 'reason', 'retryAfterMs'], 'invalid_response');
      if (result.granted === true) {
        record(result, ['granted', 'duplicate', 'lease'], [], 'invalid_response');
        if (typeof result.duplicate !== 'boolean') throw new LeaseClientError('invalid_response');
        return { granted: true, duplicate: result.duplicate, handle: this.#issue(parseLease(result.lease, rpcInput.requestId)) };
      }
      record(result, ['granted', 'reason', 'retryAfterMs'], [], 'invalid_response');
      if (result.granted !== false || (result.reason !== 'capacity' && result.reason !== 'rate_limit' && result.reason !== 'cooldown') || !safeInteger(result.retryAfterMs, 0)) {
        throw new LeaseClientError('invalid_response');
      }
      return { granted: false, reason: result.reason, retryAfterMs: result.retryAfterMs };
    });
  }

  async renew(handle: LeaseHandle, ttlMs: number): Promise<LeaseRenewOutcome> {
    this.#requireHandle(handle);
    if (!safeInteger(ttlMs, 1)) throw new LeaseClientError('invalid_input');
    return this.#call(() => this.#stub.renew({ requestId: handle.requestId, leaseToken: handle.leaseToken, ttlMs }), (raw): LeaseRenewOutcome => {
      const result = record(raw, ['renewed'], ['lease', 'reason'], 'invalid_response');
      if (result.renewed === true) {
        record(result, ['renewed', 'lease'], [], 'invalid_response');
        const lease = parseLease(result.lease, handle.requestId);
        if (lease.leaseToken !== handle.leaseToken || lease.acquiredAt !== handle.acquiredAt || lease.expiresAt < handle.expiresAt
          || lease.lastRenewedAt === undefined || lease.lastRenewedAt < (handle.lastRenewedAt ?? handle.acquiredAt)) {
          throw new LeaseClientError('invalid_response');
        }
        return { renewed: true, handle: this.#issue(lease) };
      }
      record(result, ['renewed', 'reason'], [], 'invalid_response');
      if (result.renewed !== false || typeof result.reason !== 'string' || !['missing', 'expired', 'token_mismatch', 'clock_regression'].includes(result.reason)) {
        throw new LeaseClientError('invalid_response');
      }
      return { renewed: false, reason: result.reason as Extract<LeaseRenewOutcome, { renewed: false }>['reason'] };
    });
  }

  async release(handle: LeaseHandle): Promise<LeaseReleaseOutcome> {
    this.#requireHandle(handle);
    return this.#call(() => this.#stub.release({ requestId: handle.requestId, leaseToken: handle.leaseToken }), (raw): LeaseReleaseOutcome => {
      const result = record(raw, ['released'], ['reason'], 'invalid_response');
      if (result.released === true) {
        record(result, ['released'], [], 'invalid_response');
        return { released: true };
      }
      record(result, ['released', 'reason'], [], 'invalid_response');
      if (result.released !== false || (result.reason !== 'missing' && result.reason !== 'token_mismatch')) throw new LeaseClientError('invalid_response');
      return { released: false, reason: result.reason };
    });
  }
}
