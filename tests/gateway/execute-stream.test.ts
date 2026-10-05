import { runInDurableObject, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatRequestAdapter } from '../../packages/apicompat/passthrough/chat';
import { chatStreamAdapter } from '../../packages/apicompat/passthrough/chat-stream';
import { executeStream, StreamExecutionError } from '../../apps/worker/gateway/execute-stream';
import { admitRequest } from '../../apps/worker/gateway/admit';
import type { AdmittedRequest } from '../../apps/worker/gateway/admit';
import { authenticatePlatformKey } from '../../apps/worker/auth/api-key-auth';
import { generateToken, hashToken } from '../../apps/worker/auth/tokens';
import { LeaseStorage } from '../../apps/worker/limits/storage';
import { getRequest } from '../../apps/worker/gateway/request-repository';
import { createRequestFinalizer } from '../../apps/worker/gateway/finalize';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

let admission: AdmittedRequest;
const encoder = new TextEncoder();
const adapters = { request: chatRequestAdapter, stream: chatStreamAdapter };
const chunk = (delta: object = {}, finish: string | null = null) => JSON.stringify({ id: 'native-stream-id', object: 'chat.completion.chunk', created: 1,
  model: 'provider-model', choices: [{ index: 0, delta, finish_reason: finish }] });
const usage = JSON.stringify({ id: 'native-stream-id', object: 'chat.completion.chunk', created: 1, model: 'provider-model', choices: [],
  usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
const frame = (data: string) => encoder.encode(`data: ${data}\n\n`);
const sourceResponse = (source: ReadableStream<Uint8Array>) => new Response(source, { headers: { 'Content-Type': 'text/event-stream' } });
const active = (name: string) => runInDurableObject(testEnv.GATE.get(testEnv.GATE.idFromName(name)), (_instance, context) => new LeaseStorage(context.storage).read(Date.now()).leases.length);
const dependencies = (fetcher: (url: string, init: RequestInit) => Promise<Response>) => ({ database: testEnv.DB, fetch: fetcher });

beforeEach(async () => {
  const now = Date.now();
  await prepare(testEnv.DB, "INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('g08-group','G08 Group','active',1,0,0)").run();
  await prepare(testEnv.DB, `INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES('g08-user','g08@example.invalid','test-only-hash','user','active','g08-group',100,1,60,'admin',0,0)`).run();
  const token = generateToken('apiKey');
  await prepare(testEnv.DB, `INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at)
    VALUES('g08-key','g08-user',?,'s2a_key_ABCDEFGH','G08 Key','active',0,0)`, [await hashToken('apiKey', token)]).run();

  const credential = 'synthetic-upstream-secret';
  await prepare(testEnv.DB, `INSERT INTO channels(id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES('g08-channel','G08 Channel','https://provider.example.com/',?,'active',1,2,60,1,0,0)`, [credential]).run();
  await prepare(testEnv.DB, `INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('g08-model','active',?,1,10,4096,0,0)`, [JSON.stringify({ input: '1', output: '2' })]).run();
  await prepare(testEnv.DB, "INSERT INTO channel_groups(channel_id,group_id) VALUES('g08-channel','g08-group')").run();
  await prepare(testEnv.DB, `INSERT INTO channel_models(channel_id,public_model_id,protocol,upstream_model,capabilities_json,config_version)
    VALUES('g08-channel','g08-model','chat','provider-model',?,1)`, [JSON.stringify({ protocol: 'chat', features: ['streaming'], maxOutputTokens: 4096 })]).run();
  const subject = await authenticatePlatformKey(testEnv.DB, new Request('https://gateway.example/v1/chat/completions', { headers: { Authorization: `Bearer ${token}` } }), now);
  admission = await admitRequest(testEnv, subject, { protocol: 'chat', request: { model: 'g08-model', stream: true, max_tokens: 20,
    messages: [{ role: 'user', content: 'synthetic prompt not persisted' }] } }, { adapterAvailable: () => true });
});
afterEach(() => vi.restoreAllMocks());

describe('G08 incremental stream lifecycle with native D1/Gate and mock upstream', () => {
  it('runs G11 accounting before normal release and includes it in context-owned completion', async () => {
    const context = createExecutionContext();
    const finalizer = createRequestFinalizer({ database: testEnv.DB, request: admission.request, waitUntil: work => context.waitUntil(work) });
    const execution = await executeStream(dependencies(async () => sourceResponse(new ReadableStream({ start(controller) {
      controller.enqueue(frame(chunk({}, 'stop'))); controller.enqueue(frame(usage)); controller.enqueue(frame('[DONE]')); controller.close();
    } }))), admission, adapters, { onComplete: async (completion, signal) => {
      expect(Object.hasOwn(completion, 'cleanup')).toBe(false);
      expect(await active('user:g08-user')).toBe(1);
      await finalizer.onComplete(completion, signal);
      expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(1);
      expect(await active('user:g08-user')).toBe(1);
    } });
    context.waitUntil(execution.completion);
    await execution.response.text(); await waitOnExecutionContext(context);
    expect(await execution.completion).toMatchObject({ hookSucceeded: true, cleanup: { complete: true } });
    expect(await finalizer.completion).toMatchObject({ billingStatus: 'settled', cleanup: null });
    expect(await active('user:g08-user')).toBe(0);
    expect(await testEnv.DB.prepare('SELECT cost_units FROM requests').first('cost_units')).toBe(1300);
  });

  it('still performs bounded accounting after client cancellation with complete usage', async () => {
    const context = createExecutionContext();
    const finalizer = createRequestFinalizer({ database: testEnv.DB, request: admission.request, waitUntil: work => context.waitUntil(work) });
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const execution = await executeStream(dependencies(async () => sourceResponse(new ReadableStream({ start(controller) { source = controller; } }, { highWaterMark: 0 }))), admission, adapters, { onComplete: finalizer.onComplete });
    context.waitUntil(execution.completion);
    const reader = execution.response.body!.getReader();
    source.enqueue(frame(chunk({}, 'stop'))); await reader.read(); source.enqueue(frame(usage)); await reader.read();
    await reader.cancel(); await waitOnExecutionContext(context);
    expect(await execution.completion).toMatchObject({ terminal: { status: 'cancelled' }, hookSucceeded: true, cleanup: { complete: true } });
    expect(await finalizer.completion).toMatchObject({ billingStatus: 'settled' });
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(1);
    expect(await active('user:g08-user')).toBe(0);
  });
  it('returns headers before completion and holds leases until the real terminal is consumed', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const onComplete = vi.fn(async () => {});
    const execution = await executeStream(dependencies(async () => sourceResponse(new ReadableStream({ start(controller) { source = controller; } }, { highWaterMark: 0 }))), admission, adapters, { onComplete });
    expect(execution.response.status).toBe(200);
    expect(execution.response.headers.get('cache-control')).toBe('no-store');
    expect(await active('user:g08-user')).toBe(1);
    expect(onComplete).not.toHaveBeenCalled();
    expect((await getRequest(testEnv.DB, admission.request.id, admission.request.user_id))?.execution_status).toBe('admitted');
    const reader = execution.response.body!.getReader();
    source.enqueue(frame(chunk({ role: 'assistant', content: 'hello' })));
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('hello');
    expect(new TextDecoder().decode(first.value)).toContain(`resp_${admission.request.id}`);
    expect(await active('user:g08-user')).toBe(1);
    source.enqueue(frame(chunk({}, 'stop'))); source.enqueue(frame(usage)); source.enqueue(frame('[DONE]')); source.close();
    while (!(await reader.read()).done) { /* Consume incremental output to terminal. */ }
    const result = await execution.completion;
    expect(result.terminal).toMatchObject({ status: 'completed' });
    expect(result.usage).toMatchObject({ quality: 'complete', protocol: 'chat', counts: { inputTokens: 7, outputTokens: 3 } });
    expect(result.usageUpdateCount).toBe(1);
    expect(result.upstreamResponseId).toBe('native-stream-id');
    expect(result.recorded).toBe(true); expect(result.cleanup.complete).toBe(true);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(await active('user:g08-user')).toBe(0);
    expect((await prepare(testEnv.DB, 'SELECT response_id FROM requests WHERE id=?', [admission.request.id]).first())?.response_id).toBe('native-stream-id');
  });

  it('keeps unknown usage missing and never invents success for abrupt EOF', async () => {
    const execution = await executeStream(dependencies(async () => sourceResponse(new ReadableStream({ start(controller) {
      controller.enqueue(frame(chunk({ content: 'partial' }))); controller.close();
    } }))), admission, adapters);
    await execution.response.text();
    const result = await execution.completion;
    expect(result.terminal.status).not.toBe('completed');
    expect(result.usage.quality).toBe('missing');
    expect(await active('channel:g08-channel')).toBe(0);
    expect((await prepare(testEnv.DB, 'SELECT cost_units FROM requests WHERE id=?', [admission.request.id]).first())?.cost_units).toBeNull();
  });

  it('uses original upstream usage even if the injected output adapter emits no usage', async () => {
    const minimalAdapter = { from: 'chat' as const, to: 'chat' as const, create: () => ({ ok: true as const, value: {
      push: (value: { data: string }) => value.data === '[DONE]' ? { events: [{ data: '[DONE]' }], terminal: { status: 'completed' as const, reason: 'stop' as const } } : { events: [{ data: 'converted output without counters' }] },
      finish: () => ({ events: [], terminal: { status: 'incomplete' as const, reason: 'unexpected_eof' as const } }),
    } }) };
    const execution = await executeStream(dependencies(async () => sourceResponse(new ReadableStream({ start(controller) {
      controller.enqueue(frame(chunk({}, 'stop'))); controller.enqueue(frame(usage)); controller.enqueue(frame('[DONE]')); controller.close();
    } }))), admission, { ...adapters, stream: minimalAdapter });
    await execution.response.text();
    expect((await execution.completion).usage).toMatchObject({ quality: 'complete', counts: { inputTokens: 7, outputTokens: 3 } });
  });

  it('rejects duplicate execution without releasing the winning active stream', async () => {
    const execution = await executeStream(dependencies(async () => sourceResponse(new ReadableStream({}, { highWaterMark: 0 }))), admission, adapters);
    await expect(executeStream(dependencies(async () => { throw new Error('must not fetch twice'); }), admission, adapters)).rejects.toBeInstanceOf(StreamExecutionError);
    expect(await active('user:g08-user')).toBe(1);
    await execution.response.body!.cancel();
    expect((await execution.completion).terminal.status).toBe('cancelled');
    expect(await active('user:g08-user')).toBe(0);
  });

  it('cleans up owned leases when upstream headers cannot start an SSE stream', async () => {
    await expect(executeStream(dependencies(async () => new Response('private upstream failure', { status: 500 })), admission, adapters))
      .rejects.toMatchObject({ reason: 'stream_start_failed', completion: { terminal: { status: 'failed' }, cleanup: { complete: true } } });
    expect(await active('user:g08-user')).toBe(0);
  });

  it('classifies a local request conversion rejection as invalid and not chargeable before fetch', async () => {
    const fetcher = vi.fn(async () => sourceResponse(new ReadableStream<Uint8Array>()));
    const rejected = { ...adapters, request: { ...adapters.request, convert: () => ({ ok: false as const,
      error: { kind: 'invalid_request' as const, code: 'request_constraint', message: 'Request constraint rejected.', param: '$.stream_options' } }) } };
    await expect(executeStream(dependencies(fetcher), admission, rejected)).rejects.toMatchObject({ reason: 'invalid_request', dispatched: false,
      completion: { terminal: { status: 'failed' }, cleanup: { complete: true } } });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await getRequest(testEnv.DB, admission.request.id, admission.request.user_id)).toMatchObject({ execution_status: 'failed', billing_status: 'not_chargeable' });
    expect(await testEnv.DB.prepare('SELECT error_code FROM requests').first('error_code')).toBe('internal_error');
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(0);
    expect(await active('user:g08-user')).toBe(0); expect(await active('channel:g08-channel')).toBe(0);
  });
});

