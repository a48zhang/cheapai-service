import { describe, expect, it } from 'vitest';
import { selectChannelCandidates } from '../../apps/worker/gateway/select-channel';
import type { InternalPlatformKeyAuth } from '../../apps/worker/auth/key-repository';
import type { RouteCandidate, RouteData } from '../../apps/worker/cache/routes';
import type { Snapshot } from '../../apps/worker/cache/snapshot';
import type { ProtocolRequest } from '../../packages/apicompat/capabilities/check';

const now = 1000;
const auth = (): InternalPlatformKeyAuth => ({
  key: { id: 'key', userId: 'user', name: 'test', displayPrefix: 'test-prefix', status: 'active', allowedModels: null,
    expiresAt: null, createdAt: 0, updatedAt: 0, version: 1 },
  user: { id: 'user', status: 'active', role: 'user', version: 1, balanceUnits: '100', concurrencyLimit: 2, rpmLimit: 60 },
  group: { id: 'group', status: 'active', version: 3 },
});
const request: ProtocolRequest = { protocol: 'chat', request: { model: 'model', messages: [{ role: 'user', content: 'hello' }], max_tokens: 20 } };
function candidate(id: string, priority = 1, protocol: 'chat' | 'messages' = 'chat'): RouteCandidate {
  return { channel: { id, baseUrl: 'https://example.com', priority, concurrencyLimit: 2, rpmLimit: 60, configVersion: 2 },
    mapping: { channelId: id, publicModelId: 'model', protocol, upstreamModel: 'provider-model', configVersion: 4,
      capabilities: { protocol, features: [], maxOutputTokens: 100 } } };
}
const snapshot = (candidates = [candidate('channel')]): Snapshot<RouteData> => ({ schema_version: 1, observed_at: 0,
  data: { group: { id: 'group', version: 3 }, model: { publicModelId: 'model', priceVersion: 7 }, candidates } });
const options = { now, adapterAvailable: () => true, random: () => 0 };

