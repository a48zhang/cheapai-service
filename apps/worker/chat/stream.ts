import type { ChatMessage } from './service';

export interface ChatGatewayDelta { readonly type: 'delta'; readonly text: string }
export interface ChatGatewayDone { readonly type: 'done'; readonly billingStatus?: string }
export interface ChatGatewayError { readonly type: 'error'; readonly code: string; readonly message: string }
export type ChatGatewayEvent = ChatGatewayDelta | ChatGatewayDone | ChatGatewayError | { readonly type: 'frame'; readonly event?: string; readonly data: unknown };

export type ChatGatewaySource = AsyncIterable<ChatGatewayEvent> | ReadableStream<Uint8Array> | Response;

export interface ChatGatewayExecution {
  readonly requestId: string;
  readonly source: ChatGatewaySource;
  /** When present, this is the gateway's authoritative terminal state (the
   * default adapter obtains it from D1 after execution completion). An EOF
   * without a done marker is accepted only with this completed state. */
  readonly terminal?: 'completed' | 'stopped' | 'failed';
  readonly billingStatus?: string;
  readonly resolveTerminal?: () => Promise<{ readonly terminal: 'completed' | 'stopped' | 'failed'; readonly billingStatus?: string }>;
  readonly cancel?: () => void | Promise<void>;
}

export interface ChatSseMeta {
  readonly conversation: unknown;
  readonly userMessage: ChatMessage | null;
  readonly assistantMessage: ChatMessage;
}

export interface ChatSseCallbacks {
  readonly onDelta: (text: string) => Promise<void> | void;
  readonly onDone: (billingStatus?: string) => Promise<ChatMessage>;
  readonly onFailed: (code: string, message: string) => Promise<ChatMessage | null>;
  readonly onCancelled: () => Promise<ChatMessage | null>;
}

export interface ChatSseOptions {
  readonly signal?: AbortSignal;
  readonly waitUntil?: (work: Promise<unknown>) => void;
}

export class ChatGatewayStreamError extends Error {
  constructor(readonly code: string, readonly safeMessage: string) {
    super(safeMessage);
    this.name = 'ChatGatewayStreamError';
  }
}

/** Bounds waiting only: D1 cannot cancel an issued write. Late results are
 * observed, but never get to choose another terminal state. */
export function boundedChatWork<T>(work: Promise<T>, timeoutMs = 5000, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => { cleanup(); reject(new ChatGatewayStreamError('cancelled', 'Chat generation was cancelled.')); };
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      reject(new ChatGatewayStreamError('chat_timeout', 'The chat request timed out.'));
    }, timeoutMs);
  });
}

function safeErrorCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/u.test(value)) return 'gateway_error';
  return value;
}

function safeErrorMessage(value: unknown): string {
  // Upstream response bodies are not allowed to reach the browser.  The
  // gateway normally supplies this already-redacted message; this fallback is
  // intentionally generic for malformed/mocked gateway events.
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) return 'The chat request failed.';
  return value;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function string(value: unknown): string | null { return typeof value === 'string' ? value : null; }

/** Decode text deltas from each native upstream protocol.  The gateway can
 * also pass a normalized delta, which keeps this bridge useful in unit tests
 * and for future gateway adapters. */
export function textDelta(value: unknown, eventName?: string): string | null {
  const direct = object(value);
  if (direct?.type === 'delta') return string(direct.text);
  if (eventName === 'response.output_text.delta' || direct?.type === 'response.output_text.delta') return string(direct?.delta);
  if (eventName === 'content_block_delta' || direct?.type === 'content_block_delta') {
    const delta = object(direct?.delta);
    return delta?.type === 'text_delta' ? string(delta.text) : null;
  }
  const choices = direct?.choices;
  if (Array.isArray(choices)) {
    let output = '';
    for (const choice of choices) {
      const row = object(choice);
      const delta = object(row?.delta);
      const text = string(delta?.content);
      if (text !== null) output += text;
    }
    return output || null;
  }
  return null;
}