describe('G09 stream backpressure and retained-byte limits', () => {
  it('does not prefetch upstream while the downstream consumer is idle', async () => {
    const parts = [frame(chunk({ content: 'first' })), frame(chunk({}, 'stop')), frame(usage), frame('[DONE]')];
    let pulls = 0;
    const execution = await executeStream(dependencies(async () => sourceResponse(new ReadableStream({
      pull(controller) { const part = parts[pulls++]; if (part) controller.enqueue(part); else controller.close(); },
    }, { highWaterMark: 0 }))), admission, adapters);
    expect(pulls).toBe(0);
    const reader = execution.response.body!.getReader();
    await reader.read();
    expect(pulls).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(pulls).toBe(1);
    while (!(await reader.read()).done) { /* Drive each pull explicitly. */ }
    expect((await execution.completion).cleanup.complete).toBe(true);
  });

  it('supports split UTF-8 and CRLF boundaries within bounded partial frames', async () => {
    const encoded = encoder.encode([chunk({ content: '你好' }), chunk({}, 'stop'), usage, '[DONE]'].map(data => `data: ${data}\r\n\r\n`).join(''));
    let offset = 0;
    const execution = await executeStream(dependencies(async () => sourceResponse(new ReadableStream({ pull(controller) {
      if (offset >= encoded.length) { controller.close(); return; }
      controller.enqueue(encoded.slice(offset, offset + 3)); offset += 3;
    } }, { highWaterMark: 0 }))), admission, adapters, { maxInputChunkBytes: 8, maxFrameBytes: 512, maxQueuedBytes: 512 });
    expect(await execution.response.text()).toContain('你好');
    expect((await execution.completion).terminal.status).toBe('completed');
  });

  it.each(['frame', 'chunk'])('fails a %s byte-budget overflow and releases leases', async kind => {
    const cancelled = vi.fn();
    const execution = await executeStream(dependencies(async () => sourceResponse(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(`data: ${'x'.repeat(512)}`));
    }, cancel: cancelled }))), admission, adapters, kind === 'frame' ? { maxFrameBytes: 128 } : { maxInputChunkBytes: 128 });
    await expect(execution.response.text()).rejects.toThrow();
    const result = await execution.completion;
    expect(result.terminal.status).toBe('failed');
    expect(result.cleanup.complete).toBe(true);
    expect(cancelled).toHaveBeenCalled();
    expect(await active('user:g08-user')).toBe(0);
  });

  it('bounds adapter-expanded output waiting for a downstream pull', async () => {
    const expansive = { from: 'chat' as const, to: 'chat' as const, create: () => ({ ok: true as const, value: {
      push: () => ({ events: [{ data: 'a'.repeat(80) }, { data: 'b'.repeat(80) }] }), finish: () => ({ events: [] }),
    } }) };
    const execution = await executeStream(dependencies(async () => sourceResponse(new ReadableStream({ start(controller) {
      controller.enqueue(frame(chunk({ content: 'small' })));
    } }))), admission, { ...adapters, stream: expansive }, { maxQueuedBytes: 128 });
    await expect(execution.response.text()).rejects.toThrow();
    expect((await execution.completion).terminal.status).toBe('failed');
    expect(await active('channel:g08-channel')).toBe(0);
  });

  it('passes an explicit retained-state budget to tool-fragment adapters', async () => {
    const execution = await executeStream(dependencies(async () => sourceResponse(new ReadableStream({ start(controller) {
      controller.enqueue(frame(chunk({ tool_calls: [{ index: 0, id: 'call_test', type: 'function', function: { name: 'test', arguments: '{"x":"fragment' } }] })));
    } }))), admission, adapters, { maxBufferedBytes: 128 });
    await execution.response.text();
    expect((await execution.completion).terminal.status).toBe('failed');
  });
});

