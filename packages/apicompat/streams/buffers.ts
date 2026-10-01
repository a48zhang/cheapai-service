/** Retained payload bytes, not JavaScript object overhead or downstream copies. */
export class BufferLimitError extends Error {
  readonly code = "buffer_limit_exceeded";
  constructor(readonly limitBytes: number, readonly usedBytes: number, readonly requestedBytes: number) {
    super("Stream buffer byte limit exceeded");
    this.name = "BufferLimitError";
  }
}

function requireByteCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Byte count must be a nonnegative safe integer");
}

/** Share one budget between incomplete frames and interleaved tool calls. */
export class ByteBudget {
  private used = 0;
  constructor(readonly maxBytes: number) {
    requireByteCount(maxBytes);
  }

  get usedBytes(): number { return this.used; }
  get remainingBytes(): number { return this.maxBytes - this.used; }

  /** Reserve before retaining data. Release is idempotent and owns this charge only. */
  reserve(bytes: number): () => void {
    requireByteCount(bytes);
    if (bytes > this.remainingBytes) throw new BufferLimitError(this.maxBytes, this.used, bytes);
    this.used += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= bytes;
    };
  }
}

/** TextEncoder's byte length, calculated before allocating an encoded copy. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff &&
      text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3; // Lone surrogates become U+FFFD, just like TextEncoder.
  }
  return bytes;
}

/**
 * Opaque fragment accumulator: never JSON.parse a network chunk/tool delta.
 * append accepts arbitrary byte boundaries; decode only after draining, or use
 * SseByteParser for incremental decoding. appendText accepts already decoded
 * Unicode fragments; a lone UTF-16 surrogate is replaced, not joined next call.
 * drain transfers ownership to the caller; retained output is their budget duty.
 */
export class BoundedByteBuffer {
  private chunks: { bytes: Uint8Array; release: () => void }[] = [];
  private size = 0;
  private cancelled = false;
  constructor(readonly budget: ByteBudget) {}

  get byteLength(): number { return this.size; }

  append(bytes: Uint8Array): void {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("Expected Uint8Array");
    this.retain(bytes.byteLength, () => new Uint8Array(bytes));
  }

  appendText(text: string): void {
    if (typeof text !== "string") throw new TypeError("Expected decoded text");
    this.retain(utf8Length(text), () => new TextEncoder().encode(text));
  }

  private retain(length: number, copy: () => Uint8Array): void {
    if (this.cancelled) throw new DOMException("Buffer was cancelled", "AbortError");
    if (length === 0) return; // Empty chunks must not grow metadata without charge.
    const release = this.budget.reserve(length);
    try {
      this.chunks.push({ bytes: copy(), release });
      this.size += length;
    } catch (error) {
      release();
      throw error;
    }
  }

  drain(): Uint8Array {
    const result = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk.bytes, offset);
      offset += chunk.bytes.byteLength;
    }
    this.clear();
    return result;
  }

  clear(): void {
    for (const chunk of this.chunks) chunk.release();
    this.chunks = [];
    this.size = 0;
  }

  cancel(): void {
    this.cancelled = true;
    this.clear();
  }
}

/**
 * Reads one chunk per consumer pull, with no prefetch or internal chunk queue.
 * The charge remains until the consumer asks for the next chunk, breaks or aborts.
 * This bounds only this helper's retained chunk; producers/downstream parsers must
 * bound their own queues/state. Abort cancels the reader even during a slow yield.
 * No fetch, protocol completion inference or deployment configuration is involved.
 */
export async function* readBoundedBytes(
  source: ReadableStream<Uint8Array>,
  budget: ByteBudget,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array, void, unknown> {
  signal?.throwIfAborted();
  const reader = source.getReader();
  let release: (() => void) | undefined;
  let completed = false;
  let cancellation: Promise<void> | undefined;
  const cancel = (reason?: unknown): Promise<void> => {
    release?.();
    release = undefined;
    cancellation ??= reader.cancel(reason).catch(() => { /* Cleanup cannot replace the original failure. */ });
    return cancellation;
  };
  const onAbort = (): void => { void cancel(signal?.reason); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const result = await reader.read();
      signal?.throwIfAborted();
      if (result.done) {
        completed = true;
        return;
      }
      if (!(result.value instanceof Uint8Array)) throw new TypeError("Expected Uint8Array stream chunks");
      release = budget.reserve(result.value.byteLength);
      yield result.value;
      release?.();
      release = undefined;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    release?.();
    release = undefined;
    if (!completed) await cancel(signal?.reason);
    reader.releaseLock();
  }
}
