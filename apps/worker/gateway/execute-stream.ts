import { logError } from '../logging';
import { createResponseIds } from '@sub2api/apicompat/ids';
import { SseByteParser } from '@sub2api/apicompat/streams/parser';
import { BoundedByteBuffer, ByteBudget, readBoundedBytes } from '@sub2api/apicompat/streams/buffers';
import { createChatUsageSession } from '@sub2api/apicompat/usage/chat';
import { createResponsesUsageSession } from '@sub2api/apicompat/usage/responses';
import { createMessagesUsageSession } from '@sub2api/apicompat/usage/messages';
import type { RequestAdapter, StreamAdapter, StreamSession } from '@sub2api/apicompat/types/adapter';
import type { ProtocolError, SseFrame, TerminalState, UsageSnapshot } from '@sub2api/apicompat/types/shared';
import { readChannelForForwarding } from '../catalog/channels';
import type { ChannelKeyring } from '../catalog/channel-secrets';
import { DEFAULT_CONFIG } from '../config';
import { createRequestLifecycle } from './request-lifecycle';
import type { RequestStopReason } from './request-lifecycle';
import type { DualLeaseCleanupReport } from '../limits/dual-lease';
import { finishRequest, getRequest, markRequestStarted } from './request-repository';
import type { AdmittedRequest } from './admit';
import { prepare } from '../db';
import { sendUpstream, UpstreamTransportError } from './transport';
import type { UpstreamExchange, UpstreamFetch, UpstreamRequestOptions } from './transport';

/** Best-effort metadata hook: never consume the body or change transport errors. */
async function observeUpstreamResponse(
  callback: ((response: { channelId: string; status: number; retryAfter: string | null }) => void | Promise<void>) | undefined,
  channelId: string, response: Response, signal: AbortSignal,
): Promise<void> {
  if (!callback) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const observation = Object.freeze({ channelId, status: response.status, retryAfter: response.headers.get('retry-after') });
    await Promise.race([
      Promise.resolve().then(() => callback(observation)).catch(() => undefined),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000); }),
      new Promise<void>(resolve => {
        onAbort = resolve;
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) resolve();
      }),
    ]);
  } catch { /* Observation must never replace upstream classification or cleanup. */ }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export interface StreamExecutionDependencies { database: D1Database; keyring: ChannelKeyring; fetch?: UpstreamFetch; now?: () => number }
export interface StreamExecutionAdapters<Input, Output> { request: RequestAdapter<Input, Output>; stream: StreamAdapter<SseFrame, SseFrame> }
export interface StreamCompletion {
  requestId: string; terminal: TerminalState; usage: UsageSnapshot; usageUpdateCount: number;
  upstreamResponseId: string | null; recorded: boolean; cleanup: DualLeaseCleanupReport; hookSucceeded: boolean;
}
export interface StreamExecutionOptions {
  signal?: AbortSignal;
  /** Internal, bounded metadata-only hook, invoked before reading any response body. */
  onUpstreamResponse?: (response: { channelId: string; status: number; retryAfter: string | null }) => void | Promise<void>;
  transport?: Pick<UpstreamRequestOptions, 'headersTimeoutMs' | 'idleTimeoutMs' | 'maxDurationMs' | 'messages' | 'customHeaders' | 'downstreamHeaders'>;
  maxBufferedBytes?: number;
  maxFrameBytes?: number;
  maxQueuedBytes?: number;
  maxInputChunkBytes?: number;
  /** Bounded final persistence/hook/cleanup awaits; never unlimited renewal. */
  completionTimeoutMs?: number;
  /** G11/B13 receives ORIGINAL upstream usage, never converted wire counters. */
  onComplete?: (completion: Omit<StreamCompletion, 'cleanup' | 'hookSucceeded'>, signal: AbortSignal) => Promise<void>;
}
/** G14 must attach completion to executionCtx.waitUntil, including EOF/cancel paths. */
export interface StreamExecution { response: Response; completion: Promise<StreamCompletion> }
export class StreamExecutionError extends Error {
  constructor(readonly reason: 'invalid_admission' | 'invalid_request' | 'stream_start_failed', readonly completion: StreamCompletion | null = null,
    readonly dispatched = false) {
    super('Streaming execution could not start.'); this.name = 'StreamExecutionError';
  }
}
const problem = (code: string): ProtocolError => ({ kind: 'stream_error', code, message: 'The upstream stream could not be completed safely.' });
function encodeFrame(frame: SseFrame, budget: ByteBudget): BoundedByteBuffer {
  if (typeof frame.data !== 'string' || (frame.event !== undefined && /[\r\n]/.test(frame.event)) ||
      (frame.id !== undefined && /[\r\n\u0000]/.test(frame.id))) throw new Error('Invalid SSE metadata');
  const buffer = new BoundedByteBuffer(budget);
  try {
  if (frame.event !== undefined) buffer.appendText(`event: ${frame.event}\n`);
  if (frame.id !== undefined) buffer.appendText(`id: ${frame.id}\n`);
  if (frame.retry !== undefined) {
    if (!Number.isSafeInteger(frame.retry) || frame.retry < 0) throw new Error('Invalid retry');
    buffer.appendText(`retry: ${frame.retry}\n`);
  }
  // Append line-by-line, charging UTF-8 before allocating each encoded copy.
  let start = 0;
  for (let index = 0; index <= frame.data.length; index++) {
    if (index !== frame.data.length && frame.data[index] !== '\r' && frame.data[index] !== '\n') continue;
    buffer.appendText(`data: ${frame.data.slice(start, index)}\n`);
    if (frame.data[index] === '\r' && frame.data[index + 1] === '\n') index++;
    start = index + 1;
  }
  buffer.appendText('\n');
  return buffer;
  } catch (error) { buffer.cancel(); throw error; }
}