function isDone(value: unknown, eventName?: string): boolean {
  if (value === '[DONE]') return true;
  const row = object(value);
  return eventName === 'message_stop' || eventName === 'response.completed' || row?.type === 'message_stop' || row?.type === 'response.completed';
}

function isError(value: unknown, eventName?: string): ChatGatewayError | null {
  const row = object(value);
  if (eventName === 'error' || row?.type === 'error' || row?.type === 'response.failed') {
    const error = object(row?.error);
    return { type: 'error', code: safeErrorCode(error?.code ?? row?.code), message: safeErrorMessage(error?.message ?? row?.message) };
  }
  return null;
}

function parseFrame(event: string | undefined, data: string): ChatGatewayEvent {
  if (data === '[DONE]') return { type: 'done' };
  let value: unknown;
  try { value = JSON.parse(data); } catch { throw new ChatGatewayStreamError('invalid_upstream_stream', 'The chat stream was malformed.'); }
  const error = isError(value, event);
  if (error) return error;
  const delta = textDelta(value, event);
  if (delta !== null && delta.length > 0) return { type: 'delta', text: delta };
  if (isDone(value, event)) return { type: 'done' };
  return { type: 'frame', ...(event === undefined ? {} : { event }), data: value };
}

async function* responseEvents(response: Response, signal?: AbortSignal): AsyncGenerator<ChatGatewayEvent, void, unknown> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new ChatGatewayStreamError('upstream_error', 'The chat upstream failed.');
  }
  const body = response.body;
  if (!body) throw new ChatGatewayStreamError('invalid_upstream_stream', 'The chat stream was empty.');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | undefined;
  let data: string[] = [];
  let exhausted = false;
  const cancelReader = () => {
    try { void reader.cancel().catch(() => undefined); } catch { /* already released */ }
    try { reader.releaseLock(); } catch { /* A late generator finally also releases. */ }
  };
  signal?.addEventListener('abort', cancelReader, { once: true });
  const flush = function* (): Generator<ChatGatewayEvent> {
    if (data.length === 0) return;
    const parsed = parseFrame(event, data.join('\n'));
    data = []; event = undefined;
    yield parsed;
  };
  try {
    while (true) {
      if (signal?.aborted) throw new ChatGatewayStreamError('cancelled', 'Chat generation was cancelled.');
      const next = await reader.read();
      if (next.done) { exhausted = true; break; }
      buffer += decoder.decode(next.value, { stream: true });
      let newline: number;
      while ((newline = buffer.search(/\r?\n/u)) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + (buffer[newline] === '\r' && buffer[newline + 1] === '\n' ? 2 : 1));
        if (line === '') { yield* flush(); continue; }
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) { event = line.slice(6).trim(); continue; }
        if (line.startsWith('data:')) { data.push(line.slice(5).replace(/^ /u, '')); continue; }
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /u, ''));
      else if (buffer.startsWith('event:')) event = buffer.slice(6).trim();
    }
    yield* flush();
  } finally {
    signal?.removeEventListener('abort', cancelReader);
    if (!exhausted) cancelReader();
    try { reader.releaseLock(); } catch { /* body already released */ }
  }
}

async function* sourceEvents(source: ChatGatewaySource, signal?: AbortSignal): AsyncGenerator<ChatGatewayEvent, void, unknown> {
  if (source instanceof Response) { yield* responseEvents(source, signal); return; }
  if (typeof (source as ReadableStream<Uint8Array>).getReader === 'function') {
    yield* responseEvents(new Response(source as ReadableStream<Uint8Array>, { headers: { 'Content-Type': 'text/event-stream' } }), signal);
    return;
  }
  const iterator = (source as AsyncIterable<ChatGatewayEvent>)[Symbol.asyncIterator]();
  let exhausted = false;
  let returning = false;
  const release = () => {
    if (returning || exhausted) return;
    returning = true;
    try { void boundedChatWork(Promise.resolve(iterator.return?.()), 1000).catch(() => undefined); } catch { /* best effort */ }
  };
  signal?.addEventListener('abort', release, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new ChatGatewayStreamError('cancelled', 'Chat generation was cancelled.');
      const next = await boundedChatWork(iterator.next(), 120_000, signal);
      if (next.done) { exhausted = true; return; }
      yield next.value;
    }
  } finally {
    signal?.removeEventListener('abort', release);
    release();
  }
}

