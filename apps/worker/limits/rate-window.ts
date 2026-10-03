/** Defensive state caps, not deployment rate-limit defaults. */
export const MAX_RATE_WINDOW_OPERATIONS = 4096;
export const MAX_RATE_OPERATION_ID_LENGTH = 128;
export const MAX_RATE_WINDOW_STATE_BYTES = 64 * 1024;

/** Shared finite business RPM range; unlimited sentinels belong to config. */
export function isFiniteRpmLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_RATE_WINDOW_OPERATIONS;
}

export class RateWindowError extends Error {
  constructor(readonly code: "invalid_parameters" | "invalid_state" | "state_limit_exceeded" | "clock_regression" | "configuration_changed") {
    super(`Fixed rate window: ${code}`);
    this.name = "RateWindowError";
  }
}

export interface RateWindowInput {
  readonly now: number;
  readonly windowMs: number;
  readonly limit: number;
  /** Stable per logical operation and scoped to this counter's subject. */
  readonly operationId: string;
}

export interface RateWindowState {
  readonly version: 1;
  readonly windowStartMs: number;
  readonly windowMs: number;
  readonly limit: number;
  readonly lastSeenMs: number;
  /** Accepted operations only; length is the authoritative count. */
  readonly operationIds: readonly string[];
}

export interface RateWindowResult {
  readonly state: RateWindowState;
  readonly allowed: boolean;
  readonly retryAfterMs: number;
  /** Current capacity; a replay does not restore its original capacity snapshot. */
  readonly remaining: number;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_RATE_OPERATION_ID_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function validSettings(windowMs: unknown, limit: unknown): boolean {
  return nonnegativeInteger(windowMs) && windowMs > 0 &&
    (limit === 0 || isFiniteRpmLimit(limit));
}

function checkSize(state: RateWindowState): void {
  // All field names, numbers and validated IDs are ASCII, so chars equal UTF-8 bytes.
  if (JSON.stringify(state).length > MAX_RATE_WINDOW_STATE_BYTES) throw new RateWindowError("state_limit_exceeded");
}

/** Validate restored JSON before any expiry reset; corrupt state must not grant access. */
function validateState(value: unknown): RateWindowState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RateWindowError("invalid_state");
  const record = value as Record<string, unknown>;
  const fields = ["version", "windowStartMs", "windowMs", "limit", "lastSeenMs", "operationIds"];
  if (Object.keys(record).length !== fields.length || fields.some((field) => !Object.hasOwn(record, field))) {
    throw new RateWindowError("invalid_state");
  }
  if (record.version !== 1 || !validSettings(record.windowMs, record.limit) ||
    !nonnegativeInteger(record.windowStartMs) || !nonnegativeInteger(record.lastSeenMs) || !Array.isArray(record.operationIds)) {
    throw new RateWindowError("invalid_state");
  }
  const state = value as RateWindowState;
  const end = state.windowStartMs + state.windowMs;
  if (!Number.isSafeInteger(end) || state.windowStartMs % state.windowMs !== 0 ||
    state.lastSeenMs < state.windowStartMs || state.lastSeenMs >= end) throw new RateWindowError("invalid_state");
  if (state.operationIds.length > MAX_RATE_WINDOW_OPERATIONS) throw new RateWindowError("state_limit_exceeded");
  if (state.operationIds.length > state.limit) throw new RateWindowError("invalid_state");
  const ids = new Set<string>();
  for (const id of state.operationIds) {
    if (!validId(id) || ids.has(id)) throw new RateWindowError("invalid_state");
    ids.add(id);
  }
  checkSize(state);
  return state;
}

/**
 * Pure transition for one subject's epoch-aligned fixed-window counter.
 * Caller must serialize read/transition/write in its DO; this is not an RPC or
 * concurrent storage primitive. Neither input is mutated. Store the returned
 * state before treating admission as committed; the operation ID deduplicates a
 * retry only while this window is active. A boundary starts a fresh allowance.
 *
 * Denials need no markers: with immutable settings, no capacity becomes free
 * inside a window. Expiry drops all old markers. Exhausting the state byte cap
 * throws rather than evicting live IDs or silently allowing a duplicate charge.
 */
export function consumeRateWindow(previous: unknown, input: RateWindowInput): RateWindowResult {
  if (typeof input !== "object" || input === null || !nonnegativeInteger(input.now) ||
    !validSettings(input.windowMs, input.limit) || !validId(input.operationId)) throw new RateWindowError("invalid_parameters");
  const windowStartMs = Math.floor(input.now / input.windowMs) * input.windowMs;
  if (!Number.isSafeInteger(windowStartMs + input.windowMs)) throw new RateWindowError("invalid_parameters");

  let state: RateWindowState;
  if (previous !== undefined && previous !== null) {
    const restored = validateState(previous);
    if (input.now < restored.lastSeenMs) throw new RateWindowError("clock_regression");
    if (input.now < restored.windowStartMs + restored.windowMs) {
      if (input.windowMs !== restored.windowMs || input.limit !== restored.limit) throw new RateWindowError("configuration_changed");
      state = { ...restored, lastSeenMs: input.now, operationIds: [...restored.operationIds] };
    } else {
      state = { version: 1, windowStartMs, windowMs: input.windowMs, limit: input.limit, lastSeenMs: input.now, operationIds: [] };
    }
  } else {
    state = { version: 1, windowStartMs, windowMs: input.windowMs, limit: input.limit, lastSeenMs: input.now, operationIds: [] };
  }

  const replay = state.operationIds.includes(input.operationId);
  const allowed = replay || state.operationIds.length < state.limit;
  if (allowed && !replay) {
    // Bound before extending the accepted-operation array.
    const projectedBytes = JSON.stringify(state).length + JSON.stringify(input.operationId).length +
      (state.operationIds.length === 0 ? 0 : 1);
    if (projectedBytes > MAX_RATE_WINDOW_STATE_BYTES) throw new RateWindowError("state_limit_exceeded");
    state = { ...state, operationIds: [...state.operationIds, input.operationId] };
  }
  checkSize(state); // lastSeenMs may grow in digit count even on a denial/replay.
  return {
    state,
    allowed,
    retryAfterMs: allowed ? 0 : state.windowStartMs + state.windowMs - input.now,
    remaining: state.limit - state.operationIds.length,
  };
}
