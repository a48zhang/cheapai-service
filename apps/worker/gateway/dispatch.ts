import { defaultProtocolRegistry } from '@sub2api/apicompat';
import type { ProtocolRegistry, ResolvedProtocolAdapters } from '@sub2api/apicompat';
import { encodeChatError, encodeResponsesError, encodeMessagesError } from '@sub2api/apicompat/errors';
import type { Protocol, ProtocolError, SseFrame } from '@sub2api/apicompat/types/shared';
import type { ProtocolRequest } from '@sub2api/apicompat/capabilities/check';
import { authenticatePlatformKey } from '../auth/api-key-auth';
import type { InternalPlatformKeyAuth } from '../auth/key-repository';
import { API_ERRORS, ApiError } from '../http';
import type { ChannelKeyring } from '../admin/channel-secrets';
import { prepare } from '../db';
import { admitRequest, GatewayAdmissionError } from './admit';
import type { AdmissionBindings, AdmittedRequest, CandidateExclusion } from './admit';
import { parseChatInput } from './parse-chat';
import { parseResponsesInput } from './parse-responses';
import { parseMessagesInput } from './parse-messages';
import { executeJson, JsonExecutionError } from './execute-json';
import { executeStream, StreamExecutionError } from './execute-stream';
import { createRequestFinalizer, finalizationFromJson } from './finalize';
import { finishRequest } from './request-repository';
import { decideCandidateRetry } from './retry-policy';
import type { UpstreamFetch, UpstreamRequestOptions } from './transport';
import type { UpstreamHeaderOptions } from './headers';
import { createRequestObserver } from './observability';
import type { ObservationSink, RequestObserver } from './observability';
import type { RequestSource } from './request-repository';

export interface GatewayDispatchDependencies extends AdmissionBindings {
  /** Resolve secrets only after authentication and successful body parsing. */
  readonly keyring: ChannelKeyring | (() => ChannelKeyring | Promise<ChannelKeyring>);
  readonly registry?: ProtocolRegistry;
  readonly fetch?: UpstreamFetch;
  readonly now?: () => number;
  readonly messagesPolicy?: UpstreamHeaderOptions['messages'];
  readonly transport?: Pick<UpstreamRequestOptions, 'headersTimeoutMs' | 'idleTimeoutMs' | 'maxDurationMs'>;
  /** Best-effort sink for bounded, redacted lifecycle observations. */
  readonly observe?: ObservationSink;
}
/**
 * Server-only gateway entry. The caller must have already authenticated the
 * web session and constructed the InternalPlatformKeyAuth projection. There is
 * deliberately no HTTP header/body credential field here, so this path cannot
 * be reached by relabelling a browser request as a Bearer request.
 */
export interface TrustedGatewayDispatchInput {
  readonly subject: InternalPlatformKeyAuth;
  readonly request: ProtocolRequest;
  readonly betas?: readonly string[];
  /** Runs after the D1 request row is committed and before upstream fetch. */
  readonly onRegistered?: (requestId: string) => void | Promise<void>;
  readonly signal?: AbortSignal;
}
export const MAX_UNREGISTERED_CANDIDATE_ATTEMPTS = 3;
const observationFailure = { status: 'failed' as const,
  error: { kind: 'upstream_error' as const, code: 'gateway_error', message: 'Gateway request failed.' } };

