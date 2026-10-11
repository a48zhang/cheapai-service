export const DIAGNOSTIC_RESPONSE_MAX_BYTES = 32_768;

export interface DiagnosticBodyCapture {
  /** The exact retained prefix, bounded by DIAGNOSTIC_RESPONSE_MAX_BYTES. */
  bytes: Uint8Array;
  /** Best-effort display text; an incomplete UTF-8 suffix becomes U+FFFD. */
  text: string;
  capturedBytes: number;
  complete: boolean;
  truncated: boolean;
  utf8Valid: boolean;
  /** Original stream/getReader exception for the caller to classify and redact. */
  error: unknown | null;
}

function decoded(bytes: Uint8Array, fatal: boolean): string {
  return new TextDecoder('utf-8', { fatal, ignoreBOM: true }).decode(bytes);
}

/**
 * Read one response stream into a fixed-size buffer. At the boundary, at most
 * one non-empty stream chunk is observed as a truncation probe; excess bytes
 * are never copied or decoded. The reader is always cancelled and released.
 */
export async function readDiagnosticBody(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes = DIAGNOSTIC_RESPONSE_MAX_BYTES,
): Promise<DiagnosticBodyCapture> {
  const limit =
    Number.isSafeInteger(maxBytes) && maxBytes >= 0
      ? Math.min(maxBytes, DIAGNOSTIC_RESPONSE_MAX_BYTES)
      : DIAGNOSTIC_RESPONSE_MAX_BYTES;
  const storage = new Uint8Array(limit);
  let capturedBytes = 0;
  let complete = stream === null;
  let truncated = false;
  let error: unknown | null = null;

  if (stream !== null) {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      reader = stream.getReader();
      for (;;) {
        const part = await reader.read();
        if (part.done) {
          complete = true;
          break;
        }
        const chunk = part.value;
        if (chunk.byteLength === 0) continue;

        const remaining = limit - capturedBytes;
        const retained = Math.min(remaining, chunk.byteLength);
        if (retained > 0) {
          storage.set(chunk.subarray(0, retained), capturedBytes);
          capturedBytes += retained;
        }
        if (chunk.byteLength > retained) {
          truncated = true;
          break;
        }
        // At exactly the byte limit, the next read is the one-byte logical
        // probe: EOF proves completeness; any non-empty chunk proves truncation.
      }
    } catch (cause) {
      error = cause;
    } finally {
      if (reader !== undefined) {
        try {
          const cancellation = reader.cancel();
          void cancellation.catch(() => undefined);
        } catch {
          /* Preserve the already captured bytes and original read error. */
        }
        try {
          reader.releaseLock();
        } catch {
          /* No effect on the bounded result. */
        }
      }
    }
  }

  const bytes = storage.slice(0, capturedBytes);
  let text = '';
  let utf8Valid = true;
  try {
    text = decoded(bytes, false);
  } catch {
    /* The non-fatal decoder is expected to succeed; keep a safe empty view. */
  }
  try {
    decoded(bytes, true);
  } catch {
    utf8Valid = false;
  }

  return {
    bytes,
    text,
    capturedBytes,
    complete: complete && !truncated && error === null,
    truncated,
    utf8Valid,
    error,
  };
}
