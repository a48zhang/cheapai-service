import { describe, expect, it, vi } from 'vitest';
import { sendUpstream } from '../../apps/worker/gateway/transport';
import type { UpstreamRequestOptions } from '../../apps/worker/gateway/transport';

const options: UpstreamRequestOptions = { baseUrl: 'https://provider.example.com/prefix/v1', upstreamProtocol: 'chat', upstreamKey: 'trusted-secret', body: '{"model":"test"}', maxDurationMs: 1000, headersTimeoutMs: 200, idleTimeoutMs: 200 };
describe('single-attempt upstream transport with local fetch mocks', () => {
  it('builds fixed HTTPS endpoints/auth and uses exactly one manual-redirect POST', async () => {
    const mock = vi.fn(async (_url: string, _init: RequestInit) => new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } }));
    const exchange = await sendUpstream(options, { fetch: mock });
    expect(mock).toHaveBeenCalledOnce();
    const [url, init] = mock.mock.calls[0]!;
    expect(url).toBe('https://provider.example.com/prefix/v1/chat/completions');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', body: options.body });
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer trusted-secret');
    expect(await exchange.response.json()).toEqual({ ok: true });
    expect(await exchange.done).toEqual({ ok: true });
  });
  it('rejects invalid targets/timeouts and pre-cancellation without invoking fetch', async () => {
    const mock = vi.fn(async () => new Response('unexpected'));
    for (const patch of [{ baseUrl: 'ftp://provider.example.com' }, { baseUrl: '/relative' }, { headersTimeoutMs: 0 }, { idleTimeoutMs: 1001 }]) {
      await expect(sendUpstream({ ...options, ...patch }, { fetch: mock })).rejects.toMatchObject({ execution: 'not_started', reason: 'invalid_configuration' });
    }
    const controller = new AbortController(); controller.abort('private reason');
    await expect(sendUpstream({ ...options, signal: controller.signal }, { fetch: mock })).rejects.toMatchObject({ execution: 'not_started', reason: 'cancelled' });
    expect(mock).not.toHaveBeenCalled();
  });
  it.each([301, 302, 303, 307, 308])('follows HTTP %s with standard method and credential handling', async (status) => {
    for (const location of ['/new-path?version=preview', 'http://localhost:8080/target']) {
      const mock = vi.fn(async (_url: string, _init: RequestInit) => mock.mock.calls.length === 1
        ? new Response(null, { status, headers: { Location: location } }) : new Response('ok'));
      const exchange = await sendUpstream(options, { fetch: mock });
      expect(await exchange.response.text()).toBe('ok');
      expect(await exchange.done).toEqual({ ok: true });
      expect(mock).toHaveBeenCalledTimes(2);
      const [target, init] = mock.mock.calls[1]!;
      const preservesBody = status === 307 || status === 308;
      expect(target).toBe(new URL(location, options.baseUrl).href);
      expect(init.method).toBe(preservesBody ? 'POST' : 'GET');
      expect(init.body).toBe(preservesBody ? options.body : undefined);
      expect(new Headers(init.headers).get('authorization')).toBe(location.startsWith('/') ? 'Bearer trusted-secret' : null);
    }
  });
  it('removes Messages credentials and configured cookies on a cross-origin redirect', async () => {
    const mock = vi.fn(async (_url: string, _init: RequestInit) => mock.mock.calls.length === 1
      ? new Response(null, { status: 307, headers: { Location: 'https://other.example/target' } }) : new Response('ok'));
    const exchange = await sendUpstream({ ...options, upstreamProtocol: 'messages', customHeaders: { Cookie: 'provider-session' } }, { fetch: mock });
    await exchange.response.text();
    expect(new Headers(mock.mock.calls[0]![1].headers).get('x-api-key')).toBe('trusted-secret');
    expect(new Headers(mock.mock.calls[1]![1].headers).has('x-api-key')).toBe(false);
    expect(new Headers(mock.mock.calls[1]![1].headers).has('cookie')).toBe(false);
  });
  it('bounds redirect loops and does not retry provider errors', async () => {
    const looping = vi.fn(async () => new Response(null, { status: 307, headers: { Location: '/loop' } }));
    await expect(sendUpstream(options, { fetch: looping })).rejects.toMatchObject({ reason: 'network_error', execution: 'uncertain' });
    expect(looping).toHaveBeenCalledTimes(21);
    const mock = vi.fn(async () => new Response('provider error', { status: 503 }));
    const exchange = await sendUpstream(options, { fetch: mock });
    expect(exchange.response.status).toBe(503); await exchange.response.text();
    expect(mock).toHaveBeenCalledOnce();
  });
  it('classifies network and response-header timeout failures as uncertain and aborts even noncooperative fetch', async () => {
    await expect(sendUpstream(options, { fetch: async () => { throw new Error('private provider address/key'); } })).rejects.toMatchObject({ reason: 'network_error', execution: 'uncertain' });
    let signal: AbortSignal | undefined;
    const mock = vi.fn((_url: string, init: RequestInit) => { signal = init.signal ?? undefined; return new Promise<Response>(() => undefined); });
    await expect(sendUpstream({ ...options, headersTimeoutMs: 10 }, { fetch: mock })).rejects.toMatchObject({ reason: 'headers_timeout', execution: 'uncertain' });
    expect(signal?.aborted).toBe(true); expect(mock).toHaveBeenCalledOnce();
  });
  it('returns headers before consuming a body and preserves chunk-by-chunk backpressure', async () => {
    let reads = 0;
    const source = new ReadableStream<Uint8Array>({ pull(controller) { reads++; if (reads <= 2) controller.enqueue(new TextEncoder().encode(String(reads))); else controller.close(); } }, { highWaterMark: 0 });
    const exchange = await sendUpstream(options, { fetch: async () => new Response(source) });
    expect(reads).toBe(0);
    const reader = exchange.response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('1'); expect(reads).toBe(1);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('2'); expect(reads).toBe(2);
    expect((await reader.read()).done).toBe(true);
    expect(await exchange.done).toEqual({ ok: true });
  });
  it('keeps the total deadline after headers and separately detects pending-read idle timeout', async () => {
    for (const [maxDurationMs, idleTimeoutMs, reason] of [[30, 20, 'request_timeout'], [100, 10, 'idle_timeout']] as const) {
      const cancel = vi.fn();
      const source = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
      const exchange = await sendUpstream({ ...options, maxDurationMs, headersTimeoutMs: 10, idleTimeoutMs }, { fetch: async () => new Response(source) });
      if (reason === 'idle_timeout') {
        await expect(exchange.response.text()).rejects.toMatchObject({ reason });
      }
      const completed = await exchange.done;
      expect(completed).toMatchObject({ ok: false, error: { reason, execution: 'uncertain' } });
      expect(cancel).toHaveBeenCalled();
    }
  });
  it('propagates caller/consumer cancellation to the upstream body and abort signal', async () => {
    for (const external of [true, false]) {
      const controller = new AbortController(); const cancelled = vi.fn(); let upstreamSignal: AbortSignal | undefined;
      const source = new ReadableStream<Uint8Array>({ cancel: cancelled }, { highWaterMark: 0 });
      const exchange = await sendUpstream({ ...options, signal: controller.signal }, { fetch: async (_url, init) => { upstreamSignal = init.signal ?? undefined; return new Response(source); } });
      if (external) controller.abort('private cancellation'); else await exchange.response.body!.cancel();
      expect(await exchange.done).toMatchObject({ ok: false, error: { reason: 'cancelled', execution: 'uncertain' } });
      expect(upstreamSignal?.aborted).toBe(true); expect(cancelled).toHaveBeenCalled();
    }
  });
  it('reports body read errors without exposing provider exception details', async () => {
    const source = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('private secret')); } }, { highWaterMark: 0 });
    const exchange = await sendUpstream(options, { fetch: async () => new Response(source) });
    await expect(exchange.response.text()).rejects.toMatchObject({ reason: 'stream_error' });
    const result = await exchange.done;
    expect(result).toMatchObject({ ok: false, error: { reason: 'stream_error', execution: 'uncertain' } });
    expect(JSON.stringify(result)).not.toContain('private secret');
  });
  it('handles synchronous fetch exceptions and cancellation before the dispatch microtask', async () => {
    await expect(sendUpstream(options, { fetch: () => { throw new Error('synchronous private failure'); } })).rejects.toMatchObject({ reason: 'network_error', execution: 'uncertain' });
    const controller = new AbortController();
    const mock = vi.fn(async () => new Response('unexpected'));
    const pending = sendUpstream({ ...options, signal: controller.signal }, { fetch: mock });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: 'cancelled', execution: 'not_started' });
    expect(mock).not.toHaveBeenCalled();
  });
  it('cleans up on an already-locked response and cancels a late response after header timeout', async () => {
    const upstream = new Response('locked');
    const locked = upstream.body!.getReader();
    await expect(sendUpstream(options, { fetch: async () => upstream })).rejects.toMatchObject({ reason: 'stream_error', execution: 'uncertain' });
    await locked.cancel();
    let resolve!: (response: Response) => void;
    const pending = sendUpstream({ ...options, headersTimeoutMs: 10 }, { fetch: () => new Promise<Response>((done) => { resolve = done; }) });
    await expect(pending).rejects.toMatchObject({ reason: 'headers_timeout' });
    const cancel = vi.fn();
    resolve(new Response(new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 })));
    await Promise.resolve(); await Promise.resolve();
    expect(cancel).toHaveBeenCalled();
  });
});
