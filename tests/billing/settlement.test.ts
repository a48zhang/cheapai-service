import { beforeEach, describe, expect, it } from 'vitest';
import { settleRequest } from '../../apps/worker/billing/settlement';
import { findConsumptionSettlement } from '../../apps/worker/billing/settlement-repository';
import { createPriceSnapshot } from '../../apps/worker/billing/fingerprint';
import { prepareRequestRegistration, commitRequestRegistration } from '../../apps/worker/gateway/request-repository';
import type { RequestRecord } from '../../apps/worker/gateway/request-repository';
import { createPlatformKey } from '../../apps/worker/auth/key-repository';
import { encryptChannelSecret } from '../../apps/worker/admin/channel-secrets';
import type { UsageSnapshot } from '../../packages/apicompat/types/shared';
import { testEnv } from '../helpers/database';

let registered: RequestRecord;
const usage = (): UsageSnapshot => ({ quality: 'complete', protocol: 'chat', counts: { inputTokens: 1000, outputTokens: 500 },
  semantics: { cacheRead: 'included_in_input', cacheWrite: 'included_in_input', reasoning: 'included_in_output', cacheWriteTtl: 'unknown' },
  sources: [{ protocol: 'chat', path: 'usage' }], issues: [] });
const options = { now: () => 3000, retryDelayMs: 0 };
function faults(settings: { failWrites?: number; failReads?: boolean; loseAck?: boolean; loseRecoveryRead?: boolean; hold?: Promise<void> }) {
  let writes = 0;
  let blockedReads = 0;
  const calls: string[] = [];
  const database = new Proxy(testEnv.DB, { get(target, property) {
    if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
      writes++; calls.push('write');
      if (writes <= (settings.failWrites ?? 0)) throw new Error('Synthetic precommit failure');
      if (settings.hold) await settings.hold;
      const result = await target.batch(statements);
      if (settings.loseAck) { if (settings.loseRecoveryRead) blockedReads++; throw new Error('Synthetic lost acknowledgement'); }
      return result;
    };
    if (property === 'prepare') return (sql: string) => {
      if (sql.includes('FROM billing_entries')) {
        calls.push('ledger-read');
        if (settings.failReads || blockedReads > 0) { blockedReads = Math.max(0, blockedReads - 1); throw new Error('Synthetic read failure'); }
      }
      return target.prepare(sql);
    };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { database, calls, writes: () => writes };
}

beforeEach(async () => {
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('b13-group','Fixture','active',1,0,0)").run();
  await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES('b13-user','b13@example.invalid','synthetic','user','active','b13-group',100000,1,60,'admin',0,0)`).run();
  const key = await createPlatformKey(testEnv.DB, 'b13-user', { operationId: 'key-create', name: 'Fixture', allowedModels: null }, 1000);
  if (key.kind !== 'created') throw new Error('Expected synthetic key');
  const encrypted = await encryptChannelSecret('synthetic', 'b13-channel', 'v1', crypto.getRandomValues(new Uint8Array(32)));
  await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES('b13-channel','Fixture','https://example.invalid',?,'v1','active',0,1,60,1,0,0)`).bind(encrypted).run();
  await testEnv.DB.prepare("INSERT INTO channel_groups(channel_id,group_id) VALUES('b13-channel','b13-group')").run();
  await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('b13-model','active','{"input":"1","output":"2"}',1,0,4096,0,0)`).run();
  await testEnv.DB.prepare(`INSERT INTO channel_models(channel_id,public_model_id,upstream_model,protocol,capabilities_json,config_version)
    VALUES('b13-channel','b13-model','provider-model','chat','{}',1)`).run();
  const price = createPriceSnapshot({ publicModelId: 'b13-model', upstreamModel: 'provider-model', upstreamProtocol: 'chat', priceVersion: 1, sellPrices: { input: '1', output: '2' } });
  const admission = prepareRequestRegistration(testEnv.DB, { userId: 'b13-user', keyId: key.key.id, groupId: 'b13-group', channelId: 'b13-channel', downstreamProtocol: 'responses', priceSnapshotJson: price.json,
    versions: { user: 1, key: 1, group: 1, channel: 1, mapping: 1 }, now: 2000 });
  registered = await commitRequestRegistration(testEnv.DB, admission.refreshTime(2500));
});

describe('B13 bounded settlement with registered native D1 requests', () => {
  it('prices the admitted snapshot and replays the same operation without another request or charge', async () => {
    await testEnv.DB.prepare("UPDATE models SET sell_prices_json='{}',price_version=2 WHERE public_model_id='b13-model'").run();
    const first = await settleRequest(testEnv.DB, registered, usage(), options);
    expect(first).toMatchObject({ status: 'settled', attempts: 1, entry: { operationId: `consume:${registered.id}`, costUnits: '200000', priceSnapshotJson: registered.price_snapshot } });
    expect(await testEnv.DB.prepare("SELECT balance_units FROM users WHERE id='b13-user'").first('balance_units')).toBe(-100000);
    const replay = await settleRequest(testEnv.DB, registered, usage(), { ...options, now: () => 9000 });
    expect(replay).toMatchObject({ status: 'settled', attempts: 0 });
    if (first.status === 'settled' && replay.status === 'settled') expect(replay.entry).toEqual(first.entry);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM requests').first('n')).toBe(1);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(1);
  });

  it('performs at most three submissions, with a ledger read before each retry', async () => {
    const transport = faults({ failWrites: 2 });
    const result = await settleRequest(transport.database, registered, usage(), options);
    expect(result).toMatchObject({ status: 'settled', attempts: 3 });
    expect(transport.writes()).toBe(3);
    const indices = transport.calls.flatMap((call, index) => call === 'write' ? [index] : []);
    for (const index of indices) expect(transport.calls[index - 1]).toBe('ledger-read');
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(1);
  });

  it('returns stable complete recovery evidence after retry exhaustion without persisting B14 state', async () => {
    const transport = faults({ failWrites: 100 });
    const result = await settleRequest(transport.database, registered, usage(), options);
    expect(result).toMatchObject({ status: 'pending', attempts: 3, reason: 'attempts_exhausted', inFlight: null,
      evidence: { operationId: `consume:${registered.id}`, requestId: registered.id, userId: 'b13-user', costUnits: '200000', priceSnapshotJson: registered.price_snapshot } });
    expect(transport.writes()).toBe(3);
    if (result.status === 'pending') expect(JSON.parse(result.evidence.usageSnapshotJson)).toEqual(usage());
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(0);
    expect(await testEnv.DB.prepare('SELECT billing_status FROM requests').first('billing_status')).toBe('awaiting_usage');
  });

  it('does not submit when absence cannot be established by a read', async () => {
    const transport = faults({ failReads: true });
    expect(await settleRequest(transport.database, registered, usage(), options)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(transport.writes()).toBe(0);
  });

  it('confirms unknown committed writes, including the last allowed attempt, without a fourth insert', async () => {
    const transport = faults({ failWrites: 2, loseAck: true, loseRecoveryRead: true });
    expect(await settleRequest(transport.database, registered, usage(), options)).toMatchObject({ status: 'settled', attempts: 3 });
    expect(transport.writes()).toBe(3);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(1);
  });

  it('returns at the deadline while retaining an uncancellable in-flight write for lifecycle ownership', async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const transport = faults({ hold });
    const result = await settleRequest(transport.database, registered, usage(), { ...options, budgetMs: 200 });
    expect(result).toMatchObject({ status: 'pending', reason: 'budget_exhausted', attempts: 1 });
    expect(transport.writes()).toBe(1);
    if (result.status !== 'pending') throw new Error('Expected pending work');
    expect(result.inFlight).not.toBeNull();
    release(); await result.inFlight;
    const found = await findConsumptionSettlement(testEnv.DB, { operationId: result.evidence.operationId, requestId: registered.id, userId: 'b13-user',
      priceSnapshotJson: result.evidence.priceSnapshotJson, usage: JSON.parse(result.evidence.usageSnapshotJson) as UsageSnapshot, costUnits: result.evidence.costUnits });
    expect(found).not.toBeNull(); expect(transport.writes()).toBe(1);
  });

  it('honors the hard six-second ceiling before beginning work and rejects larger configured limits', async () => {
    let reads = 0;
    const transport = faults({});
    const result = await settleRequest(transport.database, registered, usage(), { ...options, elapsedNow: () => reads++ === 0 ? 0 : 6000 });
    expect(result).toMatchObject({ status: 'pending', reason: 'budget_exhausted', attempts: 0 });
    expect(transport.calls).toEqual([]);
    for (const invalid of [{ budgetMs: 6001 }, { maxAttempts: 4 }, { retryDelayMs: -1 }]) await expect(settleRequest(testEnv.DB, registered, usage(), invalid)).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('handles concurrent settlement callers without relabeling a successful race as a conflict', async () => {
    const results = await Promise.all([settleRequest(testEnv.DB, registered, usage(), options), settleRequest(testEnv.DB, registered, usage(), options)]);
    expect(results.every(result => result.status === 'settled')).toBe(true);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(1);
  });

  it('does not retry conflicts, foreign registrations or unpriceable usage', async () => {
    await settleRequest(testEnv.DB, registered, usage(), options);
    const changed = usage(); if (changed.quality !== 'complete') throw new Error();
    const transport = faults({});
    await expect(settleRequest(transport.database, registered, { ...changed, counts: { inputTokens: 1001, outputTokens: 500 } }, options)).rejects.toMatchObject({ code: 'conflict' });
    expect(transport.writes()).toBe(0);
    await expect(settleRequest(testEnv.DB, { ...registered, id: 'missing-request' }, usage(), options)).rejects.toMatchObject({ code: 'conflict' });
    await expect(settleRequest(testEnv.DB, { ...registered, user_id: 'foreign-owner' }, usage(), options)).rejects.toMatchObject({ code: 'conflict' });
    await expect(settleRequest(testEnv.DB, registered, { quality: 'missing', protocol: 'chat' }, options)).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