function responseHeaders(requestId: string): Headers {
  return new Headers({ 'Cache-Control': 'no-store', 'X-Request-Id': requestId });
}
function nativeError(protocol: Protocol, error: unknown, requestId: string): Response {
  let status: number = error instanceof ApiError ? API_ERRORS[error.code].status : 503;
  if (error instanceof JsonExecutionError) {
    if (error.reason === 'conversion_failed') status = error.dispatched ? 502 : 400;
    else if (error.reason === 'upstream_failed' && error.dispatched) status = 502;
  }
  if (error instanceof StreamExecutionError) status = error.reason === 'invalid_request' ? 400 : error.dispatched ? 502 : 503;
  const shared: ProtocolError = { kind: status < 500 ? 'invalid_request' : 'upstream_error', code: 'gateway_error', message: 'Gateway request failed.' };
  const body = protocol === 'chat' ? encodeChatError(shared) : protocol === 'responses' ? encodeResponsesError(shared) : encodeMessagesError(shared);
  const safeBody = error instanceof ApiError
    ? { ...body, error: { ...body.error, message: API_ERRORS[error.code].message, ...('code' in body.error ? { code: error.code } : {}) } } : body;
  return Response.json(safeBody, { status, headers: responseHeaders(requestId) });
}

/** Presentation only: G08 has already observed each ORIGINAL upstream frame. */
function hideChatUsage(events: readonly SseFrame[]): SseFrame[] {
  return events.flatMap(event => {
    if (event.data === '[DONE]') return [event];
    let value: unknown; try { value = JSON.parse(event.data); } catch { return [event]; }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'usage')) return [event];
    const chunk = value as Record<string, unknown>;
    if (Array.isArray(chunk.choices) && chunk.choices.length === 0) return [];
    const publicChunk = { ...chunk }; delete publicChunk.usage;
    return [{ ...event, data: JSON.stringify(publicChunk) }];
  });
}
function streamingAdapters(bundle: ResolvedProtocolAdapters, downstream: Protocol, upstream: Protocol, showUsage: boolean): ResolvedProtocolAdapters {
  return { ...bundle,
    request: { ...bundle.request, convert(input, context) {
      const converted = bundle.request.convert(input, context);
      if (!converted.ok || upstream !== 'chat') return converted;
      const options = converted.value.stream_options;
      return { ok: true, value: { ...converted.value, stream: true,
        stream_options: { ...(options && typeof options === 'object' && !Array.isArray(options) ? options : {}), include_usage: true } } };
    } },
    stream: { ...bundle.stream, create(context, options) {
      const created = bundle.stream.create(context, options);
      if (!created.ok || downstream !== 'chat' || showUsage) return created;
      return { ok: true, value: {
        push(frame) { const result = created.value.push(frame); return { ...result, events: hideChatUsage(result.events) }; },
        finish(end) { const result = created.value.finish(end); return { ...result, events: hideChatUsage(result.events) }; },
      } };
    } },
  };
}

function trustedRequestUrl(protocol: Protocol): string {
  return protocol === 'chat' ? 'https://internal.invalid/v1/chat/completions'
    : protocol === 'responses' ? 'https://internal.invalid/v1/responses' : 'https://internal.invalid/v1/messages';
}

/**
 * Dispatch a request from a server-authenticated chat route through the same
 * admission, routing, protocol adaptation, JSON/SSE execution and accounting
 * lifecycle as the external API. The only identity comes from `subject`; the
 * synthetic Request carries JSON solely to reuse the strict protocol parser.
 */
