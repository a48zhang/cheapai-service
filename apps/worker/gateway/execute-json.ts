import type { JsonResponseAdapter, RequestAdapter } from '@sub2api/apicompat/types/adapter';
import type { UsageSnapshot } from '@sub2api/apicompat/types/shared';
import { createResponseIds } from '@sub2api/apicompat/ids';
import { extractChatUsage } from '@sub2api/apicompat/usage/chat';
import { extractResponsesUsage } from '@sub2api/apicompat/usage/responses';
import { extractMessagesUsage } from '@sub2api/apicompat/usage/messages';
import { readChannelForForwarding } from '../catalog/channels';
import type { ChannelKeyring } from '../catalog/channel-secrets';
import { settleRequest } from '../billing/settlement';
import type { SettlementOptions } from '../billing/settlement';
import { saveSettlementRecovery } from '../billing/recovery';
import { DEFAULT_CONFIG } from '../config';
import { prepare } from '../db';
import { ApiError } from '../http';
import type { DualLeaseCleanupReport, DualLeasePermit } from '../limits/dual-lease';
import type { AdmittedRequest } from './admit';
import { finishRequest, getRequest, markRequestStarted } from './request-repository';
import type { RequestRecord } from './request-repository';
import { sendUpstream, UpstreamTransportError } from './transport';
import type { UpstreamExchange, UpstreamFetch, UpstreamRequestOptions } from './transport';
import { createRequestLifecycle } from './request-lifecycle';

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

export interface JsonExecutionDependencies {
  database: D1Database; keyring: ChannelKeyring; fetch?: UpstreamFetch; now?: () => number;
  waitUntil?(work: Promise<unknown>): void;
}
export interface JsonExecutionAdapters<Input, Wire, Upstream, Output> {
  request: RequestAdapter<Input, Wire>;
  response: JsonResponseAdapter<Upstream, Output>;
}
export interface JsonExecutionOptions {
  signal?: AbortSignal;
  /** Internal, bounded metadata-only hook, invoked before reading any response body. */
  onUpstreamResponse?: (response: { channelId: string; status: number; retryAfter: string | null }) => void | Promise<void>;
  transport?: Pick<UpstreamRequestOptions, 'headersTimeoutMs' | 'idleTimeoutMs' | 'maxDurationMs' | 'downstreamHeaders' | 'messages' | 'customHeaders'>;
  settlement?: SettlementOptions;
  maxResponseBytes?: number;
}
export interface JsonExecutionResult<Output> {
  requestId: string; body: Output; usage: UsageSnapshot; billingStatus: string; cleanup: DualLeaseCleanupReport;
}
export class JsonExecutionError extends ApiError {
  constructor(readonly reason: 'admission_invalid' | 'already_started' | 'conversion_failed' | 'upstream_failed' | 'cancelled' | 'lease_lost' | 'service_failure',
    readonly requestId: string, readonly billingStatus: string, readonly cleanup: DualLeaseCleanupReport | null, readonly dispatched = false) {
    super(reason === 'admission_invalid' || reason === 'already_started' ? 'conflict'
      : reason === 'conversion_failed' && !dispatched ? 'invalid_request' : 'service_unavailable');
    this.name = 'JsonExecutionError';
  }
}
// A permit is transferred to one local lifecycle. Reentrant callers must not
// release the first caller's leases; the D1 start CAS also protects other callers.
const consumed = new WeakSet<DualLeasePermit>();
function nativeId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(value) ? value : undefined;
}
async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new Error();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      if (part.value.byteLength > maxBytes - length) { void reader.cancel().catch(() => undefined); throw new Error(); }
      chunks.push(part.value); length += part.value.byteLength;
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) as unknown;
  } finally { reader.releaseLock(); }
}

/** Owns one already-admitted ordinary request. It does not route/admit again or
 * retry generation. All usage comes from the original upstream protocol; the
 * response adapter cannot alter the detached accounting snapshot.
 */