describe('G10 cancellation and bounded completion', () => {
  it('aborts the fetch and releases leases when the consumer cancels a pending read', async () => {
    let fetchSignal: AbortSignal | undefined;
    const cancelled = vi.fn();
    const execution = await executeStream(dependencies(async (_url, init) => {
      fetchSignal = init.signal as AbortSignal;
      return sourceResponse(new ReadableStream({ cancel: cancelled }, { highWaterMark: 0 }));
    }), admission, adapters);
    const reader = execution.response.body!.getReader();
    const pending = reader.read();
    await reader.cancel();
    await pending.catch(() => undefined);
    const result = await execution.completion;
    expect(result.terminal.status).toBe('cancelled');
    expect(fetchSignal?.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalled();
    expect(result.cleanup.complete).toBe(true);
    expect(await active('user:g08-user')).toBe(0);
  });

  it('propagates request AbortSignal while no downstream reader is attached', async () => {
    const abort = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    const execution = await executeStream(dependencies(async (_url, init) => {
      fetchSignal = init.signal as AbortSignal;
      return sourceResponse(new ReadableStream({}, { highWaterMark: 0 }));
    }), admission, adapters, { signal: abort.signal });
    abort.abort();
    expect((await execution.completion).terminal.status).toBe('cancelled');
    expect(fetchSignal?.aborted).toBe(true);
    await expect(execution.response.text()).rejects.toThrow();
    expect(await active('channel:g08-channel')).toBe(0);
  });

  it('enforces total duration even when the consumer never pulls', async () => {
    let fetchSignal: AbortSignal | undefined;
    const execution = await executeStream(dependencies(async (_url, init) => {
      fetchSignal = init.signal as AbortSignal;
      return sourceResponse(new ReadableStream({}, { highWaterMark: 0 }));
    }), admission, adapters, { transport: { maxDurationMs: 300, headersTimeoutMs: 250, idleTimeoutMs: 250 } });
    const result = await execution.completion;
    expect(result.terminal).toMatchObject({ status: 'failed', error: { code: 'request_timeout' } });
    expect(fetchSignal?.aborted).toBe(true);
    expect(result.cleanup.complete).toBe(true);
    expect(await active('user:g08-user')).toBe(0);
  });

  it('does not wait forever for an upstream producer that ignores cancel', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const execution = await executeStream(dependencies(async () => sourceResponse(new ReadableStream({ cancel }, { highWaterMark: 0 }))), admission, adapters);
    await execution.response.body!.cancel();
    const result = await execution.completion;
    expect(result.terminal.status).toBe('cancelled');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(result.cleanup.complete).toBe(true);
  });

  it('bounds a hung completion hook, then closes leases and reports the timeout', async () => {
    let hookSignal: AbortSignal | undefined;
    const execution = await executeStream(dependencies(async () => sourceResponse(new ReadableStream({ start(controller) {
      controller.enqueue(frame(chunk({}, 'stop'))); controller.enqueue(frame(usage)); controller.enqueue(frame('[DONE]')); controller.close();
    } }))), admission, adapters, { completionTimeoutMs: 300, onComplete: async (_result, signal) => {
      hookSignal = signal; expect(await active('user:g08-user')).toBe(1); await new Promise<void>(() => {});
    } });
    await execution.response.text();
    const result = await execution.completion;
    expect(result.hookSucceeded).toBe(false);
    expect(hookSignal?.aborted).toBe(true);
    expect(result.cleanup.complete).toBe(true);
    expect(await active('user:g08-user')).toBe(0);
  });

  it('clears executor, transport and renewal timers after normal completion', async () => {
    const timers = new Set<unknown>();
    const originalSet = globalThis.setTimeout.bind(globalThis);
    const originalClear = globalThis.clearTimeout.bind(globalThis);
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const handle = originalSet(() => { timers.delete(handle); callback(...args); }, delay);
      timers.add(handle); return handle;
    }) as typeof setTimeout);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation((handle => { timers.delete(handle); originalClear(handle); }) as typeof clearTimeout);
    const execution = await executeStream(dependencies(async () => sourceResponse(new ReadableStream({ start(controller) {
      controller.enqueue(frame(chunk({}, 'stop'))); controller.enqueue(frame('[DONE]')); controller.close();
    } }))), admission, adapters);
    await execution.response.text(); await execution.completion;
    expect(timers.size).toBe(0);
  });

  it('keeps complete upstream usage when a consumer cancels before the final wire marker', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const execution = await executeStream(dependencies(async () => sourceResponse(new ReadableStream({ start(controller) { source = controller; } }, { highWaterMark: 0 }))), admission, adapters);
    const reader = execution.response.body!.getReader();
    source.enqueue(frame(chunk({}, 'stop'))); await reader.read();
    source.enqueue(frame(usage)); await reader.read();
    await reader.cancel();
    const result = await execution.completion;
    expect(result.terminal.status).toBe('cancelled');
    expect(result.usage).toMatchObject({ quality: 'complete', counts: { inputTokens: 7, outputTokens: 3 } });
    expect(result.cleanup.complete).toBe(true);
  });

  it('aborts stalled headers and discards a response returned after cancellation', async () => {
    let resolveLate!: (response: Response) => void;
    let fetchSignal: AbortSignal | undefined;
    await expect(executeStream(dependencies(async (_url, init) => {
      fetchSignal = init.signal as AbortSignal;
      return new Promise<Response>(resolve => { resolveLate = resolve; });
    }), admission, adapters, { transport: { headersTimeoutMs: 50, idleTimeoutMs: 500, maxDurationMs: 1000 } }))
      .rejects.toMatchObject({ completion: { terminal: { status: 'failed' }, cleanup: { complete: true } } });
    expect(fetchSignal?.aborted).toBe(true);
    const cancelled = vi.fn();
    resolveLate(sourceResponse(new ReadableStream({ cancel: cancelled }, { highWaterMark: 0 })));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(await active('user:g08-user')).toBe(0);
  });

  it('does not let a fast endless heartbeat producer starve the total deadline', async () => {
    const execution = await executeStream(dependencies(async () => sourceResponse(new ReadableStream({ pull(controller) {
      controller.enqueue(encoder.encode(': heartbeat\n\n'));
    } }, { highWaterMark: 0 }))), admission, adapters, { transport: { maxDurationMs: 300, headersTimeoutMs: 250, idleTimeoutMs: 250 } });
    await expect(execution.response.text()).rejects.toThrow();
    expect((await execution.completion).terminal.status).toBe('failed');
    expect(await active('user:g08-user')).toBe(0);
  });
});