export async function dispatchTrustedGatewayRequest(dependencies: GatewayDispatchDependencies,
  input: TrustedGatewayDispatchInput, context: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
  if (!input || typeof input !== 'object' || !input.subject || !input.request ||
      !['chat', 'responses', 'messages'].includes(input.request.protocol)) throw new ApiError('invalid_request');
  if (input.signal?.aborted) throw new ApiError('conflict');
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (input.request.protocol === 'messages') {
    headers.set('anthropic-version', '2023-06-01');
    if (input.betas !== undefined) {
      if (!Array.isArray(input.betas) || input.betas.length > 16 || input.betas.some(value => typeof value !== 'string')) throw new ApiError('invalid_request');
      headers.set('anthropic-beta', [...new Set(input.betas)].join(','));
    }
  } else if (input.betas !== undefined && input.betas.length > 0) throw new ApiError('invalid_request');
  let body: string;
  try { body = JSON.stringify(input.request.request); } catch { throw new ApiError('invalid_request'); }
  const request = new Request(trustedRequestUrl(input.request.protocol), {
    method: 'POST', headers, body, ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return dispatchGatewayRequest(dependencies, request, input.request.protocol, context, {
    subject: input.subject, source: 'web_chat', ...(input.onRegistered === undefined ? {} : { onRegistered: input.onRegistered }),
  });
}

/** No speculative second generation after admission; only reviewed unregistered denials can skip a channel. */
export async function dispatchGatewayRequest(dependencies: GatewayDispatchDependencies, request: Request, downstream: Protocol,
  context: Pick<ExecutionContext, 'waitUntil'>, trusted?: {
    readonly subject: InternalPlatformKeyAuth;
    readonly source: RequestSource;
    readonly onRegistered?: (requestId: string) => void | Promise<void>;
  }): Promise<Response> {
  let now: () => number = Date.now;
  let requestId: string = crypto.randomUUID();
  let admission: AdmittedRequest | undefined;
  let observer: RequestObserver | undefined;
  let transferred = false;
  const own = (work: Promise<unknown>) => context.waitUntil(work.then(() => undefined, () => undefined));
  try {
    now = dependencies.now ?? Date.now;
    if (request.method !== 'POST') throw new ApiError('invalid_request');
    const subject = trusted?.subject ?? await authenticatePlatformKey(dependencies.DB, request, now());
    const parsed = downstream === 'chat' ? await parseChatInput(request) : downstream === 'responses' ? await parseResponsesInput(request) : await parseMessagesInput(request);
    // Requested betas are not an allowlist. Only trusted deployment/channel policy grants them.
    if (parsed.protocol === 'messages' && parsed.betas.some(beta => !dependencies.messagesPolicy?.allowedBetas?.includes(beta))) throw new ApiError('invalid_request');
    const configuredKeyring = dependencies.keyring;
    const keyring = typeof configuredKeyring === 'function' ? await configuredKeyring() : configuredKeyring;
    if (!keyring || typeof keyring.get !== 'function') throw new ApiError('service_unavailable');
    const registry = dependencies.registry ?? defaultProtocolRegistry;
    const original: ProtocolRequest = { protocol: parsed.protocol, request: parsed.request } as ProtocolRequest;
    const showUsage = parsed.protocol === 'chat' && parsed.request.stream_options?.include_usage === true;
    const excluded: CandidateExclusion[] = [];
    for (let attempt = 0; attempt < MAX_UNREGISTERED_CANDIDATE_ATTEMPTS; attempt++) {
      try {
        admission = await admitRequest(dependencies, subject, original, { now, signal: request.signal, excludeCandidates: excluded,
          requireChatStreamUsage: true, source: trusted?.source ?? 'api', adapterAvailable: direction => registry.available(direction) });
        break;
      } catch (error) {
        if (error instanceof GatewayAdmissionError) {
          if (error.registeredRequestId !== null) requestId = error.registeredRequestId;
          if (!error.cleanup.complete) own(error.retryCleanup());
          if (error.candidate && error.candidateFailure && error.registeredRequestId === null) {
            const decision = decideCandidateRetry({ candidate: { channelId: error.candidate.channelId }, registeredRequestId: null,
              dispatchAttempts: 0, switchesUsed: 0, outputStarted: false, cleanupComplete: error.cleanup.complete,
              failure: { kind: error.candidateFailure } });
            if (decision.action === 'skip_unregistered_candidate' && attempt + 1 < MAX_UNREGISTERED_CANDIDATE_ATTEMPTS) {
              excluded.push(...decision.excludeCandidates); continue;
            }
          }
        }
        throw error;
      }
    }
    if (!admission) throw new ApiError('service_unavailable');
    requestId = admission.request.id;
    if (trusted?.onRegistered) await trusted.onRegistered(requestId);
    observer = createRequestObserver(admission.request, { now, ...(dependencies.observe === undefined ? {} : { sink: dependencies.observe }) });
    observer.mark('admitted');
    const upstream = admission.request.upstream_protocol;
    const resolved = registry.lookup({ from: downstream, to: upstream, streaming: parsed.stream }, {
      capabilities: admission.selected.candidate.mapping.capabilities, ...(admission.outputTokenLimit === undefined ? {} : { outputTokenLimit: admission.outputTokenLimit }) });
    if (!resolved.ok) throw new ApiError('service_unavailable');
    if (parsed.protocol === 'messages' && parsed.betas.length > 0 && upstream !== 'messages') throw new ApiError('invalid_request');
    const transport = { ...dependencies.transport, downstreamHeaders: request.headers,
      messages: dependencies.messagesPolicy ?? { allowedBetas: [] } };
    const executionDependencies = { database: dependencies.DB, keyring, now,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}), waitUntil: own };
    if (!parsed.stream) {
      transferred = true;
      observer.mark('upstream_started');
      const result = await executeJson(executionDependencies, admission, resolved.value, { signal: request.signal, transport });
      const finalization = finalizationFromJson(result); // G07 already settled and released; do not run G11 again.
      observer.mark('first_byte', { usage: result.usage });
      observer.mark('settlement', { usage: result.usage, finalization });
      observer.finish({ terminal: { status: 'completed', reason: 'stop' }, usage: result.usage, finalization });
      return Response.json(result.body, { status: 200, headers: responseHeaders(requestId) });
    }
    const finalizer = createRequestFinalizer({ database: dependencies.DB, request: admission.request, now, waitUntil: own });
    transferred = true;
    const execution = await executeStream(executionDependencies, admission,
      streamingAdapters(resolved.value, downstream, upstream, showUsage), { signal: request.signal, transport, onComplete: finalizer.onComplete });
    own(execution.completion); // Covers EOF, cancellation and bounded accounting after HTTP consumption.
    observer.mark('upstream_started');
    observer.mark('first_byte');
    own(execution.completion.then(async completion => {
      let finalization: Awaited<NonNullable<typeof finalizer.completion>> | undefined;
      try { finalization = finalizer.completion === null ? undefined : await finalizer.completion; } catch { /* Telemetry cannot alter execution. */ }
      const details = { usage: completion.usage, ...(finalization === undefined ? {} : { finalization }) };
      observer?.mark('stream_terminal', { terminal: completion.terminal, ...details });
      observer?.mark('settlement', details);
      observer?.finish({ terminal: completion.terminal, ...details });
    }, () => {
      observer?.finish({ terminal: observationFailure });
    }));
    const headers = new Headers(execution.response.headers);
    headers.set('X-Request-Id', requestId); headers.set('Cache-Control', 'no-store');
    return new Response(execution.response.body, { status: execution.response.status, headers });
  } catch (error) {
    observer?.finish({ terminal: observationFailure });
    if (admission && (!transferred || (error instanceof StreamExecutionError && error.completion === null))) {
      const held = admission;
      const ownsUnstarted = !transferred;
      own((async () => {
        // Only the still-unstarted owner is ours to release. A started competing
        // execution retains ownership; do not release its permit or mark it free.
        let release = ownsUnstarted;
        try {
        const unused = await prepare(dependencies.DB, `UPDATE requests SET billing_status='not_chargeable'
          WHERE id=? AND user_id=? AND started_at IS NULL AND execution_status='admitted' AND billing_status='awaiting_usage'
            AND NOT EXISTS(SELECT 1 FROM billing_entries WHERE request_id=requests.id AND kind='consumption')`, [held.request.id, held.request.user_id]).run();
        if (unused.changes === 1) {
          release = true;
          await finishRequest(dependencies.DB, held.request.id, held.request.user_id, { status: 'failed', errorCode: 'internal_error' }, now());
        }
        } finally { if (release) await held.lease.release(); }
      })());
    }
    return nativeError(downstream, error, requestId);
  }
}