export async function executeJson<Input, Wire, Upstream, Output>(dependencies: JsonExecutionDependencies, admission: AdmittedRequest,
  adapters: JsonExecutionAdapters<Input, Wire, Upstream, Output>, options: JsonExecutionOptions = {}): Promise<JsonExecutionResult<Output>> {
  const requestId = admission.request.id;
  if (consumed.has(admission.lease)) throw new JsonExecutionError('already_started', requestId, admission.request.billing_status, null);
  consumed.add(admission.lease);
  const clock = () => { const time = (dependencies.now ?? Date.now)(); if (!Number.isSafeInteger(time) || time < 0) throw new Error(); return time; };
  const lifecycle = createRequestLifecycle(admission.lease, { ...(options.signal === undefined ? {} : { signal: options.signal }),
    clock, ...(options.transport?.maxDurationMs === undefined ? {} : { maxDurationMs: options.transport.maxDurationMs }) });
  let request: RequestRecord | null = null;
  let claimed = false; let cleanupAllowed = true; let dispatched = false; let terminalSaved = false;
  let exchange: UpstreamExchange | undefined;
  let usage: UsageSnapshot = { quality: 'missing', protocol: admission.request.upstream_protocol };
  let billingStatus = admission.request.billing_status;
  let cleanup: DualLeaseCleanupReport | null = null;
  let failure: JsonExecutionError['reason'] | undefined;
  let resultBody: Output | undefined;
  let upstreamResponseId: string | undefined; let upstreamRequestId: string | undefined;
  const userHandle = admission.lease.user.handle; const channelHandle = admission.lease.channel.handle;
  const recover = async () => {
    if (!request) return;
    const result = await lifecycle.persist(() => saveSettlementRecovery(dependencies.database, { requestId, userId: request!.user_id, usage }, clock()));
    billingStatus = result.billingStatus;
  };
  try {
    request = await lifecycle.persist(() => getRequest(dependencies.database, requestId, admission.request.user_id));
    if (!request || ['user_id', 'api_key_id', 'channel_id', 'public_model_id', 'upstream_model', 'downstream_protocol', 'upstream_protocol', 'price_snapshot'].some(
      (field) => request![field as keyof RequestRecord] !== admission.request[field as keyof RequestRecord])) {
      failure = 'admission_invalid'; throw new Error();
    }
    if (request.execution_status !== 'admitted' || request.started_at !== null || request.billing_status !== 'awaiting_usage') {
      cleanupAllowed = false; failure = 'already_started'; throw new Error();
    }
    if (!await lifecycle.persist(() => markRequestStarted(dependencies.database, requestId, request!.user_id, clock()))) {
      cleanupAllowed = false; failure = 'already_started'; throw new Error();
    }
    claimed = true;
    const selected = admission.selected.candidate;
    if (selected.channel.id !== request.channel_id || selected.mapping.publicModelId !== request.public_model_id
        || selected.mapping.protocol !== request.upstream_protocol || selected.mapping.upstreamModel !== request.upstream_model
        || userHandle.requestId !== requestId || userHandle.subject.id !== request.user_id || userHandle.subject.kind !== 'user'
        || channelHandle.requestId !== requestId || channelHandle.subject.id !== request.channel_id || channelHandle.subject.kind !== 'channel'
        || userHandle.expiresAt <= clock() || channelHandle.expiresAt <= clock()
        || admission.requestForAdapter.protocol !== request.downstream_protocol || admission.requestForAdapter.request.model !== request.public_model_id
        || (admission.outputTokenLimit !== undefined && (!Number.isSafeInteger(admission.outputTokenLimit) || admission.outputTokenLimit < 1))) { failure = 'admission_invalid'; throw new Error(); }
    if (lifecycle.signal.aborted) { failure = 'cancelled'; throw new Error(); }
    lifecycle.start();
    if (adapters.request.from !== request.downstream_protocol || adapters.request.to !== request.upstream_protocol
        || adapters.response.from !== request.upstream_protocol || adapters.response.to !== request.downstream_protocol) { failure = 'service_failure'; throw new Error(); }
    failure = 'service_failure';
    const converted = adapters.request.convert(JSON.parse(JSON.stringify(admission.requestForAdapter.request)) as Input, { targetModel: request.upstream_model });
    if (!converted.ok) { failure = 'conversion_failed'; throw new Error(); }
    if (converted.value === null || typeof converted.value !== 'object' || Array.isArray(converted.value)) throw new Error();
    const wire = { ...converted.value, model: request.upstream_model, stream: false } as Record<string, unknown>;
    if (request.upstream_protocol === 'chat') delete wire.stream_options;
    const body = JSON.stringify(wire);
    failure = 'service_failure';
    const upstream = await lifecycle.active(readChannelForForwarding(dependencies.database, request.channel_id, dependencies.keyring));
    if (!upstream || upstream.configVersion !== selected.channel.configVersion || upstream.status !== 'active') throw new Error();
    const maxBytes = options.maxResponseBytes ?? DEFAULT_CONFIG.gatewayBodyMaxBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error();
    failure = 'upstream_failed';
    try {
      // Conservatively assume dispatch unless G02 explicitly proves not_started.
      dispatched = true;
      exchange = await sendUpstream({ ...options.transport, baseUrl: upstream.baseUrl, upstreamProtocol: request.upstream_protocol,
        upstreamKey: upstream.upstreamKey, stream: false, body, signal: lifecycle.signal }, dependencies.fetch ? { fetch: dependencies.fetch } : {});
    } catch (error) {
      if (error instanceof UpstreamTransportError && error.execution === 'not_started') dispatched = false;
      throw error;
    }
    lifecycle.attachUpstream(() => exchange!.cancel());
    await observeUpstreamResponse(options.onUpstreamResponse, request.channel_id, exchange.response, lifecycle.signal);
    const raw = await lifecycle.active(readJson(exchange.response, maxBytes));
    const completion = await lifecycle.active(exchange.done);
    if (!completion.ok) throw completion.error;
    upstreamRequestId = nativeId(exchange.response.headers.get('request-id') ?? exchange.response.headers.get('x-request-id'));
    upstreamResponseId = nativeId(raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>).id : undefined);
    const extracted = request.upstream_protocol === 'chat' ? extractChatUsage(raw) : request.upstream_protocol === 'responses' ? extractResponsesUsage(raw) : extractMessagesUsage(raw);
    usage = JSON.parse(JSON.stringify(extracted)) as UsageSnapshot;
    failure = 'service_failure';
    if (lifecycle.signal.aborted) throw new Error();
    lifecycle.beginFinalization(true);
    if (usage.quality === 'complete') {
      try {
        const outcome = await lifecycle.persist(() => settleRequest(dependencies.database, request!, usage, { ...options.settlement, now: clock }));
        if (outcome.status === 'settled') billingStatus = 'settled';
        else { if (outcome.inFlight) dependencies.waitUntil?.(outcome.inFlight); await recover(); }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'invalid_request') await recover();
        else { await recover(); throw error; }
      }
    } else await recover();
    if (!exchange.response.ok) { failure = 'upstream_failed'; throw new Error(); }
    if (lifecycle.signal.aborted) { failure = lifecycle.reason === 'lease_lost' ? 'lease_lost' : 'cancelled'; throw new Error(); }
    failure = 'conversion_failed';
    const ids = createResponseIds({ seed: requestId, ...(upstreamResponseId === undefined ? {} : { upstreamResponseId }) });
    if (!ids.ok) throw new Error();
    const output = adapters.response.convert(raw as Upstream, { identity: ids.value.identity, idFor: ids.value.idFor,
      targetModel: request.public_model_id, createdAt: Math.floor(request.created_at / 1000) });
    if (!output.ok || output.value.identity.responseId !== ids.value.identity.responseId || output.value.body === undefined) throw new Error();
    if (output.value.terminal.status === 'failed' || output.value.terminal.status === 'cancelled') throw new Error();
    resultBody = output.value.body;
    if (!await lifecycle.persist(() => finishRequest(dependencies.database, requestId, request!.user_id, { status: 'succeeded',
      ...(upstreamResponseId === undefined ? {} : { responseId: upstreamResponseId }), ...(upstreamRequestId === undefined ? {} : { upstreamRequestId }) }, clock()))) throw new Error();
    terminalSaved = true; failure = undefined;
  } catch {
    failure = lifecycle.reason === 'lease_lost' ? 'lease_lost' : lifecycle.reason === 'cancelled' || options.signal?.aborted ? 'cancelled' : failure ?? 'service_failure';
    lifecycle.beginFinalization(false);
    lifecycle.stop('failed');
    if (claimed && request && !terminalSaved) {
      try {
        if (dispatched) { if (billingStatus !== 'settled') await recover(); }
        else {
          const marked = await lifecycle.persist(() => prepare(dependencies.database, `UPDATE requests SET billing_status='not_chargeable',updated_at=max(updated_at,?)
            WHERE id=? AND user_id=? AND billing_status='awaiting_usage' AND NOT EXISTS(SELECT 1 FROM billing_entries WHERE request_id=requests.id AND kind='consumption')`, [clock(), requestId, request!.user_id]).run());
          if (marked.changes !== 1) throw new Error();
          billingStatus = 'not_chargeable';
        }
      } catch { failure = 'service_failure'; }
      try {
        terminalSaved = await lifecycle.persist(() => finishRequest(dependencies.database, requestId, request!.user_id, {
          status: failure === 'cancelled' ? 'cancelled' : 'failed',
          errorCode: failure === 'cancelled' ? 'client_cancelled' : dispatched ? 'upstream_error' : 'internal_error',
          ...(upstreamResponseId === undefined ? {} : { responseId: upstreamResponseId }), ...(upstreamRequestId === undefined ? {} : { upstreamRequestId }),
        }, clock()));
        if (!terminalSaved) failure = 'service_failure';
      } catch { failure = 'service_failure'; }
    }
  } finally {
    const report = await lifecycle.close(cleanupAllowed);
    if (cleanupAllowed) cleanup = report;
  }
  if (failure || !cleanup) throw new JsonExecutionError(failure ?? 'service_failure', requestId, billingStatus, cleanup, dispatched);
  return { requestId, body: resultBody as Output, usage, billingStatus, cleanup };
}