/** Claims an admitted request exactly once. Returning headers is NOT completion:
 * the returned body owns transport, usage extraction, terminal persistence and
 * lease renewal until real EOF/terminal/cancel. No background draining loop.
 * If claim fails, ownership remains with the caller; never release another runner.
 */
export async function executeStream<Input, Output>(dependencies: StreamExecutionDependencies, admission: AdmittedRequest,
  adapters: StreamExecutionAdapters<Input, Output>, options: StreamExecutionOptions = {}): Promise<StreamExecution> {
  const { database } = dependencies;
  const now = dependencies.now ?? Date.now;
  const record = await getRequest(database, admission.request.id, admission.request.user_id);
  if (!record || record.execution_status !== 'admitted' || record.started_at !== null || record.price_snapshot !== admission.request.price_snapshot ||
      record.api_key_id !== admission.request.api_key_id || record.channel_id !== admission.selected.candidate.channel.id ||
      record.upstream_protocol !== admission.selected.candidate.mapping.protocol || record.upstream_model !== admission.selected.candidate.mapping.upstreamModel ||
      admission.requestForAdapter.protocol !== record.downstream_protocol || admission.requestForAdapter.request.stream !== true ||
      !await markRequestStarted(database, record.id, record.user_id, now())) throw new StreamExecutionError('invalid_admission');
  const usageSession = record.upstream_protocol === 'chat' ? createChatUsageSession()
    : record.upstream_protocol === 'responses' ? createResponsesUsageSession() : createMessagesUsageSession();
  let exchange: UpstreamExchange | undefined;
  let inputBytes: AsyncGenerator<Uint8Array, void, unknown> | undefined;
  let session: StreamSession<SseFrame, SseFrame> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let upstreamId: string | null = null;
  let updates = 0;
  let terminal: TerminalState | undefined;
  let consumerCancelled = false;
  let upstreamDispatched = false;
  let startupFailure: 'invalid_request' | 'service_unavailable' = 'service_unavailable';
  let preDispatchAccounting = true;
  let finalizing: Promise<StreamCompletion> | undefined;
  let resolveCompletion!: (value: StreamCompletion) => void;
  const completion = new Promise<StreamCompletion>(resolve => { resolveCompletion = resolve; });
  // Independent bounded regions: one input chunk, one partial frame, adapter
  // state, and output queue. There is no claimed single shared adapter budget.
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_CONFIG.streamFrameMaxBytes;
  const maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_CONFIG.streamFrameMaxBytes;
  const maxInputChunkBytes = options.maxInputChunkBytes ?? DEFAULT_CONFIG.streamFrameMaxBytes;
  const maxAdapterBytes = options.maxBufferedBytes ?? DEFAULT_CONFIG.toolArgumentsMaxBytes;
  const queue: BoundedByteBuffer[] = [];
  const queueBudget = new ByteBudget(Number.isSafeInteger(maxQueuedBytes) && maxQueuedBytes > 0 ? maxQueuedBytes : 0);
  const pendingFrame = new BoundedByteBuffer(new ByteBudget(Number.isSafeInteger(maxFrameBytes) && maxFrameBytes > 0 ? maxFrameBytes : 0));
  let lineHasBytes = false;
  let skipLf = false;
  const parser = new SseByteParser();
  let stopReason: RequestStopReason | undefined;
  let yieldTimer: ReturnType<typeof setTimeout> | undefined;
  let resumeYield: (() => void) | undefined;
  const totalMs = options.transport?.maxDurationMs ?? DEFAULT_CONFIG.requestMaxDurationMs;
  const requestedCompletionMs = options.completionTimeoutMs ?? DEFAULT_CONFIG.settlementRetryBudgetMs;
  const completionMs = Number.isSafeInteger(requestedCompletionMs) && requestedCompletionMs > 0 && requestedCompletionMs <= 60_000
    ? requestedCompletionMs : DEFAULT_CONFIG.settlementRetryBudgetMs;
  const lifecycle = createRequestLifecycle(admission.lease, {
    ...(options.signal === undefined ? {} : { signal: options.signal }), clock: now,
    maxDurationMs: totalMs, completionTimeoutMs: completionMs, onStop: stop,
  });
  const { interrupted, bounded } = lifecycle;
  lifecycle.addCleanup(() => {
    if (yieldTimer !== undefined) clearTimeout(yieldTimer);
    yieldTimer = undefined;
    resumeYield?.(); resumeYield = undefined;
  });
  async function markNotChargeable(): Promise<boolean> {
    try {
      const result = await prepare(database, `UPDATE requests SET billing_status='not_chargeable',updated_at=max(updated_at,?)
        WHERE id=? AND user_id=? AND execution_status='admitted' AND billing_status='awaiting_usage'
          AND NOT EXISTS(SELECT 1 FROM billing_entries WHERE request_id=requests.id AND kind='consumption')`, [now(), record!.id, record!.user_id]).run();
      return result.changes === 1;
    } catch (error) { logError('Stream accounting update failed', error, { request_id: record?.id }); return false; }
  }
  function stop(reason: RequestStopReason): void {
    if (finalizing || stopReason !== undefined) return;
    stopReason = reason;
    if (exchange) {
      const state: TerminalState = reason === 'cancelled' ? { status: 'cancelled' } : { status: 'failed', error: problem(reason) };
      try { session?.finish(reason === 'cancelled' ? { kind: 'cancelled' } : { kind: 'error', error: problem(reason) }); } catch { /* Cleanup still runs. */ }
      try { controller?.error(new Error('Stream lifecycle interrupted.')); } catch { /* Already closed/cancelled. */ }
      void finish(state);
    }
  }

  function finish(state: TerminalState): Promise<StreamCompletion> {
    if (finalizing) return finalizing;
    terminal = state;
    if (yieldTimer !== undefined) clearTimeout(yieldTimer);
    yieldTimer = undefined;
    resumeYield?.(); resumeYield = undefined;
    finalizing = Promise.resolve().then(async () => {
      // A producer that ignores cancellation must not block persistence/release.
      void inputBytes?.return().catch(() => undefined);
      try { parser.finish(); } catch { /* Parser failure cannot strand resource cleanup. */ }
      pendingFrame.cancel();
      for (const queued of queue) queued.cancel();
      queue.length = 0;
      let usage: UsageSnapshot;
      try { usage = usageSession.finish(state); } catch (error) { logError('Stream usage finalization failed', error, { request_id: record?.id }); usage = { quality: 'missing', protocol: record!.upstream_protocol }; }
      // A normal terminal keeps renewal until bounded final persistence/accounting
      // finishes. Cancellation or lease loss may already have closed L10 safely.
      if (!upstreamDispatched) {
        const marked = await bounded(markNotChargeable);
        preDispatchAccounting = marked.ok && marked.value;
      }
      const recordedResult = await bounded(() => finishRequest(database, record!.id, record!.user_id, {
          status: state.status === 'completed' || state.status === 'incomplete' ? 'succeeded' : state.status === 'cancelled' ? 'cancelled' : 'failed',
          ...(upstreamId === null ? {} : { responseId: upstreamId }),
          ...(state.status === 'failed' ? { errorCode: upstreamDispatched ? 'upstream_error' as const : 'internal_error' as const } : {}),
        }, now()));
      const recorded = recordedResult.ok && recordedResult.value;
      const result = { requestId: record!.id, terminal: state, usage, usageUpdateCount: updates, upstreamResponseId: upstreamId, recorded };
      let hookSucceeded = true;
      let cleanup: DualLeaseCleanupReport;
      try {
        if (options.onComplete && upstreamDispatched) {
          const hookController = new AbortController();
          const hook = await bounded(() => options.onComplete!(result, hookController.signal), () => hookController.abort());
          hookSucceeded = hook.ok;
        }
      } finally {
        cleanup = await lifecycle.close();
      }
      const completed = { ...result, cleanup, hookSucceeded };
      resolveCompletion(completed);
      return completed;
    });
    lifecycle.beginFinalization(state.status === 'completed' || state.status === 'incomplete');
    return finalizing;
  }
  function observe(frame: SseFrame): void {
    updates += usageSession.push(frame).length;
    let value: unknown;
    try { value = JSON.parse(frame.data); } catch { return; }
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    const source = record!.upstream_protocol === 'responses' ? object.response : record!.upstream_protocol === 'messages' ? object.message : object;
    if (!source || typeof source !== 'object') return;
    const id = (source as Record<string, unknown>).id;
    if (id === undefined) return;
    if (typeof id !== 'string' || !id.trim() || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id) || (upstreamId !== null && upstreamId !== id)) throw new Error('Unstable upstream identity');
    upstreamId = id;
  }
  function step(value: ReturnType<StreamSession<SseFrame, SseFrame>['push']>): void {
    for (const frame of value.events) queue.push(encodeFrame(frame, queueBudget));
    if (value.terminal) terminal = value.terminal;
  }
  function parseChunk(bytes: Uint8Array): void {
    let start = 0;
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index];
      if (skipLf) { skipLf = false; if (byte === 10) continue; }
      if (byte === 10 || byte === 13) {
        const boundary = !lineHasBytes;
        lineHasBytes = false; skipLf = byte === 13;
        if (boundary) {
          pendingFrame.append(bytes.subarray(start, index + 1));
          for (const frame of parser.push(pendingFrame.drain())) { observe(frame); step(session!.push(frame)); if (terminal) return; }
          start = index + 1;
        }
      } else lineHasBytes = true;
    }
    pendingFrame.append(bytes.subarray(start));
  }
  try {
    if (![maxFrameBytes, maxQueuedBytes, maxInputChunkBytes, maxAdapterBytes].every(value => Number.isSafeInteger(value) && value > 0 && value <= 16 * 1024 * 1024)) throw new Error('Invalid stream byte limits');
    if (!Number.isSafeInteger(totalMs) || totalMs <= 0 || totalMs > 2_147_483_647 || requestedCompletionMs !== completionMs) throw new Error('Invalid stream deadlines');
    lifecycle.start();
    if (stopReason !== undefined) throw new Error('Already cancelled');
    if (adapters.request.from !== record.downstream_protocol || adapters.request.to !== record.upstream_protocol ||
        adapters.stream.from !== record.upstream_protocol || adapters.stream.to !== record.downstream_protocol) throw new Error('Adapter direction mismatch');
    const ids = createResponseIds({ seed: record.id });
    if (!ids.ok) throw new Error('Invalid internal response ID');
    const created = adapters.stream.create({ identity: ids.value.identity, idFor: ids.value.idFor, targetModel: record.public_model_id,
      createdAt: Math.floor(record.created_at / 1000) }, { unknownEventPolicy: 'reject', maxBufferedBytes: maxAdapterBytes });
    if (!created.ok) throw new Error('Invalid stream adapter');
    session = created.value;
    const channel = await Promise.race([readChannelForForwarding(database, record.channel_id, dependencies.keyring), interrupted]);
    if (!channel || channel.status !== 'active' || channel.configVersion !== admission.selected.candidate.channel.configVersion ||
        channel.baseUrl !== admission.selected.candidate.channel.baseUrl) throw new Error('Channel changed');
    const boundedInput = { ...admission.requestForAdapter.request, stream: true };
    const converted = adapters.request.convert(boundedInput as Input, { targetModel: record.upstream_model });
    if (!converted.ok) { startupFailure = 'invalid_request'; throw new Error('Request conversion rejected.'); }
    try {
      exchange = await sendUpstream({ ...options.transport, baseUrl: channel.baseUrl, upstreamProtocol: record.upstream_protocol,
        upstreamKey: channel.upstreamKey, stream: true, body: JSON.stringify(converted.value), signal: lifecycle.signal },
      dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch });
      upstreamDispatched = true;
    } catch (error) {
      // G02 distinguishes a rejected configuration before dispatch from a
      // network/timeout result after dispatch. Only the latter has unknown
      // usage and is allowed to reach the recovery finalizer.
      upstreamDispatched = !(error instanceof UpstreamTransportError && error.execution === 'not_started');
      throw error;
    }
    lifecycle.attachUpstream(() => exchange!.cancel());
    await observeUpstreamResponse(options.onUpstreamResponse, record.channel_id, exchange.response, lifecycle.signal);
    // Observation is an await boundary after transport ownership transfers.
    // A stop here may have finalized before an output controller existed;
    // never return a fresh body whose pull would then wait forever.
    if (finalizing || lifecycle.signal.aborted) throw new Error('Stream stopped before response publication');
    if (!exchange.response.ok || !exchange.response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !exchange.response.body) throw new Error('Expected upstream SSE');
    inputBytes = readBoundedBytes(exchange.response.body, new ByteBudget(maxInputChunkBytes), lifecycle.signal);
    void exchange.done.then(result => {
      if (!result.ok && !finalizing) {
        const state: TerminalState = result.error.reason === 'cancelled' && (consumerCancelled || stopReason === 'cancelled')
          ? { status: 'cancelled' } : { status: 'failed', error: problem(stopReason ?? result.error.reason) };
        try { session?.finish(state.status === 'cancelled' ? { kind: 'cancelled' } : { kind: 'error', error: problem(result.error.reason) }); } catch { /* Finalize anyway. */ }
        try { controller?.error(new Error('Upstream stream interrupted.')); } catch { /* Already closed. */ }
        void finish(state);
      }
    });
    const body = new ReadableStream<Uint8Array>({
      start(target) { controller = target; },
      async pull(target) {
        if (finalizing) return;
        try {
          let chunksWithoutOutput = 0;
          while (queue.length === 0 && !terminal && !finalizing) {
            const part = await inputBytes!.next();
            if (finalizing) return;
            if (part.done) { parser.finish(); step(session!.finish({ kind: 'eof' })); terminal ??= { status: 'incomplete', reason: 'unexpected_eof' }; }
            else parseChunk(part.value);
            // Even a synchronous endless heartbeat producer must yield to the
            // total-deadline/cancellation tasks instead of starving the event loop.
            if (++chunksWithoutOutput % 16 === 0 && queue.length === 0 && !terminal && !finalizing) {
              await new Promise<void>(resolve => {
                resumeYield = resolve;
                yieldTimer = setTimeout(() => { yieldTimer = undefined; resumeYield = undefined; resolve(); }, 0);
              });
            }
          }
          if (queue.length) target.enqueue(queue.shift()!.drain());
          if (terminal && queue.length === 0) { target.close(); await finish(terminal); }
        } catch (error) {
          logError('Stream processing failed', error, { request_id: record?.id });
          const state: TerminalState = { status: 'failed', error: problem('stream_processing_failed') };
          try { session?.finish({ kind: 'error', error: state.error }); } catch { /* Finalize anyway. */ }
          try { target.error(new Error('Stream processing failed.')); } catch { /* Already cancelled. */ }
          await finish(state);
        }
      },
      async cancel() {
        consumerCancelled = true;
        try { session?.finish({ kind: 'cancelled' }); } catch { /* A buggy adapter cannot prevent cancellation. */ }
        await finish({ status: 'cancelled' });
      },
    }, { highWaterMark: 0 });
    return { response: new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Request-ID': record.id } }), completion };
  } catch (error) {
    logError('Stream startup failed', error, { request_id: record?.id });
    const result = await finish(stopReason === 'cancelled' ? { status: 'cancelled' } : { status: 'failed', error: problem(stopReason ?? 'stream_start_failed') });
    if (!preDispatchAccounting) startupFailure = 'service_unavailable';
    throw new StreamExecutionError(upstreamDispatched ? 'stream_start_failed' : startupFailure === 'invalid_request' ? 'invalid_request' : 'stream_start_failed',
      result, upstreamDispatched);
  }
}