describe('pure channel prerequisites and priority selection', () => {
  it('preserves null model inheritance while an empty Key allowlist denies every model', () => {
    expect(selectChannelCandidates(snapshot(), auth(), request, options).kind).toBe('candidates');
    expect(selectChannelCandidates(snapshot(), { ...auth(), key: { ...auth().key, allowedModels: [] } }, request, options))
      .toEqual({ kind: 'no_candidates', reason: 'model_not_allowed' });
    expect(selectChannelCandidates(snapshot(), { ...auth(), key: { ...auth().key, allowedModels: ['other'] } }, request, options).kind).toBe('no_candidates');
    expect(selectChannelCandidates(snapshot(), { ...auth(), key: { ...auth().key, allowedModels: ['model'] } }, request, options).kind).toBe('candidates');
  });

  it('rejects inactive, revoked, expired and owner-mismatched trusted projections', () => {
    for (const identity of [
      { ...auth(), key: { ...auth().key, status: 'revoked' as const } },
      { ...auth(), key: { ...auth().key, expiresAt: now } },
      { ...auth(), key: { ...auth().key, userId: 'other' } },
      { ...auth(), user: { ...auth().user, status: 'disabled' } },
      { ...auth(), group: { ...auth().group, status: 'disabled' } },
    ]) expect(selectChannelCandidates(snapshot(), identity as InternalPlatformKeyAuth, request, options)).toEqual({ kind: 'no_candidates', reason: 'unauthorized' });
  });

  it('rejects group/model scope mismatches and requires refreshed group versions', () => {
    const routes = snapshot();
    routes.data.group.id = 'other';
    expect(selectChannelCandidates(routes, auth(), request, options)).toEqual({ kind: 'no_candidates', reason: 'scope_mismatch' });
    routes.data.group.id = 'group'; routes.data.group.version = 2;
    expect(selectChannelCandidates(routes, auth(), request, options)).toEqual({ kind: 'no_candidates', reason: 'refresh_required' });
    routes.data.group.version = 3; routes.data.model.publicModelId = 'other';
    expect(selectChannelCandidates(routes, auth(), request, options).kind).toBe('no_candidates');
  });

  it('rejects expired route snapshots and reports no mapping for missing configuration', () => {
    expect(selectChannelCandidates(snapshot(), auth(), request, { ...options, now: 60_000 })).toEqual({ kind: 'no_candidates', reason: 'refresh_required' });
    expect(selectChannelCandidates(null, auth(), request, options)).toEqual({ kind: 'no_candidates', reason: 'no_mapping' });
  });

  it('does not equate upstream capability declarations with implemented adapters', () => {
    const pending = selectChannelCandidates(snapshot([candidate('cross', 1, 'messages')]), auth(), request, { now });
    expect(pending.kind).toBe('adapter_availability_required');
    expect(pending).not.toHaveProperty('candidates');
    expect(selectChannelCandidates(snapshot(), auth(), request, { ...options, adapterAvailable: () => false }))
      .toEqual({ kind: 'no_candidates', reason: 'adapter_unavailable' });
  });

  it('passes exact direction/stream mode to the explicit adapter registry predicate', () => {
    const directions: unknown[] = [];
    const routes = snapshot([candidate('native'), candidate('cross', 1, 'messages')]);
    const result = selectChannelCandidates(routes, auth(), request, { ...options, adapterAvailable: direction => {
      directions.push(direction); return direction.to === 'chat';
    } });
    expect(directions).toEqual([{ from: 'chat', to: 'chat', streaming: false }, { from: 'chat', to: 'messages', streaming: false }]);
    if (result.kind !== 'candidates') throw new Error('Expected candidates');
    expect(result.candidates.map(item => item.candidate.channel.id)).toEqual(['native']);
    expect(result.requiresAuthoritativeRecheck).toBe(true);
  });

  it('uses request feature checks and keeps explicit output bounds', () => {
    const streamed: ProtocolRequest = { protocol: 'chat', request: { ...request.request, stream: true } as never };
    expect(selectChannelCandidates(snapshot(), auth(), streamed, options)).toEqual({ kind: 'no_candidates', reason: 'capability_mismatch' });
    const supported = candidate('stream'); supported.mapping.capabilities = { protocol: 'chat', features: ['streaming'], maxOutputTokens: 100 };
    const result = selectChannelCandidates(snapshot([supported]), auth(), streamed, options);
    if (result.kind !== 'candidates') throw new Error('Expected candidates');
    expect(result.candidates[0]?.outputTokenLimit).toBe(20);
  });

  it('filters mismatched mapping identity and deduplicates the same channel/protocol', () => {
    const mismatched = candidate('bad'); mismatched.mapping.channelId = 'different';
    const shared = candidate('one');
    const result = selectChannelCandidates(snapshot([mismatched, shared, shared]), auth(), request, options);
    if (result.kind !== 'candidates') throw new Error('Expected candidates');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.candidate.channel.id).toBe('one');
  });

  it('orders higher priorities first and shuffles within a layer without mutating input', () => {
    const routes = snapshot([candidate('low', 1), candidate('high-a', 5), candidate('high-b', 5), candidate('middle', 3)]);
    const before = JSON.stringify(routes);
    const result = selectChannelCandidates(routes, auth(), request, options);
    if (result.kind !== 'candidates') throw new Error('Expected candidates');
    expect(result.candidates.map(item => item.candidate.channel.id)).toEqual(['high-b', 'high-a', 'middle', 'low']);
    expect(JSON.stringify(routes)).toBe(before);
    expect(selectChannelCandidates(routes, auth(), request, options)).toEqual(result);
  });

  it.each([-1, 1, NaN, Infinity])('rejects invalid injected RNG output %s', random => {
    expect(() => selectChannelCandidates(snapshot([candidate('one'), candidate('two')]), auth(), request, { ...options, random: () => random })).toThrow(TypeError);
  });

  it('reports invalid wire requests without running adapter selection', () => {
    expect(selectChannelCandidates(snapshot(), auth(), { protocol: 'chat', request: { model: 'model', messages: [] } }, options))
      .toEqual({ kind: 'no_candidates', reason: 'invalid_request' });
  });
});
