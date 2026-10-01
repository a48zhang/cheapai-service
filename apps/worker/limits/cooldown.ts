import { MAX_COOLDOWN_TTL_MS } from './gate';
import type { GateCooldownClass, GateCooldownResult } from './gate';

export const DEFAULT_RATE_COOLDOWN_MS = 60_000;
export const DEFAULT_AUTH_COOLDOWN_MS = 30_000;
export const MIN_CHANNEL_COOLDOWN_MS = 1_000;
const RPC_DISPOSE = (Symbol as SymbolConstructor & { readonly dispose: symbol }).dispose;
export interface CooldownBinding {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): {
    setCooldown(input: { ttlMs: number; errorClass: GateCooldownClass }): Promise<unknown>;
    getCooldown(): Promise<unknown>;
  };
}
export class CooldownClientError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: 'invalid_input' | 'invalid_response' | 'remote_rejected' | 'unavailable') {
    super(`Channel cooldown: ${code}`);
    this.name = 'CooldownClientError';
    this.retryable = code === 'unavailable';
  }
}
export interface ChannelCooldownInput {
  /** Trusted channel identity selected by the server, never an arbitrary DO name. */
  channelId: string;
  status: number;
  retryAfter?: string | null;
}

/**
 * Bounded Retry-After subset: nonnegative integer seconds or canonical IMF-fixdate.
 * Obsolete HTTP-date forms and permissive Date.parse inputs are deliberately rejected.
 * Missing/malformed returns null; zero/past returns 0; valid long delays cap at 5 min.
 */
export function parseRetryAfter(value: unknown, now: number): number | null {
  if (!Number.isSafeInteger(now) || now < 0) throw new CooldownClientError('invalid_input');
  if (typeof value !== 'string' || value.length > 128 || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) return null;
  const text = value.replace(/^[ \t]+|[ \t]+$/g, '');
  if (/^[0-9]{1,10}$/.test(text)) return Math.min(Number(text) * 1000, MAX_COOLDOWN_TTL_MS);
  if (text.length !== 29 || !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(text)) return null;
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== text) return null;
  return Math.min(MAX_COOLDOWN_TTL_MS, Math.max(0, timestamp - now));
}

function fields(value: unknown, required: readonly string[], optional: readonly string[], response = false): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some((key) => !Object.hasOwn(value, key))
    || Reflect.ownKeys(value).some((key) => {
      if (response && key === RPC_DISPOSE && typeof (value as Record<symbol, unknown>)[key] === 'function') return false;
      return typeof key !== 'string' || (!required.includes(key) && !optional.includes(key));
    })) throw new CooldownClientError(response ? 'invalid_response' : 'invalid_input');
  return value as Record<string, unknown>;
}

function requireChannel(channelId: string): void {
  if (typeof channelId !== 'string' || channelId.length < 1 || channelId.length > 128 || /[^A-Za-z0-9_-]/.test(channelId)) {
    throw new CooldownClientError('invalid_input');
  }
}

function remoteError(error: unknown): CooldownClientError {
  if (error && typeof error === 'object') {
    const info = error as { name?: unknown; code?: unknown };
    if (info.name === 'TypeError' || info.name === 'RangeError'
      || (typeof info.code === 'string' && ['invalid_parameters', 'invalid_state', 'configuration_changed', 'LEASE_STORAGE_INVALID'].includes(info.code))) {
      return new CooldownClientError('remote_rejected');
    }
  }
  return new CooldownClientError('unavailable');
}

function channelStub(binding: CooldownBinding, channelId: string): ReturnType<CooldownBinding['get']> {
  requireChannel(channelId);
  try { return binding.get(binding.idFromName(`channel:${channelId}`)); }
  catch (error) { throw remoteError(error); }
}

async function callCooldown(invoke: () => Promise<unknown>, requireActive = false): Promise<GateCooldownResult> {
  let raw: unknown;
  try { raw = await invoke(); } catch (error) { throw remoteError(error); }
  try {
    const result = fields(raw, ['active', 'retryAfterMs'], ['cooldownUntil', 'errorClass'], true);
    if (result.active === false && !requireActive) {
      fields(result, ['active', 'retryAfterMs'], [], true);
      if (result.retryAfterMs !== 0) throw new CooldownClientError('invalid_response');
      return { active: false, retryAfterMs: 0 };
    }
    fields(result, ['active', 'cooldownUntil', 'errorClass', 'retryAfterMs'], [], true);
    if (result.active !== true || typeof result.cooldownUntil !== 'number' || !Number.isSafeInteger(result.cooldownUntil)
      || typeof result.retryAfterMs !== 'number' || !Number.isSafeInteger(result.retryAfterMs)
      || result.retryAfterMs <= 0 || result.retryAfterMs > MAX_COOLDOWN_TTL_MS || result.cooldownUntil < result.retryAfterMs
      || (result.errorClass !== 'rate_limited' && result.errorClass !== 'auth_rejected')) throw new CooldownClientError('invalid_response');
    return { active: true, cooldownUntil: result.cooldownUntil, errorClass: result.errorClass, retryAfterMs: result.retryAfterMs };
  } finally {
    if (raw && typeof raw === 'object') {
      const dispose = (raw as Record<symbol, unknown>)[RPC_DISPOSE];
      if (typeof dispose === 'function') {
        try { dispose.call(raw); } catch { throw new CooldownClientError('invalid_response'); }
      }
    }
  }
}

/** Selection hint only; Gate.acquire performs the final authoritative cooldown check. */
export async function getChannelCooldown(binding: CooldownBinding, channelId: string): Promise<GateCooldownResult> {
  const stub = channelStub(binding, channelId);
  return callCooldown(() => stub.getCooldown());
}

/** Persist only a bounded class/deadline via the channel Gate, never raw errors or D1 status. */
export async function recordChannelCooldown(
  binding: CooldownBinding,
  input: ChannelCooldownInput,
  options: { clock?: () => number } = {},
): Promise<{ applied: false } | { applied: true; cooldown: Extract<GateCooldownResult, { active: true }> }> {
  fields(input, ['channelId', 'status'], ['retryAfter']);
  fields(options, [], ['clock']);
  requireChannel(input.channelId);
  if (!Number.isInteger(input.status) || input.status < 100 || input.status > 599
    || (options.clock !== undefined && typeof options.clock !== 'function')) throw new CooldownClientError('invalid_input');
  if (input.status !== 429 && input.status !== 401 && input.status !== 403) return { applied: false };
  const errorClass: GateCooldownClass = input.status === 429 ? 'rate_limited' : 'auth_rejected';
  const parsed = parseRetryAfter(input.retryAfter, (options.clock ?? Date.now)());
  // Even Retry-After: 0 gets a one-second local anti-hammering floor for these errors.
  const ttlMs = Math.max(MIN_CHANNEL_COOLDOWN_MS, parsed ?? (input.status === 429 ? DEFAULT_RATE_COOLDOWN_MS : DEFAULT_AUTH_COOLDOWN_MS));
  const stub = channelStub(binding, input.channelId);
  const cooldown = await callCooldown(() => stub.setCooldown({ ttlMs, errorClass }), true);
  if (!cooldown.active) throw new CooldownClientError('invalid_response');
  return { applied: true, cooldown };
}
