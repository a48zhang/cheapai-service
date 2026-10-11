import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTIC_RESPONSE_MAX_BYTES,
  readDiagnosticBody,
} from '../../apps/worker/gateway/diagnostic-body';

describe('bounded diagnostic response capture', () => {
  it('keeps at most the configured prefix and cancels after the truncation probe', async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          if (pulls === 1) controller.enqueue(new TextEncoder().encode('abcdefghij'));
          else controller.enqueue(new TextEncoder().encode('must not be read'));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );

    const capture = await readDiagnosticBody(stream, 6);
    expect(capture.text).toBe('abcdef');
    expect(capture.bytes.byteLength).toBe(6);
    expect(capture.capturedBytes).toBe(6);
    expect(capture.complete).toBe(false);
    expect(capture.truncated).toBe(true);
    expect(pulls).toBe(1);
    expect(cancelled).toBe(true);
    expect(capture.capturedBytes).toBeLessThanOrEqual(DIAGNOSTIC_RESPONSE_MAX_BYTES);
  });

  it('never lets a caller raise the hard 32 KiB capture ceiling', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(DIAGNOSTIC_RESPONSE_MAX_BYTES + 1));
      },
    });

    const capture = await readDiagnosticBody(stream, DIAGNOSTIC_RESPONSE_MAX_BYTES + 1024);
    expect(capture.capturedBytes).toBe(DIAGNOSTIC_RESPONSE_MAX_BYTES);
    expect(capture.bytes.byteLength).toBe(DIAGNOSTIC_RESPONSE_MAX_BYTES);
    expect(capture.truncated).toBe(true);
    expect(capture.complete).toBe(false);
  });

  it('reports a complete body exactly at the boundary and preserves UTF-8 validity', async () => {
    const exactStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('123456'));
        controller.close();
      },
    });
    const exact = await readDiagnosticBody(exactStream, 6);
    expect(exact.text).toBe('123456');
    expect(exact.complete).toBe(true);
    expect(exact.truncated).toBe(false);
    expect(exact.capturedBytes).toBe(6);

    const utf8Stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x41, 0xf0, 0x9f]));
        controller.close();
      },
    });
    const utf8 = await readDiagnosticBody(utf8Stream, 3);
    expect(utf8.text).toBe('A\uFFFD');
    expect(utf8.utf8Valid).toBe(false);
    expect(utf8.complete).toBe(true);
  });

  it('retains bytes read before a stream exception', async () => {
    const failure = new Error('provider stream interrupted');
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('partial response'));
          else controller.error(failure);
        },
      },
      { highWaterMark: 0 },
    );

    const capture = await readDiagnosticBody(stream, 64);
    expect(capture.text).toBe('partial response');
    expect(capture.bytes.byteLength).toBe(capture.capturedBytes);
    expect(capture.complete).toBe(false);
    expect(capture.truncated).toBe(false);
    expect(capture.error).toBe(failure);
  });

  it('returns an explicit empty result when no response stream exists', async () => {
    await expect(readDiagnosticBody(null)).resolves.toMatchObject({
      text: '',
      capturedBytes: 0,
      complete: true,
      truncated: false,
      utf8Valid: true,
      error: null,
    });
  });
});
