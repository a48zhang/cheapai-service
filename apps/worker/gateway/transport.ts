import { DEFAULT_CONFIG } from '../config';
import { buildUpstreamHeaders } from './headers';
import type { UpstreamHeaderOptions } from './headers';
import { buildUpstreamUrl, validateUpstreamBaseUrl } from './upstream-url';
import { logError } from '../logging';

export type TransportFailure =
  | 'invalid_configuration'
  | 'cancelled'
  | 'headers_timeout'
  | 'request_timeout'
  | 'idle_timeout'
  | 'network_error'
  | 'stream_error';
export class UpstreamTransportError extends Error {
  constructor(
    readonly reason: TransportFailure,
    readonly execution: 'not_started' | 'uncertain',
    readonly upstreamStatus?: number,
    readonly diagnosticCause?: unknown,
  ) {
    super(`Upstream transport failed: ${reason}`);
    this.name = 'UpstreamTransportError';
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

/** A copy of the request fields that transport is about to give to fetch.
 * Headers are copied so an observer cannot change the live request. The body
 * remains the original immutable string; transport never clones or reads it.
 */
export interface UpstreamTransportRequestSnapshot {
  readonly url: string;
  readonly attempt: number;
  readonly init: Readonly<{
    method: string;
    headers: Headers;
    body?: string;
    redirect: 'manual';
  }>;
}

export type UpstreamTransportObservation =
  | { type: 'prepared'; request: UpstreamTransportRequestSnapshot }
  | { type: 'attempt'; request: UpstreamTransportRequestSnapshot }
  | { type: 'response_headers'; url: string; method: string; status: number; headers: Headers }
  | {
      type: 'redirect';
      url: string;
      nextUrl: string;
      method: string;
      nextMethod: string;
      status: number;
      strippedHeaders: string[];
    }
  | { type: 'complete'; url: string; method: string; status: number };

/** Optional observer for one sendUpstream call. Events are synchronous to
 * deliver but are never awaited; thrown errors and rejected promises are
 * ignored so observation cannot change transport behavior.
 */
export interface UpstreamTransportObserver {
  onEvent(event: UpstreamTransportObservation): void | Promise<void>;
}

function timeout(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum || value > 2_147_483_647)
    throw new Error();
  return value;
}

/** One upstream operation, following HTTP redirects without generated-request retries.
 * A network rejection after dispatch is uncertain execution, not proof of zero
 * upstream work. G12 may use additional provider evidence; this module cannot.
 * Total deadline persists until body EOF/cancel; idle timeout runs only while
 * awaiting an upstream read, so downstream backpressure is not mistaken for idle.
 */
export async function sendUpstream(
  options: UpstreamRequestOptions,
  dependencies: { fetch?: UpstreamFetch; observer?: UpstreamTransportObserver } = {},
): Promise<UpstreamExchange> {
  let url: URL;
  let headers: Headers;
  let totalMs: number;
  let headerMs: number;
  let idleMs: number;
  try {
    url = buildUpstreamUrl(options.baseUrl, options.upstreamProtocol);
    headers = buildUpstreamHeaders(options);
    totalMs = timeout(options.maxDurationMs ?? DEFAULT_CONFIG.requestMaxDurationMs, 2_147_483_647);
    headerMs = timeout(
      options.headersTimeoutMs ?? Math.min(DEFAULT_CONFIG.upstreamHeadersTimeoutMs, totalMs),
      totalMs,
    );
    idleMs = timeout(
      options.idleTimeoutMs ?? Math.min(DEFAULT_CONFIG.upstreamIdleTimeoutMs, totalMs),
      totalMs,
    );
  } catch (error) {
    logError(
      'Upstream request configuration failed',
      dependencies.observer
        ? new UpstreamTransportError('invalid_configuration', 'not_started')
        : error,
    );
    throw new UpstreamTransportError('invalid_configuration', 'not_started');
  }
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
  const done = new Promise<TransportCompletion>((resolve) => {
    complete = resolve;
  });
  let rejectHeaders: ((error: UpstreamTransportError) => void) | undefined;
  const interrupted = new Promise<Response>((_resolve, reject) => {
    rejectHeaders = reject;
  });
  const execution = () => (dispatched ? ('uncertain' as const) : ('not_started' as const));
  const finish = (error?: UpstreamTransportError): void => {
    if (terminal) return;
    terminal = true;
    failure = error;
    if (headerTimer !== undefined) clearTimeout(headerTimer);
    if (totalTimer !== undefined) clearTimeout(totalTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    options.signal?.removeEventListener('abort', onAbort);
    if (error) {
      if (error.reason !== 'cancelled')
        logError('Upstream transport failed', error, { protocol: options.upstreamProtocol });
      controller.abort(error);
      rejectHeaders?.(error);
      try {
        streamController?.error(error);
      } catch {
        /* Stream may already be cancelled. */
      }
      void reader?.cancel().catch(() => undefined);
    } else {
      try {
        reader?.releaseLock();
      } catch {
        /* EOF already closes source ownership. */
      }
    }
    rejectHeaders = undefined;
    complete(error ? { ok: false, error } : { ok: true });
  };
  function onAbort() {
    finish(new UpstreamTransportError('cancelled', execution()));
  }
  options.signal?.addEventListener('abort', onAbort, { once: true });
  totalTimer = setTimeout(
    () => finish(new UpstreamTransportError('request_timeout', execution())),
    totalMs,
  );
  headerTimer = setTimeout(
    () => finish(new UpstreamTransportError('headers_timeout', execution())),
    headerMs,
  );
  const fetcher =
    dependencies.fetch ?? ((target: string, init: RequestInit) => fetch(target, init));
  const observe = (event: UpstreamTransportObservation): void => {
    try {
      const result = dependencies.observer?.onEvent(event);
      if (result && typeof result.then === 'function')
        void Promise.resolve(result).catch(() => undefined);
    } catch {
      /* Diagnostics must not alter the upstream operation. */
    }
  };
  let upstream: Response;
  try {
    const pending = Promise.resolve().then(async () => {
      let target = url;
      let method = 'POST';
      let body: string | undefined = options.body;
      let requestHeaders = headers;
      for (let redirects = 0; ; redirects++) {
        if (terminal) throw failure;
        const init: RequestInit = {
          method,
          headers: requestHeaders,
          ...(body === undefined ? {} : { body }),
          redirect: 'manual',
          signal: controller.signal,
        };
        const requestSnapshot = (): UpstreamTransportRequestSnapshot => ({
          url: target.toString(),
          attempt: redirects + 1,
          init: {
            method,
            headers: new Headers(requestHeaders),
            ...(body === undefined ? {} : { body }),
            redirect: 'manual',
          },
        });
        observe({ type: 'prepared', request: requestSnapshot() });
        if (terminal) throw failure;
        dispatched = true;
        observe({ type: 'attempt', request: requestSnapshot() });
        const response = await fetcher(target.toString(), init);
        if (terminal) {
          void response.body?.cancel().catch(() => undefined);
          throw failure;
        }
        observe({
          type: 'response_headers',
          url: target.toString(),
          method,
          status: response.status,
          headers: new Headers(response.headers),
        });
        if (terminal) {
          void response.body?.cancel().catch(() => undefined);
          throw failure;
        }
        const location = response.headers.get('location');
        if (![301, 302, 303, 307, 308].includes(response.status) || location === null) {
          observe({ type: 'complete', url: target.toString(), method, status: response.status });
          if (terminal) {
            void response.body?.cancel().catch(() => undefined);
            throw failure;
          }
          return response;
        }
        void response.body?.cancel().catch(() => undefined);
        if (redirects === 20) throw new Error('Too many upstream redirects');
        const next = validateUpstreamBaseUrl(new URL(location, target).href);
        requestHeaders = new Headers(requestHeaders);
        const strippedHeaders: string[] = [];
        const stripHeader = (name: string): void => {
          if (requestHeaders.has(name)) {
            requestHeaders.delete(name);
            strippedHeaders.push(name);
          }
        };
        // Workers redirect:follow retains x-api-key and Cookie across origins.
        // Strip provider credentials explicitly, including Anthropic authentication.
        if (next.origin !== target.origin) {
          for (const name of ['authorization', 'x-api-key', 'cookie', 'proxy-authorization'])
            stripHeader(name);
        }
        const previousMethod = method;
        if (
          ((response.status === 301 || response.status === 302) && method === 'POST') ||
          (response.status === 303 && method !== 'GET' && method !== 'HEAD')
        ) {
          method = 'GET';
          body = undefined;
          for (const name of [
            'content-type',
            'content-length',
            'content-encoding',
            'content-language',
            'content-location',
          ])
            stripHeader(name);
        }
        observe({
          type: 'redirect',
          url: target.toString(),
          nextUrl: next.toString(),
          method: previousMethod,
          nextMethod: method,
          status: response.status,
          strippedHeaders,
        });
        if (terminal) throw failure;
        target = next;
      }
    });
    // If an injected fetch ignores abort and resolves late, discard its body too.
    void pending.then(
      (response) => {
        if (terminal) void response.body?.cancel().catch(() => undefined);
      },
      () => undefined,
    );
    upstream = await Promise.race([pending, interrupted]);
    if (failure) throw failure;
    if (headerTimer !== undefined) clearTimeout(headerTimer);
    headerTimer = undefined;
    rejectHeaders = undefined;
  } catch (cause) {
    const error = failure ?? new UpstreamTransportError('network_error', 'uncertain', undefined, cause);
    logError('Upstream fetch failed', dependencies.observer ? error : cause, {
      protocol: options.upstreamProtocol,
    });
    finish(error);
    throw error;
  }
  if (!upstream.ok)
    console.error('Upstream returned an HTTP error', {
      status: upstream.status,
      protocol: options.upstreamProtocol,
    });
  const cancel = () => finish(new UpstreamTransportError('cancelled', 'uncertain'));
  if (upstream.body === null) {
    finish();
    return { response: upstream, done, cancel };
  }
  try {
    reader = upstream.body.getReader();
  } catch (cause) {
    const error = new UpstreamTransportError('stream_error', 'uncertain', undefined, cause);
    logError('Upstream response reader failed', dependencies.observer ? error : cause);
    finish(error);
    throw error;
  }
  const body = new ReadableStream<Uint8Array>(
    {
      start(target) {
        streamController = target;
      },
      async pull(target) {
        if (terminal) return;
        idleTimer = setTimeout(
          () => finish(new UpstreamTransportError('idle_timeout', 'uncertain')),
          idleMs,
        );
        try {
          const part = await reader!.read();
          if (idleTimer !== undefined) clearTimeout(idleTimer);
          idleTimer = undefined;
          if (terminal) return;
          if (part.done) {
            target.close();
            finish();
          } else target.enqueue(part.value);
        } catch (cause) {
          const error = failure ?? new UpstreamTransportError('stream_error', 'uncertain', undefined, cause);
          logError('Upstream response stream failed', dependencies.observer ? error : cause);
          finish(error);
        }
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  try {
    const response = new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
    return { response, done, cancel };
  } catch (cause) {
    const error = new UpstreamTransportError('stream_error', 'uncertain', undefined, cause);
    logError('Upstream response construction failed', dependencies.observer ? error : cause);
    finish(error);
    throw error;
  }
}
