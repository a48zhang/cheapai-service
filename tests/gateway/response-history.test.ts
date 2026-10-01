import { beforeEach, describe, expect, it } from 'vitest';
import { bindResponseHistory, matchesResponseHistoryBinding, responseIdForRequest, rewriteResponseHistoryRequest } from '../../apps/worker/gateway/response-history';
import { createResponseIds } from '../../packages/apicompat/ids';
import { commitRequestRegistration, finishRequest, prepareRequestRegistration } from '../../apps/worker/gateway/request-repository';
import { createPriceSnapshot } from '../../apps/worker/billing/fingerprint';
import { authenticatePlatformKey } from '../../apps/worker/auth/api-key-auth';
import { generateToken, hashToken } from '../../apps/worker/auth/tokens';
import type { InternalPlatformKeyAuth } from '../../apps/worker/auth/key-repository';
import type { RouteCandidate } from '../../apps/worker/cache/routes';
import type { ProtocolRequest } from '../../packages/apicompat/capabilities/check';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

let owner: InternalPlatformKeyAuth;
let other: InternalPlatformKeyAuth;
let sameUserOtherKey: InternalPlatformKeyAuth;
const now = 1000;
const responseId = 'resp_shared_synthetic';
const continuation = (id = responseId): ProtocolRequest => ({ protocol: 'responses', request: { model: 'g13-model', previous_response_id: id, input: 'next' } });
const candidate = (): RouteCandidate => ({ channel: { id: 'g13-channel', baseUrl: 'https://example.com', priority: 1, concurrencyLimit: 2, rpmLimit: 60, configVersion: 1 },
  mapping: { channelId: 'g13-channel', publicModelId: 'g13-model', protocol: 'responses', upstreamModel: 'native-model', configVersion: 1,
    capabilities: { protocol: 'responses', features: ['response_history'] } } });
async function save(subject: InternalPlatformKeyAuth, id = responseId) {
  const registration = prepareRequestRegistration(testEnv.DB, { userId: subject.user.id, keyId: subject.key.id, groupId: 'g13-group', channelId: 'g13-channel',
    downstreamProtocol: 'responses', now, versions: { user: 1, key: 1, group: 1, channel: 1, mapping: 1 },
    priceSnapshotJson: createPriceSnapshot({ publicModelId: 'g13-model', upstreamModel: 'native-model', upstreamProtocol: 'responses', priceVersion: 1, sellPrices: { input: '1', output: '2' } }).json });
  const row = await commitRequestRegistration(testEnv.DB, registration);
  await finishRequest(testEnv.DB, row.id, subject.user.id, { status: 'succeeded', responseId: id }, now + 1);
  return row;
}

beforeEach(async () => {
  await prepare(testEnv.DB, "INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('g13-group','G13 Group','active',1,0,0)").run();
  for (const user of ['g13-owner', 'g13-other']) await prepare(testEnv.DB, `INSERT INTO users
    (id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES(?,?,'test-only-hash','user','active','g13-group',100,2,60,'admin',0,0)`, [user, `${user}@example.invalid`]).run();
  const subjects: InternalPlatformKeyAuth[] = [];
  for (const [key, user] of [['g13-key', 'g13-owner'], ['g13-other-key', 'g13-other'], ['g13-second-key', 'g13-owner']]) {
    const token = generateToken('apiKey');
    await prepare(testEnv.DB, `INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at)
      VALUES(?,?,?,'s2a_key_ABCDEFGH','G13 Key','active',0,0)`, [key!, user!, await hashToken('apiKey', token)]).run();
    subjects.push(await authenticatePlatformKey(testEnv.DB, new Request('https://example.com/v1/responses', { headers: { Authorization: `Bearer ${token}` } }), now));
  }
  [owner, other, sameUserOtherKey] = subjects as [InternalPlatformKeyAuth, InternalPlatformKeyAuth, InternalPlatformKeyAuth];
  const envelope = JSON.stringify({ algorithm: 'A256GCM', format_version: 1, key_version: 'test', nonce: 'synthetic', ciphertext: 'synthetic-only' });
  await prepare(testEnv.DB, `INSERT INTO channels(id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES('g13-channel','G13 Channel','https://example.com',?,'test','active',1,2,60,1,0,0)`, [envelope]).run();
  await prepare(testEnv.DB, `INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('g13-model','active',?,1,0,4096,0,0)`, [JSON.stringify({ input: '1', output: '2' })]).run();
  await prepare(testEnv.DB, "INSERT INTO channel_groups(channel_id,group_id) VALUES('g13-channel','g13-group')").run();
  await prepare(testEnv.DB, `INSERT INTO channel_models(channel_id,public_model_id,protocol,upstream_model,capabilities_json,config_version)
    VALUES('g13-channel','g13-model','responses','native-model',?,1)`, [JSON.stringify({ protocol: 'responses', features: ['response_history'] })]).run();
});

