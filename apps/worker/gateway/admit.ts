import type { ProtocolRequest, RequiredCapabilityCheck } from '@sub2api/apicompat/capabilities/check';
import type { Protocol } from '@sub2api/apicompat/types/shared';
import type { InternalPlatformKeyAuth } from '../auth/key-repository';
import { checkBalanceAdmission } from '../billing/admission';
import type { BalanceAdmissionOptions } from '../billing/admission';
import { createPriceSnapshot } from '../billing/fingerprint';
import { getModelById } from '../catalog/models';
import { readPrices } from '../cache/prices';
import { readRoutes } from '../cache/routes';
import { DEFAULT_CONFIG, UNLIMITED_RPM } from '../config';
import { ApiError } from '../http';
import { acquireDualLease } from '../limits/dual-lease';
import type { DualLeaseCleanupReport, DualLeasePermit } from '../limits/dual-lease';
import type { LeaseBinding } from '../limits/client';
import { selectChannelCandidates } from './select-channel';
import type { EligibleCandidate, SelectionOptions } from './select-channel';
import { commitRequestRegistration, prepareRequestRegistration } from './request-repository';
import type { RequestRecord } from './request-repository';
import { bindResponseHistory, matchesResponseHistoryBinding, rewriteResponseHistoryRequest } from './response-history';
import type { ResponseHistoryBinding } from './response-history';
import type { RequestSource } from './request-repository';

export interface AdmissionBindings { DB: D1Database; CACHE: KVNamespace; GATE: LeaseBinding }
export interface CandidateExclusion { channelId: string; protocol?: Protocol }
export interface AdmissionOptions {
  now?: () => number;
  random?: () => number;
  adapterAvailable?: SelectionOptions['adapterAvailable'];
  signal?: AbortSignal;
  leaseTtlMs?: number;
  /** Internal dispatch identity shared only by candidates of this logical call. */
  userRateOperationId?: string;
  /** Omit protocol to exclude the whole channel. Used by the later retry owner. */
  excludeCandidates?: readonly CandidateExclusion[];
  /** Trusted gateway accounting policy; never a client opt-out. */
  requireChatStreamUsage?: boolean;
  /** Trusted server entry point. HTTP dispatch always supplies `api`; chat
   * service dispatch supplies `web_chat` after session authentication. */
  source?: RequestSource;
  /** Trusted reference-binding service, never a client assertion. */
  validateRequiredChecks?: (checks: readonly RequiredCapabilityCheck[], subject: InternalPlatformKeyAuth, request: ProtocolRequest) => Promise<boolean>;
}
export interface AdmittedRequest {
  request: RequestRecord;
  selected: EligibleCandidate;
  outputTokenLimit: number | undefined;
  lease: DualLeasePermit;
  /** Feed this to the adapter: native history IDs have been restored, not copied from client claims. */
  requestForAdapter: ProtocolRequest;
  historyBinding: ResponseHistoryBinding | null;
}
/** Cleanup uncertainty stays inspectable for the internal lifecycle owner. */
export class GatewayAdmissionError extends ApiError {
  constructor(code: 'rate_limited' | 'service_unavailable' | 'conflict',
    readonly cleanup: DualLeaseCleanupReport,
    readonly retryCleanup: () => Promise<DualLeaseCleanupReport>,
    readonly candidate?: CandidateExclusion,
    readonly registeredRequestId: string | null = null,
    readonly candidateFailure?: 'busy' | 'cooldown') {
    super(code);
    this.name = 'GatewayAdmissionError';
  }
}

function requestSource(subject: InternalPlatformKeyAuth, requested: AdmissionOptions['source']): RequestSource {
  const kind = (subject.key as unknown as { kind?: unknown }).kind;
  const boundGroup = (subject.key as unknown as { groupId?: unknown }).groupId;
  const source = requested ?? (kind === 'web_chat' || boundGroup === null ? 'web_chat' : 'api');
  if (source !== 'api' && source !== 'web_chat') throw new ApiError('invalid_request');
  if (kind !== undefined && kind !== 'api' && kind !== 'web_chat') throw new ApiError('unauthorized');
  if (kind !== undefined && kind !== source) throw new ApiError('unauthorized');
  if (source === 'api' && boundGroup === null) throw new ApiError('unauthorized');
  if (source === 'web_chat' && boundGroup !== null) throw new ApiError('unauthorized');
  return source;
}

function admissionPriceSnapshot(modelId: string, upstreamModel: string, protocol: Protocol, priceVersion: number,
  sellPrices: Parameters<typeof createPriceSnapshot>[0]['sellPrices'], groupId: string, groupVersion: number, billingMultiplier: string) {
  const base = { publicModelId: modelId, upstreamModel, upstreamProtocol: protocol, priceVersion, sellPrices };
  return createPriceSnapshot({ ...base, groupId, groupVersion, billingMultiplier } as Parameters<typeof createPriceSnapshot>[0]);
}

