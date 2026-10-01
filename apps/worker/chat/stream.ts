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
  if (!response.ok) throw new ChatGatewayStreamError('upstream_error', 'The chat upstream failed.');
  const body = response.body;
  if (!body) throw new ChatGatewayStreamError('invalid_upstream_stream', 'The chat stream was empty.');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | undefined;
  let data: string[] = [];
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
      if (next.done) break;
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
  } finally { try { reader.releaseLock(); } catch { /* body already released */ } }
}

async function* sourceEvents(source: ChatGatewaySource, signal?: AbortSignal): AsyncGenerator<ChatGatewayEvent, void, unknown> {
  if (source instanceof Response) { yield* responseEvents(source, signal); return; }
  if (typeof (source as ReadableStream<Uint8Array>).getReader === 'function') {
    yield* responseEvents(new Response(source as ReadableStream<Uint8Array>, { headers: { 'Content-Type': 'text/event-stream' } }), signal);
    return;
  }
  for await (const event of source as AsyncIterable<ChatGatewayEvent>) {
    if (signal?.aborted) throw new ChatGatewayStreamError('cancelled', 'Chat generation was cancelled.');
    yield event;
  }
}

function sse(event: string, value: unknown): Uint8Array {
  const encoded = JSON.stringify(value);
  return new TextEncoder().encode(`event: ${event}\ndata: ${encoded}\n\n`);
}

export function createChatSseStream(meta: ChatSseMeta, execution: ChatGatewayExecution, callbacks: ChatSseCallbacks,
  options: ChatSseOptions = {}): ReadableStream<Uint8Array> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal?.addEventListener('abort', stop, { once: true });
  let state: 'open' | 'closing' | 'finished' = 'open';
  let closePromise: Promise<void> | null = null;
  let outputController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let doneMarker = false;
  let eventBillingStatus: string | undefined;
  let queuedText = '';
  let lastPersist = Date.now();

  const schedule = (work: Promise<unknown>): void => {
    try { options.waitUntil?.(work.then(() => undefined, () => undefined)); } catch { /* execution context may already be closed */ }
  };
  const emit = (output: ReadableStreamDefaultController<Uint8Array> | undefined, event: string, value: unknown): void => {
    try { output?.enqueue(sse(event, value)); } catch { /* client disconnected */ }
  };
  const closeOutput = (output?: ReadableStreamDefaultController<Uint8Array>): void => {
    try { output?.close(); } catch { /* client disconnected */ }
  };
  const markFinished = (): void => {
    state = 'finished';
    options.signal?.removeEventListener('abort', stop);
  };
  const flushQueued = async (): Promise<void> => {
    if (queuedText.length === 0) return;
    const text = queuedText;
    queuedText = '';
    await callbacks.onDelta(text);
  };

  /** Every terminal callback is bounded by a finally-like close path.  A D1
   * failure must remain visible to the browser and cannot strand SSE open. */
  const finishFailure = (code: string, message: string, output?: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      state = 'closing';
      let persistenceError = false;
      try { await flushQueued(); } catch { persistenceError = true; }
      const safeCode = safeErrorCode(code);
      const safeMessage = safeErrorMessage(message);
      let final: ChatMessage | null = null;
      const failed = Promise.resolve().then(() => callbacks.onFailed(safeCode, safeMessage));
      schedule(failed);
      try { final = await failed; } catch { persistenceError = true; }
      markFinished();
      emit(output, 'error', { code: persistenceError ? 'persistence_error' : safeCode,
        message: persistenceError ? 'The chat answer could not be saved.' : safeMessage, ...(final ? { messageId: final.id } : {}) });
      closeOutput(output);
    })();
    return closePromise;
  };

  const finishCancelled = (output?: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      state = 'closing';
      let persistenceError = false;
      try { await flushQueued(); } catch { persistenceError = true; }
      let final: ChatMessage | null = null;
      const cancelled = Promise.resolve().then(() => callbacks.onCancelled());
      schedule(cancelled);
      try { final = await cancelled; } catch { persistenceError = true; }
      markFinished();
      if (persistenceError) emit(output, 'error', { code: 'persistence_error', message: 'The chat answer could not be saved.' });
      else emit(output, 'done', { message: final, ...(final ? { stopped: true } : {}) });
      closeOutput(output);
    })();
    return closePromise;
  };

  const finishCompleted = (billingStatus: string | undefined, output?: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      state = 'closing';
      let final: ChatMessage | null = null;
      const completed = Promise.resolve().then(() => callbacks.onDone(billingStatus));
      schedule(completed);
      try { final = await completed; } catch {
        const failed = Promise.resolve().then(() => callbacks.onFailed('persistence_error', 'The chat answer could not be saved.'));
        schedule(failed);
        try { final = await failed; } catch { /* error remains visible below */ }
        markFinished();
        emit(output, 'error', { code: 'persistence_error', message: 'The chat answer could not be saved.', ...(final ? { messageId: final.id } : {}) });
        closeOutput(output);
        return;
      }
      markFinished();
      emit(output, 'done', { message: final, ...(billingStatus === undefined ? {} : { billingStatus }) });
      closeOutput(output);
    })();
    return closePromise;
  };

  return new ReadableStream<Uint8Array>({
    start(output) {
      outputController = output;
      output.enqueue(sse('meta', meta));
      void (async () => {
        try {
          for await (const event of sourceEvents(execution.source, controller.signal)) {
            if (state !== 'open') return;
            if (event.type === 'error') throw new ChatGatewayStreamError(event.code, event.message);
            if (event.type === 'delta') {
              if (!event.text) continue;
              const delta = event.text;
              queuedText += delta;
              const now = Date.now();
              if (queuedText.length >= 2048 || now - lastPersist >= 1500) {
                const persisted = queuedText; queuedText = ''; lastPersist = now;
                await callbacks.onDelta(persisted);
              }
              // Persistence batching is independent from presentation. Every
              // upstream delta is emitted exactly once, even when it also
              // closes a checkpoint batch.
              output.enqueue(sse('delta', { text: delta }));
            }
            if (event.type === 'done') { doneMarker = true; eventBillingStatus = event.billingStatus; }
          }
          await flushQueued();
          if (state !== 'open') return;
          const terminal = execution.resolveTerminal === undefined ? undefined : await execution.resolveTerminal();
          const terminalState = terminal?.terminal ?? execution.terminal;
          const billingStatus = terminal?.billingStatus ?? execution.billingStatus ?? eventBillingStatus;
          // A typed [DONE] is sufficient upstream terminal evidence. EOF is
          // sufficient only when `terminalState` came from gateway authority;
          // absent authority remains incomplete and cannot become completed.
          if (terminalState === 'failed' || terminalState === 'stopped' || (!doneMarker && terminalState !== 'completed')) {
            await finishFailure(terminalState === 'stopped' ? 'cancelled' : 'incomplete_stream', 'The chat stream did not complete.', output);
            return;
          }
          await finishCompleted(billingStatus, output);
        } catch (error) {
          if (controller.signal.aborted || options.signal?.aborted) {
            try { await execution.cancel?.(); } catch { /* cancellation is best effort */ }
            await finishCancelled(output);
            return;
          }
          await finishFailure(error instanceof ChatGatewayStreamError ? error.code : 'gateway_error', error instanceof ChatGatewayStreamError ? error.safeMessage : 'The chat request failed.', output);
        }
      })();
    },
    async cancel() {
      stop();
      try { await execution.cancel?.(); } catch { /* cancellation is best effort */ }
      await finishCancelled(outputController);
    },
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