describe('native Responses history ownership on D1', () => {
  it('binds B11 recorded response ID to its original identity and current matching mapping', async () => {
    const original = await save(owner);
    const binding = await bindResponseHistory(testEnv.DB, owner, continuation());
    expect(binding).toEqual({ userId: owner.user.id, keyId: owner.key.id, clientResponseId: responseId, upstreamResponseId: responseId, sourceRequestId: original.id,
      publicModelId: 'g13-model', channelId: 'g13-channel', upstreamModel: 'native-model', upstreamProtocol: 'responses', mappingVersion: 1,
      requiresAuthoritativeAdmission: true });
    expect(matchesResponseHistoryBinding(binding!, candidate())).toBe(true);
    expect(JSON.stringify(binding)).not.toMatch(/password|hash|prompt|next/);
  });

  it('returns the same unknown-reference classification for missing, cross-user and cross-Key IDs', async () => {
    await save(owner);
    for (const [subject, request] of [[other, continuation()], [sameUserOtherKey, continuation()], [owner, continuation('missing')]] as const) {
      await expect(bindResponseHistory(testEnv.DB, subject, request)).rejects.toMatchObject({ code: 'invalid_request', reason: 'unknown_reference' });
    }
  });

  it('resolves the platform ID actually emitted by P05 and restores the original provider ID', async () => {
    const original = await save(owner);
    const ids = createResponseIds({ seed: original.id });
    if (!ids.ok) throw new Error('Expected valid B11 UUID seed');
    expect(responseIdForRequest(original.id)).toBe(ids.value.identity.responseId);
    const clientRequest = continuation(ids.value.identity.responseId);
    const binding = (await bindResponseHistory(testEnv.DB, owner, clientRequest))!;
    expect(binding.sourceRequestId).toBe(original.id);
    expect(binding.upstreamResponseId).toBe(responseId);
    expect(rewriteResponseHistoryRequest(clientRequest, binding).request.previous_response_id).toBe(responseId);
    expect(clientRequest.request.previous_response_id).toBe(ids.value.identity.responseId);
    await expect(bindResponseHistory(testEnv.DB, other, clientRequest)).rejects.toMatchObject({ reason: 'unknown_reference' });
    await expect(bindResponseHistory(testEnv.DB, sameUserOtherKey, clientRequest)).rejects.toMatchObject({ reason: 'unknown_reference' });
  });

  it('does not fall back from an unknown platform UUID to a colliding raw provider ID', async () => {
    const unknownPlatformId = responseIdForRequest(crypto.randomUUID());
    await save(owner, unknownPlatformId);
    await expect(bindResponseHistory(testEnv.DB, owner, continuation(unknownPlatformId))).rejects.toMatchObject({ reason: 'unknown_reference' });
  });

  it('allows providers to reuse the same native ID across owners without crossing ownership', async () => {
    const first = await save(owner); const second = await save(other);
    expect((await bindResponseHistory(testEnv.DB, owner, continuation()))?.sourceRequestId).toBe(first.id);
    expect((await bindResponseHistory(testEnv.DB, other, continuation()))?.sourceRequestId).toBe(second.id);
  });

  it('rejects ambiguous duplicates inside the same user and Key scope', async () => {
    await save(owner); await save(owner);
    await expect(bindResponseHistory(testEnv.DB, owner, continuation())).rejects.toMatchObject({ reason: 'ambiguous_reference' });
  });

  it('rejects a changed upstream mapping and mismatched public model', async () => {
    await save(owner);
    await expect(bindResponseHistory(testEnv.DB, owner, { protocol: 'responses', request: { model: 'different-model', previous_response_id: responseId } }))
      .rejects.toMatchObject({ reason: 'incompatible_reference' });
    await prepare(testEnv.DB, "UPDATE channel_models SET upstream_model='different-upstream' WHERE channel_id='g13-channel'").run();
    await expect(bindResponseHistory(testEnv.DB, owner, continuation())).rejects.toMatchObject({ reason: 'incompatible_reference' });
  });

  it('does not treat an item-reference ID as a response ID even when the string exists', async () => {
    await save(owner);
    await expect(bindResponseHistory(testEnv.DB, owner, { protocol: 'responses', request: { model: 'g13-model', input: [{ type: 'item_reference', id: responseId }] } }))
      .rejects.toMatchObject({ reason: 'item_reference_unavailable' });
  });

  it('rejects cross-protocol references and requires native original Responses', async () => {
    await expect(bindResponseHistory(testEnv.DB, owner, { protocol: 'chat', request: { model: 'g13-model', messages: [], previous_response_id: responseId } } as ProtocolRequest))
      .rejects.toMatchObject({ reason: 'cross_protocol_reference' });
    const original = await save(owner);
    await prepare(testEnv.DB, "UPDATE requests SET downstream_protocol='chat' WHERE id=?", [original.id]).run();
    await expect(bindResponseHistory(testEnv.DB, owner, continuation())).rejects.toMatchObject({ reason: 'incompatible_reference' });
  });

  it('constrains channel, protocol, upstream name and mapping version without authorizing disabled channels', async () => {
    await save(owner);
    await prepare(testEnv.DB, "UPDATE channels SET status='disabled' WHERE id='g13-channel'").run();
    const binding = (await bindResponseHistory(testEnv.DB, owner, continuation()))!;
    expect(binding.requiresAuthoritativeAdmission).toBe(true);
    const different = candidate(); different.channel.id = 'other';
    expect(matchesResponseHistoryBinding(binding, different)).toBe(false);
    const changed = candidate(); changed.mapping.configVersion = 2;
    expect(matchesResponseHistoryBinding(binding, changed)).toBe(false);
    const wrongModel = candidate(); wrongModel.mapping.upstreamModel = 'other';
    expect(matchesResponseHistoryBinding(binding, wrongModel)).toBe(false);
  });

  it('returns null when no server-side reference is requested and maps D1 failures safely', async () => {
    expect(await bindResponseHistory(testEnv.DB, owner, { protocol: 'responses', request: { model: 'g13-model', input: 'ordinary complete history' } })).toBeNull();
    const database = { prepare: () => { throw new Error('private D1 details'); } } as unknown as D1Database;
    await expect(bindResponseHistory(database, owner, continuation())).rejects.toMatchObject({ code: 'service_unavailable' });
  });
});