/** Acquires the selected candidate's leases, then conditionally registers in D1.
 * Returns no upstream credential and performs no fetch. The forwarding lifecycle
 * must retain/renew/release the returned leases and respect the output bound.
 */
export async function admitRequest(bindings: AdmissionBindings, subject: InternalPlatformKeyAuth, request: ProtocolRequest,
  options: AdmissionOptions = {}): Promise<AdmittedRequest> {
  const clock = (): number => {
    const time = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(time) || time < 0) throw new ApiError('service_unavailable');
    return time;
  };
  const ttlMs = options.leaseTtlMs ?? DEFAULT_CONFIG.gateLeaseTtlMs;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new ApiError('invalid_request');
  if (options.userRateOperationId !== undefined && (typeof options.userRateOperationId !== 'string'
    || options.userRateOperationId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(options.userRateOperationId))) throw new ApiError('invalid_request');
  const excluded = options.excludeCandidates ?? [];
  if (!Array.isArray(excluded) || excluded.length > 1000 || excluded.some(item => !item || typeof item.channelId !== 'string' ||
      !item.channelId.trim() || item.channelId.length > 128 ||
      (item.protocol !== undefined && !['chat', 'responses', 'messages'].includes(item.protocol)))) throw new ApiError('invalid_request');
  if (options.signal?.aborted) throw new ApiError('conflict');
  if (options.requireChatStreamUsage !== undefined && typeof options.requireChatStreamUsage !== 'boolean') throw new ApiError('invalid_request');
  const source = requestSource(subject, options.source);
  const modelId = request.request.model;
  const eligibility = await checkBalanceAdmission(bindings.DB, subject, modelId, clock(), { source } satisfies BalanceAdmissionOptions);
  // A27's limits and identity must still match the authoritative B05 versions.
  // Do not silently re-authorize stale metadata or acquire leases with old limits.
  if (eligibility.userVersion !== subject.user.version || eligibility.keyVersion !== subject.key.version ||
      eligibility.groupVersion !== subject.group.version) throw new ApiError('conflict');
  const historyBinding = await bindResponseHistory(bindings.DB, subject, request);
  let routes = await readRoutes(bindings.DB, bindings.CACHE, eligibility.groupId, modelId, { now: clock });
  const prices = await readPrices(bindings.DB, bindings.CACHE, modelId, { now: clock, expectedPriceVersion: eligibility.priceVersion });
  if (!routes || !prices) throw new ApiError('forbidden');
  if (routes.snapshot.data.group.version !== eligibility.groupVersion || routes.snapshot.data.model.priceVersion !== eligibility.priceVersion ||
      (historyBinding !== null && !routes.snapshot.data.candidates.some(candidate => matchesResponseHistoryBinding(historyBinding, candidate)))) {
    // One bounded cache refresh, not a retry loop on changing configuration.
    routes = await readRoutes(bindings.DB, bindings.CACHE, eligibility.groupId, modelId, { now: clock, forceRefresh: true });
  }
  if (!routes || routes.snapshot.data.group.version !== eligibility.groupVersion ||
      routes.snapshot.data.model.priceVersion !== eligibility.priceVersion || prices.snapshot.data.price_version !== eligibility.priceVersion) throw new ApiError('conflict');
  // Intersect constraints before capability/adapter ordering. Never switch away
  // from the original native history channel just because another has capacity.
  const constrained = { ...routes.snapshot, data: { ...routes.snapshot.data, candidates: routes.snapshot.data.candidates.filter(candidate =>
    (historyBinding === null || matchesResponseHistoryBinding(historyBinding, candidate)) &&
    (!options.requireChatStreamUsage || request.request.stream !== true || candidate.mapping.protocol !== 'chat' || candidate.mapping.capabilities.features.includes('stream_usage')) &&
    !excluded.some(item => item.channelId === candidate.channel.id && (item.protocol === undefined || item.protocol === candidate.mapping.protocol))) } };
  const selection = selectChannelCandidates(constrained, subject, request, {
    now: clock(), ...(options.random === undefined ? {} : { random: options.random }),
    ...(options.adapterAvailable === undefined ? {} : { adapterAvailable: options.adapterAvailable }),
  });
  if (selection.kind === 'adapter_availability_required') throw new ApiError('service_unavailable');
  if (selection.kind === 'no_candidates') {
    const code = selection.reason === 'unauthorized' ? 'unauthorized'
      : selection.reason === 'model_not_allowed' || selection.reason === 'scope_mismatch' ? 'forbidden'
      : selection.reason === 'refresh_required' ? 'conflict'
      : selection.reason === 'adapter_unavailable' ? 'service_unavailable' : 'invalid_request';
    throw new ApiError(code);
  }
  let model: Awaited<ReturnType<typeof getModelById>>;
  try { model = await getModelById(bindings.DB, modelId); } catch { throw new ApiError('service_unavailable'); }
  if (!model || model.status !== 'active' || model.priceVersion !== eligibility.priceVersion) throw new ApiError('conflict');
  const selected = selection.candidates.find(item => item.outputTokenLimit === undefined || item.outputTokenLimit <= model!.maxOutputTokens);
  if (!selected) throw new ApiError('invalid_request');
  const remainingChecks = selected.requiredChecks.filter(check => check !== 'response_history_binding' || historyBinding === null);
  if (remainingChecks.length && (!options.validateRequiredChecks ||
      !await options.validateRequiredChecks(remainingChecks, subject, request))) throw new ApiError('forbidden');
  const outputTokenLimit = selected.outputTokenLimit;
  const price = admissionPriceSnapshot(modelId, selected.candidate.mapping.upstreamModel, selected.candidate.mapping.protocol,
    prices.snapshot.data.price_version, prices.snapshot.data.sell_prices, eligibility.groupId, eligibility.groupVersion, eligibility.billingMultiplier);
  const registration = prepareRequestRegistration(bindings.DB, {
    userId: subject.user.id, keyId: subject.key.id, groupId: subject.group.id, channelId: selected.candidate.channel.id,
    downstreamProtocol: request.protocol, source, priceSnapshotJson: price.json, now: clock(),
    versions: { user: eligibility.userVersion, key: eligibility.keyVersion, group: eligibility.groupVersion,
      channel: selected.candidate.channel.configVersion, mapping: selected.candidate.mapping.configVersion },
  });
  let acquired: Awaited<ReturnType<typeof acquireDualLease>>;
  try {
    acquired = await acquireDualLease(bindings.GATE, { userId: subject.user.id, channelId: selected.candidate.channel.id,
      requestId: registration.requestId,
      user: { limit: subject.user.concurrencyLimit, ttlMs, ...(subject.user.rpmLimit === UNLIMITED_RPM ? {} : { rate: { limit: subject.user.rpmLimit, windowMs: 60_000, operationId: options.userRateOperationId ?? registration.requestId } }) },
      channel: { limit: selected.candidate.channel.concurrencyLimit, ttlMs, ...(selected.candidate.channel.rpmLimit === UNLIMITED_RPM ? {} : { rate: { limit: selected.candidate.channel.rpmLimit, windowMs: 60_000 } }) },
    }, options.signal === undefined ? {} : { signal: options.signal });
  } catch { throw new ApiError('service_unavailable'); }
  if (!acquired.granted) {
    const code = !acquired.cleanup.complete ? 'service_unavailable' : acquired.reason === 'denied' ? 'rate_limited'
      : acquired.reason === 'cancelled' ? 'conflict' : 'service_unavailable';
    throw new GatewayAdmissionError(code, acquired.cleanup, acquired.retryCleanup,
      { channelId: selected.candidate.channel.id, protocol: selected.candidate.mapping.protocol }, null,
      acquired.stage === 'channel' && acquired.reason === 'denied' ? acquired.denial?.reason === 'cooldown' ? 'cooldown' : 'busy' : undefined);
  }
  try {
    if (options.signal?.aborted || Math.min(acquired.lease.user.handle.expiresAt, acquired.lease.channel.handle.expiresAt) <= clock()) throw new ApiError('conflict');
    const saved = await commitRequestRegistration(bindings.DB, registration.refreshTime(clock()));
    if (options.signal?.aborted || Math.min(acquired.lease.user.handle.expiresAt, acquired.lease.channel.handle.expiresAt) <= clock()) throw new ApiError('conflict');
    return { request: saved, selected, outputTokenLimit, lease: acquired.lease, historyBinding,
      requestForAdapter: historyBinding === null ? request : rewriteResponseHistoryRequest(request, historyBinding) };
  } catch (error) {
    const cleanup = await acquired.lease.release();
    const code = cleanup.complete && error instanceof ApiError && error.code === 'conflict' ? 'conflict' : 'service_unavailable';
    // Even an uncertain INSERT acknowledgement never yields a sendable result.
    throw new GatewayAdmissionError(code, cleanup, acquired.lease.release,
      { channelId: selected.candidate.channel.id, protocol: selected.candidate.mapping.protocol }, registration.requestId);
  }
}
