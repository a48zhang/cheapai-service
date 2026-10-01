import { describe, expect, it } from "vitest";
import { consumeRateWindow, MAX_RATE_WINDOW_OPERATIONS, RateWindowError } from "../../apps/worker/limits/rate-window";
import type { RateWindowInput, RateWindowState } from "../../apps/worker/limits/rate-window";

const input: RateWindowInput = { now: 1050, windowMs: 1000, limit: 2, operationId: "op-1" };

describe("pure fixed rate windows", () => {
  it("admits exactly the limit, deduplicates retries and returns current capacity", () => {
    const first = consumeRateWindow(null, input);
    expect(first).toMatchObject({ allowed: true, remaining: 1, retryAfterMs: 0 });
    const second = consumeRateWindow(first.state, { ...input, operationId: "op-2", now: 1100 });
    expect(second).toMatchObject({ allowed: true, remaining: 0, retryAfterMs: 0 });
    const replay = consumeRateWindow(second.state, { ...input, now: 1200 });
    expect(replay).toMatchObject({ allowed: true, remaining: 0, retryAfterMs: 0 });
    expect(replay.state.operationIds).toEqual(["op-1", "op-2"]);
    const denied = consumeRateWindow(replay.state, { ...input, operationId: "op-3", now: 1500 });
    expect(denied).toMatchObject({ allowed: false, remaining: 0, retryAfterMs: 500 });
    const deniedAgain = consumeRateWindow(denied.state, { ...input, operationId: "op-3", now: 1999 });
    expect(deniedAgain).toMatchObject({ allowed: false, remaining: 0, retryAfterMs: 1 });
    expect(deniedAgain.state.operationIds).toHaveLength(2);
  });

  it("rotates exactly at the epoch boundary and expires all prior operation IDs", () => {
    const first = consumeRateWindow(undefined, { ...input, limit: 1, now: 1999 });
    expect(first.state.windowStartMs).toBe(1000);
    const boundary = consumeRateWindow(first.state, { ...input, limit: 1, now: 2000 });
    expect(boundary).toMatchObject({ allowed: true, remaining: 0 });
    expect(boundary.state.windowStartMs).toBe(2000);
    expect(boundary.state.operationIds).toEqual(["op-1"]);
    const skipped = consumeRateWindow(boundary.state, { ...input, limit: 1, operationId: "new", now: 9500 });
    expect(skipped.state).toMatchObject({ windowStartMs: 9000, operationIds: ["new"] });
  });

  it("handles a zero limit without retaining denial markers", () => {
    let state: RateWindowState | undefined;
    for (let index = 0; index < 200; index += 1) {
      const result = consumeRateWindow(state, { ...input, limit: 0, operationId: `deny-${index}` });
      expect(result).toMatchObject({ allowed: false, remaining: 0, retryAfterMs: 950 });
      state = result.state;
    }
    expect(state?.operationIds).toEqual([]);
  });

  it("round trips storage JSON and never mutates the previous state", () => {
    const first = consumeRateWindow(null, input);
    const restored = JSON.parse(JSON.stringify(first.state));
    Object.freeze(restored.operationIds);
    Object.freeze(restored);
    const result = consumeRateWindow(restored, { ...input, operationId: "op-2" });
    expect(result.state.operationIds).toEqual(["op-1", "op-2"]);
    expect(restored).toEqual(first.state);
    expect(consumeRateWindow(JSON.parse(JSON.stringify(result.state)), input).state).toEqual(result.state);
  });

  it("rejects backwards clocks and changing active-window configuration", () => {
    const state = consumeRateWindow(null, input).state;
    expect(() => consumeRateWindow(state, { ...input, now: 1049 })).toThrow(expect.objectContaining({ code: "clock_regression" }));
    expect(() => consumeRateWindow(state, { ...input, limit: 3 })).toThrow(expect.objectContaining({ code: "configuration_changed" }));
    expect(() => consumeRateWindow(state, { ...input, windowMs: 500 })).toThrow(expect.objectContaining({ code: "configuration_changed" }));
    expect(consumeRateWindow(state, { ...input, now: 2000, limit: 3, windowMs: 500 }).state)
      .toMatchObject({ windowStartMs: 2000, limit: 3, windowMs: 500 });
  });

  it.each([
    { now: -1 }, { now: NaN }, { now: 1.5 }, { now: Infinity }, { now: Number.MAX_SAFE_INTEGER },
    { windowMs: 0 }, { windowMs: -1 }, { windowMs: 0.5 }, { limit: -1 }, { limit: 1.5 },
    { limit: MAX_RATE_WINDOW_OPERATIONS + 1 }, { operationId: "" }, { operationId: "x".repeat(129) },
    { operationId: "contains space" }, { operationId: "你好" }, { operationId: "bad\0id" },
  ])("rejects invalid inputs %j", (change) => {
    expect(() => consumeRateWindow(null, { ...input, ...change })).toThrow(expect.objectContaining({ code: "invalid_parameters" }));
  });

  it("validates corrupt stored state even when its window has expired", () => {
    const valid = consumeRateWindow(null, input).state;
    for (const state of [
      [], {}, { ...valid, version: 2 }, { ...valid, extra: "unexpected" },
      { ...valid, operationIds: ["duplicate", "duplicate"] }, { ...valid, operationIds: ["bad id"] },
      { ...valid, operationIds: ["a", "b", "c"] }, { ...valid, lastSeenMs: 2000 },
      { ...valid, windowStartMs: 999 }, { ...valid, limit: Infinity },
    ]) {
      expect(() => consumeRateWindow(state, { ...input, now: 5000 })).toThrow(RateWindowError);
    }
  });

  it("rejects oversized marker counts and serialized state without evicting live IDs", () => {
    const valid = consumeRateWindow(null, { ...input, limit: MAX_RATE_WINDOW_OPERATIONS }).state;
    expect(() => consumeRateWindow({ ...valid, operationIds: Array(MAX_RATE_WINDOW_OPERATIONS + 1).fill("a") }, input))
      .toThrow(expect.objectContaining({ code: "state_limit_exceeded" }));
    const largeIds = Array.from({ length: 600 }, (_, i) => `${i}-` + "x".repeat(120));
    expect(() => consumeRateWindow({ ...valid, operationIds: largeIds }, input))
      .toThrow(expect.objectContaining({ code: "state_limit_exceeded" }));
    let state = valid;
    let overflowed = false;
    for (let i = 0; i < 600; i += 1) {
      const before = JSON.stringify(state);
      try {
        state = consumeRateWindow(state, { ...input, limit: MAX_RATE_WINDOW_OPERATIONS, operationId: `${i}-` + "x".repeat(120) }).state;
      } catch (error) {
        expect(error).toMatchObject({ code: "state_limit_exceeded" });
        expect(JSON.stringify(state)).toBe(before);
        overflowed = true;
        break;
      }
    }
    expect(overflowed).toBe(true);
    const next = consumeRateWindow(state, { ...input, now: 2000 });
    expect(next.state.operationIds).toEqual(["op-1"]);
  });
});
