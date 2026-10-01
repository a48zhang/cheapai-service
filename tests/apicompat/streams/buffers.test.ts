import { describe, expect, it, vi } from "vitest";
import { BoundedByteBuffer, BufferLimitError, ByteBudget, readBoundedBytes } from "../../../packages/apicompat/streams/buffers.js";

describe("shared byte budgets and fragment buffers", () => {
  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid limits %j", (value) => {
    expect(() => new ByteBudget(value)).toThrow(RangeError);
  });

  it("checks before growth and releases each reservation exactly once", () => {
    const budget = new ByteBudget(4);
    const release = budget.reserve(3);
    expect(() => budget.reserve(2)).toThrow(BufferLimitError);
    expect(() => budget.reserve(-1)).toThrow(RangeError);
    expect(budget.usedBytes).toBe(3);
    release();
    release();
    expect(budget.remainingBytes).toBe(4);
    const zero = new ByteBudget(0);
    zero.reserve(0)();
    expect(() => zero.reserve(1)).toThrow(BufferLimitError);
  });

  it("counts UTF-8 bytes rather than JS characters and leaves prior content on overflow", () => {
    const budget = new ByteBudget(9);
    const buffer = new BoundedByteBuffer(budget);
    buffer.appendText("é中🧭"); // 2 + 3 + 4 bytes.
    expect(buffer.byteLength).toBe(9);
    try {
      buffer.appendText("秘密");
      throw new Error("Expected a limit error");
    } catch (error) {
      expect(error).toBeInstanceOf(BufferLimitError);
      expect(error).toMatchObject({ code: "buffer_limit_exceeded", limitBytes: 9, usedBytes: 9, requestedBytes: 6 });
      expect((error as Error).message).not.toContain("秘密");
    }
    expect(new TextDecoder().decode(buffer.drain())).toBe("é中🧭");
    expect(budget.usedBytes).toBe(0);
  });

  it("accounts for Unicode boundaries and lone surrogate replacement", () => {
    for (const text of ["a", "\u007f", "\u0080", "\u07ff", "\u0800", "\ud800", "\udc00", "🧭", "e\u0301"]) {
      const bytes = new TextEncoder().encode(text);
      const budget = new ByteBudget(bytes.byteLength);
      const buffer = new BoundedByteBuffer(budget);
      buffer.appendText(text);
      expect(buffer.byteLength).toBe(bytes.byteLength);
      expect(buffer.drain()).toEqual(bytes);
      expect(budget.usedBytes).toBe(0);
    }
  });

  it("shares a cap across incomplete frames and interleaved opaque tool fragments", () => {
    const budget = new ByteBudget(20);
    const frame = new BoundedByteBuffer(budget);
    const tool = new BoundedByteBuffer(budget);
    frame.appendText("data: {");
    tool.appendText('{"a":');
    tool.appendText('"中'); // Not independently valid JSON.
    expect(budget.usedBytes).toBe(16);
    expect(() => tool.appendText("12345")).toThrow(BufferLimitError);
    frame.clear();
    frame.clear();
    tool.appendText('"}');
    expect(new TextDecoder().decode(tool.drain())).toBe('{"a":"中"}');
    expect(budget.usedBytes).toBe(0);
  });

  it("copies only a byte view, accepts split UTF-8 and cleans up on cancellation", () => {
    const budget = new ByteBudget(4);
    const buffer = new BoundedByteBuffer(budget);
    const source = Uint8Array.of(99, 0xf0, 0x9f, 99);
    buffer.append(source.subarray(1, 3));
    source.fill(0);
    buffer.append(Uint8Array.of(0xa7, 0xad));
    expect(new TextDecoder().decode(buffer.drain())).toBe("🧭");
    buffer.appendText("abc");
    buffer.cancel();
    buffer.cancel();
    expect(buffer.byteLength).toBe(0);
    expect(budget.usedBytes).toBe(0);
    expect(() => buffer.appendText("x")).toThrow(/cancelled/);
  });
});

describe("readBoundedBytes consumer backpressure", () => {
  it("does not read ahead while a slow consumer holds a chunk; break releases/cancels", async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; controller.enqueue(Uint8Array.of(pulls)); },
      cancel,
    }, { highWaterMark: 0 });
    const budget = new ByteBudget(1);
    const iterator = readBoundedBytes(source, budget);
    expect(pulls).toBe(0);
    expect((await iterator.next()).value).toEqual(Uint8Array.of(1));
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    expect(pulls).toBe(1);
    expect(budget.usedBytes).toBe(1);
    expect((await iterator.next()).value).toEqual(Uint8Array.of(2));
    expect(budget.usedBytes).toBe(1);
    await iterator.return();
    expect(budget.usedBytes).toBe(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });

  it("rejects oversized chunks before yielding and closes the source", async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(4)); }, cancel }, { highWaterMark: 0 });
    const budget = new ByteBudget(3);
    await expect(readBoundedBytes(source, budget).next()).rejects.toBeInstanceOf(BufferLimitError);
    expect(budget.usedBytes).toBe(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });

  it("abort releases a yielded chunk immediately without waiting for the consumer", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(Uint8Array.of(1)); }, cancel }, { highWaterMark: 0 });
    const budget = new ByteBudget(1);
    const iterator = readBoundedBytes(source, budget, controller.signal);
    await iterator.next();
    controller.abort();
    expect(budget.usedBytes).toBe(0);
    expect(cancel).toHaveBeenCalledOnce();
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(source.locked).toBe(false);
  });

  it("abort interrupts a pending read and removes the reader lock", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const budget = new ByteBudget(1);
    const iterator = readBoundedBytes(source, budget, controller.signal);
    const pending = iterator.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(budget.usedBytes).toBe(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });

  it("handles natural EOF, upstream errors and pre-aborted reads without leaking", async () => {
    const budget = new ByteBudget(1);
    const source = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
    expect(await readBoundedBytes(source, budget).next()).toEqual({ value: undefined, done: true });
    expect(source.locked).toBe(false);
    const failure = new Error("upstream failed");
    const failed = new ReadableStream<Uint8Array>({ start(c) { c.error(failure); } });
    await expect(readBoundedBytes(failed, budget).next()).rejects.toBe(failure);
    expect(failed.locked).toBe(false);
    const idle = new ReadableStream<Uint8Array>({}, { highWaterMark: 0 });
    await expect(readBoundedBytes(idle, budget, AbortSignal.abort()).next()).rejects.toMatchObject({ name: "AbortError" });
    expect(idle.locked).toBe(false);
    expect(budget.usedBytes).toBe(0);
  });
});