function sse(event: string, value: unknown): Uint8Array {
  const encoded = JSON.stringify(value);
  return new TextEncoder().encode(`event: ${event}\ndata: ${encoded}\n\n`);
}

export function createChatSseStream(meta: ChatSseMeta, execution: ChatGatewayExecution, callbacks: ChatSseCallbacks,
  options: ChatSseOptions = {}): ReadableStream<Uint8Array> {
  const controller = new AbortController();
  let state: 'open' | 'closing' | 'finished' = 'open';
  let closePromise: Promise<void> | null = null;
  let cancelPromise: Promise<void> | null = null;
  let outputController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let doneMarker = false;
  let eventBillingStatus: string | undefined;
  let queuedText = '';
  let lastPersist = Date.now();
  const iterator = sourceEvents(execution.source, controller.signal)[Symbol.asyncIterator]();

  const schedule = (work: Promise<unknown>): void => {
    const observed = work.then(() => undefined, () => undefined);
    try { options.waitUntil?.(observed); } catch { /* execution context may already be closed */ }
  };
  const emit = (event: string, value: unknown): void => {
    try { outputController?.enqueue(sse(event, value)); } catch { /* client disconnected */ }
  };
  const cancelExecution = (): Promise<void> => {
    if (cancelPromise) return cancelPromise;
    // Abort before any persistence wait. The gateway alone owns billing and
    // leases; neither a broken cancel hook nor its completion can block SSE.
    controller.abort();
    let work: Promise<void>;
    try { work = Promise.resolve(execution.cancel?.()); } catch { work = Promise.resolve(); }
    cancelPromise = boundedChatWork(work, 1000).then(() => undefined, () => undefined);
    schedule(cancelPromise);
    return cancelPromise;
  };
  const flushQueued = async (timeoutMs = 5000, signal?: AbortSignal): Promise<void> => {
    if (queuedText.length === 0) return;
    const text = queuedText;
    queuedText = '';
    await boundedChatWork(Promise.resolve().then(() => callbacks.onDelta(text)), timeoutMs, signal);
  };
  const stop = (): void => { void finish('cancelled'); };

  /** Claim the terminal state synchronously. All races join the same promise,
   * and a late abort cannot turn an accepted success into a stopped answer. */
  const finish = (kind: 'completed' | 'failed' | 'cancelled', code = 'gateway_error',
    message = 'The chat request failed.', billingStatus?: string): Promise<void> => {
    if (closePromise) return closePromise;
    state = 'closing';
    options.signal?.removeEventListener('abort', stop);
    closePromise = Promise.resolve().then(async () => {
      let persistenceError = false;
      let final: ChatMessage | null = null;
      const safeCode = safeErrorCode(code);
      const safeMessage = safeErrorMessage(message);
      try {
        if (kind !== 'completed') await cancelExecution();
        // Give the final write its own budget even if a checkpoint is stuck.
        // onDelta incorporates the text before awaiting its checkpoint write.
        try { await flushQueued(1500); } catch { persistenceError = true; await cancelExecution(); }
        const savingCompleted = kind === 'completed' && !persistenceError;
        const saveDeadline = Date.now() + 3500;
        const save = Promise.resolve().then(() => kind === 'completed'
          ? persistenceError ? callbacks.onFailed('persistence_error', 'The chat answer could not be saved.') : callbacks.onDone(billingStatus)
          : kind === 'cancelled' ? callbacks.onCancelled() : callbacks.onFailed(safeCode, safeMessage));
        try { final = await boundedChatWork(save, 3500); } catch (error) {
          persistenceError = true;
          await cancelExecution();
          // A rejected write may be repaired. A timed-out write is unknown;
          // never race it with a conflicting failed terminal write.
          if (savingCompleted && !(error instanceof ChatGatewayStreamError && error.code === 'chat_timeout') && Date.now() < saveDeadline) {
            try {
              final = await boundedChatWork(Promise.resolve().then(() => callbacks.onFailed('persistence_error', 'The chat answer could not be saved.')),
                Math.max(1, saveDeadline - Date.now()));
            } catch { /* The persistence error remains visible. */ }
          }
        }
        if (persistenceError) {
          await cancelExecution();
          emit('error', { code: 'persistence_error', message: 'The chat answer could not be saved.', ...(final ? { messageId: final.id } : {}) });
        } else if (kind === 'failed') {
          emit('error', { code: safeCode, message: safeMessage, ...(final ? { messageId: final.id } : {}) });
        } else {
          emit('done', { message: final, ...(kind === 'cancelled' && final ? { stopped: true } : {}),
            ...(billingStatus === undefined ? {} : { billingStatus }) });
        }
      } finally {
        state = 'finished';
        controller.abort();
        // Async iterator return may wait for a pending next()/cancel hook.
        // Observe it with a bound rather than letting it own termination.
        try { schedule(boundedChatWork(Promise.resolve(iterator.return?.()), 1000)); } catch { /* already closed */ }
        try { outputController?.close(); } catch { /* client disconnected */ }
      }
    });
    schedule(closePromise);
    return closePromise;
  };

  return new ReadableStream<Uint8Array>({
    start(output) {
      outputController = output;
      output.enqueue(sse('meta', meta));
      options.signal?.addEventListener('abort', stop, { once: true });
      if (options.signal?.aborted) { stop(); return; }
      const pump = (async () => {
        try {
          while (state === 'open') {
            // The abort race also covers custom iterators that ignore cancel.
            const next = await boundedChatWork(iterator.next(), 120_000, controller.signal);
            if (state !== 'open') return;
            if (next.done) break;
            const event = next.value;
            if (event.type === 'error') throw new ChatGatewayStreamError(event.code, event.message);
            if (event.type === 'delta') {
              if (!event.text) continue;
              queuedText += event.text;
              const now = Date.now();
              if (queuedText.length >= 2048 || now - lastPersist >= 1500) {
                lastPersist = now;
                try { await flushQueued(5000, controller.signal); } catch (error) {
                  if (state !== 'open') return;
                  await finish('failed', 'persistence_error', 'The chat answer could not be saved.');
                  return;
                }
              }
              if (state !== 'open') return;
              output.enqueue(sse('delta', { text: event.text }));
            }
            if (event.type === 'done') { doneMarker = true; eventBillingStatus = event.billingStatus; }
          }
          if (state !== 'open') return;
          const terminal = execution.resolveTerminal === undefined ? undefined
            : await boundedChatWork(Promise.resolve().then(() => execution.resolveTerminal!()), 10_000, controller.signal);
          if (state !== 'open') return;
          const terminalState = terminal?.terminal ?? execution.terminal;
          const billingStatus = terminal?.billingStatus ?? execution.billingStatus ?? eventBillingStatus;
          if (terminalState === 'failed' || terminalState === 'stopped' || (!doneMarker && terminalState !== 'completed')) {
            await finish('failed', terminalState === 'stopped' ? 'cancelled' : 'incomplete_stream', 'The chat stream did not complete.');
            return;
          }
          await finish('completed', undefined, undefined, billingStatus);
        } catch (error) {
          if (state !== 'open') return;
          if (options.signal?.aborted) { await finish('cancelled'); return; }
          await finish('failed', error instanceof ChatGatewayStreamError ? error.code : 'gateway_error',
            error instanceof ChatGatewayStreamError ? error.safeMessage : 'The chat request failed.');
        }
      })();
      schedule(pump);
    },
    cancel() { return finish('cancelled'); },
  });
}

export function sseResponse(body: ReadableStream<Uint8Array>, requestId?: string): Response {
  return new Response(body, { status: 200, headers: {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...(requestId === undefined ? {} : { 'X-Request-Id': requestId }),
  } });
}
