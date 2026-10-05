import { checkRequestCapabilities, identifyRequestFeatures } from '@sub2api/apicompat/capabilities/check';
import type { ProtocolRequest, RequestFeatures, RequiredCapabilityCheck } from '@sub2api/apicompat/capabilities/check';
import type { Protocol } from '@sub2api/apicompat/types/shared';
import type { InternalPlatformKeyAuth } from '../auth/key-repository';
import type { RouteCandidate, RouteData } from '../cache/routes';
import type { Snapshot } from '../cache/snapshot';
import { DEFAULT_CONFIG } from '../config';

export interface EligibleCandidate {
  candidate: RouteCandidate;
  requiredChecks: readonly RequiredCapabilityCheck[];
  outputTokenLimit?: number;
}
export interface SelectionOptions {
  now: number;
  features?: RequestFeatures;
  maxSnapshotAgeMs?: number;
  random?: () => number;
  /** P22 supplies implementation availability for this full request/response mode. */
  adapterAvailable?: (direction: { from: Protocol; to: Protocol; streaming: boolean }) => boolean;
}
export type NoCandidateReason = 'unauthorized' | 'model_not_allowed' | 'scope_mismatch' | 'refresh_required'
  | 'invalid_request' | 'no_mapping' | 'capability_mismatch' | 'adapter_unavailable';
export type ChannelSelection =
  | { kind: 'no_candidates'; reason: NoCandidateReason }
  | { kind: 'adapter_availability_required'; capabilityCandidates: EligibleCandidate[]; requiresAuthoritativeRecheck: true }
  | { kind: 'candidates'; candidates: EligibleCandidate[]; requiresAuthoritativeRecheck: true };

const none = (reason: NoCandidateReason): ChannelSelection => ({ kind: 'no_candidates', reason });
const defaultRandom = (): number => crypto.getRandomValues(new Uint32Array(1))[0]! / 0x1_0000_0000;

/** Higher numeric priority first; Fisher-Yates only within each priority layer.
 * Copies the list, never mutating cached candidates or maintaining a counter.
 */
function order(candidates: EligibleCandidate[], random: () => number): EligibleCandidate[] {
  const layers = new Map<number, EligibleCandidate[]>();
  for (const item of candidates) {
    const priority = item.candidate.channel.priority;
    const layer = layers.get(priority) ?? [];
    layer.push(item); layers.set(priority, layer);
  }
  const result: EligibleCandidate[] = [];
  for (const priority of [...layers.keys()].sort((a, b) => b - a)) {
    const layer = layers.get(priority)!;
    for (let i = layer.length - 1; i > 0; i--) {
      const sample = random();
      if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new TypeError('RNG must return a number in [0, 1).');
      const j = Math.floor(sample * (i + 1));
      [layer[i], layer[j]] = [layer[j]!, layer[i]!];
    }
    result.push(...layer);
  }
  return result;
}

/** Pure prerequisite filtering. auth must be the authoritative A27 result and
 * routes a C13 snapshot. No network, balance authorization, leases, cooldown,
 * reference ownership checks or final D1 registration are performed here.
 */
export function selectChannelCandidates(
  routes: Snapshot<RouteData> | null,
  auth: InternalPlatformKeyAuth,
  request: ProtocolRequest,
  options: SelectionOptions,
): ChannelSelection {
  const now = options.now;
  const maxAgeMs = options.maxSnapshotAgeMs ?? DEFAULT_CONFIG.routingCacheTtlMs;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) return none('invalid_request');
  if (!auth || auth.key.status !== 'active' || auth.user.status !== 'active' || auth.group.status !== 'active' ||
      auth.key.userId !== auth.user.id || auth.key.createdAt > now || (auth.key.expiresAt !== null && auth.key.expiresAt <= now)) return none('unauthorized');
  const features = options.features ? { ok: true as const, value: options.features } : identifyRequestFeatures(request);
  if (!features.ok) return none('invalid_request');
  const modelId = request.request.model;
  if (auth.key.allowedModels !== null && !auth.key.allowedModels.includes(modelId)) return none('model_not_allowed');
  if (!routes) return none('no_mapping');
  if (routes.data.group.id !== auth.group.id || routes.data.model.publicModelId !== modelId) return none('scope_mismatch');
  if (routes.schema_version !== 1 || !Number.isSafeInteger(routes.observed_at) || routes.observed_at < 0 ||
      now < routes.observed_at || now - routes.observed_at >= maxAgeMs || routes.data.group.version !== auth.group.version) return none('refresh_required');
  const capable: EligibleCandidate[] = [];
  const seen = new Set<string>();
  let hasMapping = false;
  for (const candidate of routes.data.candidates) {
    const { channel, mapping } = candidate;
    if (mapping.channelId !== channel.id || mapping.publicModelId !== modelId || mapping.protocol !== mapping.capabilities.protocol ||
        !['chat', 'responses', 'messages'].includes(mapping.protocol) || !Number.isSafeInteger(channel.priority) || channel.priority < 0 ||
        !Number.isSafeInteger(channel.configVersion) || channel.configVersion < 1 || !Number.isSafeInteger(mapping.configVersion) || mapping.configVersion < 1) continue;
    const identity = JSON.stringify([channel.id, mapping.protocol]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    hasMapping = true;
    const checked = checkRequestCapabilities(request, mapping.capabilities, features.value);
    if (!checked.supported) continue;
    capable.push({ candidate, requiredChecks: [...checked.requiredChecks],
      ...(checked.outputTokenLimit === undefined ? {} : { outputTokenLimit: checked.outputTokenLimit }) });
  }
  if (capable.length === 0) return none(hasMapping ? 'capability_mismatch' : 'no_mapping');
  // Capability declarations do not prove that ANY direct converter is shipped,
  // even same-protocol processing. The absent registry is an explicit pending step.
  if (!options.adapterAvailable) return { kind: 'adapter_availability_required', capabilityCandidates: capable, requiresAuthoritativeRecheck: true };
  const available = capable.filter(item => options.adapterAvailable!({ from: request.protocol, to: item.candidate.mapping.protocol,
    streaming: request.request.stream === true }) === true);
  if (available.length === 0) return none('adapter_unavailable');
  return { kind: 'candidates', candidates: order(available, options.random ?? defaultRandom), requiresAuthoritativeRecheck: true };
}
