import { describe, expect, it, vi } from 'vitest';
import { readGatewayJson } from '../../apps/worker/gateway/read-json';

function input(body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new Request('https://console.example/v1/chat/completions', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body, ...(signal ? { signal } : {}) });
}
describe('bounded generation JSON input', () => {
  it('handles many tiny fragments without retaining every source chunk', async () => {
    const expected = { message: '中文'.repeat(4000) };
    const bytes = new TextEncoder().encode(JSON.stringify(expected));
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, ++offset));
    } }, { highWaterMark: 0 });
    expect(await readGatewayJson(input(body), bytes.length)).toEqual(expected);
  });
  it('decodes a Unicode character split across chunks at the exact byte limit', async () => {
    const bytes = new TextEncoder().encode('{"message":"你好"}');
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close();
    } });
    expect(await readGatewayJson(input(body), bytes.length)).toEqual({ message: '你好' });
  });
  it('counts actual bytes despite a false Content-Length and cancels without draining', async () => {
    const cancel = vi.fn(); let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode('"too big"')); }, cancel }, { highWaterMark: 0 });
    await expect(readGatewayJson(input(body, { 'Content-Length': '1' }), 4)).rejects.toMatchObject({ status: 413, reason: 'body_too_large' });
    expect(pulls).toBe(1); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it.each(['', '{invalid private body', '"\u0000"'])('rejects malformed JSON without exposing input %#', async value => {
    await expect(readGatewayJson(input(value))).rejects.toMatchObject({ reason: 'invalid_json', message: 'Invalid request.' });
  });
  it('rejects invalid UTF8 instead of silently replacing bytes', async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([34, 255, 34])); c.close(); } });
    await expect(readGatewayJson(input(body))).rejects.toMatchObject({ reason: 'invalid_json' });
  });
  it.each([{ 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/json; charset=latin1' }, { 'Content-Encoding': 'gzip' }])('rejects unsupported wire encodings %#', async headers => {
    await expect(readGatewayJson(input('{}', headers))).rejects.toMatchObject({ reason: 'invalid_headers' });
  });
  it('cancels an in-flight stalled read on request abort', async () => {
    const abort = new AbortController(); const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}), cancel });
    const pending = readGatewayJson(input(body, {}, abort.signal));
    abort.abort();
    await expect(pending).rejects.toMatchObject({ reason: 'request_cancelled' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
