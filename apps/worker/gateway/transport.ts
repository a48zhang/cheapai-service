import { DEFAULT_CONFIG } from '../config';
import { buildUpstreamHeaders } from './headers';
import type { UpstreamHeaderOptions } from './headers';
import { buildUpstreamUrl } from './upstream-url';

export type TransportFailure = 'invalid_configuration' | 'cancelled' | 'headers_timeout' | 'request_timeout' | 'idle_timeout' | 'network_error' | 'stream_error' | 'redirect_rejected';
export class UpstreamTransportError extends Error {
  constructor(readonly reason: TransportFailure, readonly execution: 'not_started' | 'uncertain', readonly upstreamStatus?: number) {
    super(`Upstream transport failed: ${reason}`); this.name = 'UpstreamTransportError';
  }
}
export interface UpstreamRequestOptions extends UpstreamHeaderOptions {
  baseUrl: string;
  /** Already converted/serialized JSON. Transport neither converts nor replays it. */
  body: string;
  signal?: AbortSignal;
  headersTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxDurationMs?: number;
}
export type UpstreamFetch = (url: string, init: RequestInit) => Promise<Response>;
export type TransportCompletion = { ok: true } | { ok: false; error: UpstreamTransportError };
export interface UpstreamExchange {
  /** Internal upstream response; protocol coordinators own client header/error mapping. */
  response: Response;
  /** Always resolves, including when callers observe a stream failure separately. */
  done: Promise<TransportCompletion>;
  cancel(): void;
}
function timeout(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum || value > 2_147_483_647) throw new Error();
  return value;
}

/** Exactly one POST, with manual redirects and no generated-request retries.
 * A network rejection after dispatch is uncertain execution, not proof of zero
 * upstream work. G12 may use additional provider evidence; this module cannot.
 * Total deadline persists until body EOF/cancel; idle timeout runs only while
 * awaiting an upstream read, so downstream backpressure is not mistaken for idle.
 */
export async function sendUpstream(options: UpstreamRequestOptions, dependencies: { fetch?: UpstreamFetch } = {}): Promise<UpstreamExchange> {
  let url: URL; let headers: Headers; let totalMs: number; let headerMs: number; let idleMs: number;
  try {
    url = buildUpstreamUrl(options.baseUrl, options.upstreamProtocol);
    headers = buildUpstreamHeaders(options);
    if (typeof options.body !== 'string') throw new Error();
    totalMs = timeout(options.maxDurationMs ?? DEFAULT_CONFIG.requestMaxDurationMs, 2_147_483_647);
    headerMs = timeout(options.headersTimeoutMs ?? Math.min(DEFAULT_CONFIG.upstreamHeadersTimeoutMs, totalMs), totalMs);
    idleMs = timeout(options.idleTimeoutMs ?? Math.min(DEFAULT_CONFIG.upstreamIdleTimeoutMs, totalMs), totalMs);
  } catch { throw new UpstreamTransportError('invalid_configuration', 'not_started'); }
  if (options.signal?.aborted) throw new UpstreamTransportError('cancelled', 'not_started');

  const controller = new AbortController();
  let dispatched = false;
  let terminal = false;
  let failure: UpstreamTransportError | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let headerTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let complete!: (result: TransportCompletion) => void;
  const done = new Promise<TransportCompletion>((resolve) => { complete = resolve; });
  let rejectHeaders: ((error: UpstreamTransportError) => void) | undefined;
  const interrupted = new Promise<Response>((_resolve, reject) => { rejectHeaders = reject; });
  const execution = () => dispatched ? 'uncertain' as const : 'not_started' as const;
  const finish = (error?: UpstreamTransportError): void => {
    if (terminal) return;
    terminal = true; failure = error;
    if (headerTimer !== undefined) clearTimeout(headerTimer);
    if (totalTimer !== undefined) clearTimeout(totalTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    options.signal?.removeEventListener('abort', onAbort);
    if (error) {
      controller.abort(error);
      rejectHeaders?.(error);
      try { streamController?.error(error); } catch { /* Stream may already be cancelled. */ }
      void reader?.cancel().catch(() => undefined);
    } else {
      try { reader?.releaseLock(); } catch { /* EOF already closes source ownership. */ }
    }
    rejectHeaders = undefined;
    complete(error ? { ok: false, error } : { ok: true });
  };
  function onAbort() { finish(new UpstreamTransportError('cancelled', execution())); }
  options.signal?.addEventListener('abort', onAbort, { once: true });
  totalTimer = setTimeout(() => finish(new UpstreamTransportError('request_timeout', execution())), totalMs);
  headerTimer = setTimeout(() => finish(new UpstreamTransportError('headers_timeout', execution())), headerMs);
  const fetcher = dependencies.fetch ?? ((target: string, init: RequestInit) => fetch(target, init));
  let upstream: Response;
  try {
    const pending = Promise.resolve().then(() => {
      if (terminal) throw failure;
      dispatched = true;
      return fetcher(url.toString(), { method: 'POST', headers, body: options.body, redirect: 'manual', signal: controller.signal });
    });
    // If an injected fetch ignores abort and resolves late, discard its body too.
    void pending.then((response) => { if (terminal) void response.body?.cancel().catch(() => undefined); }, () => undefined);
    upstream = await Promise.race([pending, interrupted]);
    if (failure) throw failure;
    if (headerTimer !== undefined) clearTimeout(headerTimer);
    headerTimer = undefined; rejectHeaders = undefined;
  } catch {
    const error = failure ?? new UpstreamTransportError('network_error', 'uncertain');
    finish(error); throw error;
  }
  if (upstream.redirected || (upstream.status >= 300 && upstream.status < 400)) {
    void upstream.body?.cancel().catch(() => undefined);
    const error = new UpstreamTransportError('redirect_rejected', 'uncertain', upstream.status);
    finish(error); throw error;
  }
  const cancel = () => finish(new UpstreamTransportError('cancelled', 'uncertain'));
  if (upstream.body === null) { finish(); return { response: upstream, done, cancel }; }
  try { reader = upstream.body.getReader(); }
  catch {
    const error = new UpstreamTransportError('stream_error', 'uncertain');
    finish(error); throw error;
  }
  const body = new ReadableStream<Uint8Array>({
    start(target) { streamController = target; },
    async pull(target) {
      if (terminal) return;
      idleTimer = setTimeout(() => finish(new UpstreamTransportError('idle_timeout', 'uncertain')), idleMs);
      try {
        const part = await reader!.read();
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        idleTimer = undefined;
        if (terminal) return;
        if (part.done) { target.close(); finish(); }
        else target.enqueue(part.value);
      } catch {
        finish(failure ?? new UpstreamTransportError('stream_error', 'uncertain'));
      }
    },
    cancel,
  }, { highWaterMark: 0 });
  try {
    const response = new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
    return { response, done, cancel };
  } catch {
    const error = new UpstreamTransportError('stream_error', 'uncertain');
    finish(error); throw error;
  }
}
