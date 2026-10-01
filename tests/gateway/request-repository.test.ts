import { beforeEach, describe, expect, it } from 'vitest';
import { commitRequestRegistration, finishRequest, getRequest, markRequestStarted, prepareRequestRegistration } from '../../apps/worker/gateway/request-repository';
import type { RequestRegistrationInput } from '../../apps/worker/gateway/request-repository';
import { createPriceSnapshot } from '../../apps/worker/billing/fingerprint';
import { batch, prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const now = 1000;
const input = (): RequestRegistrationInput => ({ userId: 'b11-user', keyId: 'b11-key', groupId: 'b11-group', channelId: 'b11-channel',
  downstreamProtocol: 'responses', now, versions: { user: 1, key: 1, group: 1, channel: 1, mapping: 1 },
  priceSnapshotJson: createPriceSnapshot({ publicModelId: 'b11-model', upstreamModel: 'upstream-model', upstreamProtocol: 'chat', priceVersion: 1,
    sellPrices: { input: '1', output: '2' } }).json });
const register = () => commitRequestRegistration(testEnv.DB, prepareRequestRegistration(testEnv.DB, input()));

beforeEach(async () => {
  await prepare(testEnv.DB, "INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('b11-group','B11 Group','active',1,0,0)").run();
  for (const user of ['b11-user', 'b11-other']) await prepare(testEnv.DB, `INSERT INTO users
    (id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES(?,?,'test-only-hash','user','active','b11-group',100,2,60,'admin',0,0)`, [user, `${user}@example.invalid`]).run();
  await prepare(testEnv.DB, `INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at)
    VALUES('b11-key','b11-user',?,'s2a_key_ABCDEFGH','B11 Key','active',0,0)`, ['a'.repeat(64)]).run();
  const ciphertext = JSON.stringify({ algorithm: 'A256GCM', format_version: 1, key_version: 'test', nonce: 'synthetic', ciphertext: 'synthetic-only' });
  await prepare(testEnv.DB, `INSERT INTO channels(id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES('b11-channel','B11 Channel','https://example.invalid',?,'test','active',1,2,60,1,0,0)`, [ciphertext]).run();
  await prepare(testEnv.DB, `INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('b11-model','active',?,1,10,4096,0,0)`, [JSON.stringify({ output: '2', input: '1' })]).run();
  await prepare(testEnv.DB, "INSERT INTO channel_groups(channel_id,group_id) VALUES('b11-channel','b11-group')").run();
  await prepare(testEnv.DB, `INSERT INTO channel_models(channel_id,public_model_id,protocol,upstream_model,capabilities_json,config_version)
    VALUES('b11-channel','b11-model','chat','upstream-model',?,1)`, [JSON.stringify({ protocol: 'chat', features: [] })]).run();
});

describe('pre-send request registration on native D1', () => {
  it('generates an internal UUID and preserves complete price JSON without invented usage/cost', async () => {
    const registration = prepareRequestRegistration(testEnv.DB, input());
    expect(registration.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const row = await commitRequestRegistration(testEnv.DB, registration);
    expect(row).toMatchObject({ id: registration.requestId, execution_status: 'admitted', billing_status: 'awaiting_usage', price_snapshot: input().priceSnapshotJson });
    expect(await prepare(testEnv.DB, 'SELECT usage_json,usage_quality,cost_units FROM requests WHERE id=?', [row.id]).first())
      .toEqual({ usage_json: null, usage_quality: 'missing', cost_units: null });
    expect(await getRequest(testEnv.DB, row.id, 'b11-other')).toBeNull();
    expect(await getRequest(testEnv.DB, row.id, 'b11-user')).toEqual(row);
  });

  it.each(['key', 'user', 'group', 'channel', 'mapping'])('rejects changed %s versions at insertion', async field => {
    const value = input();
    value.versions[field as keyof typeof value.versions] = 2;
    await expect(commitRequestRegistration(testEnv.DB, prepareRequestRegistration(testEnv.DB, value))).rejects.toMatchObject({ code: 'conflict' });
  });

  it('enforces actual key ownership and group-channel mapping rather than FK existence alone', async () => {
    await expect(commitRequestRegistration(testEnv.DB, prepareRequestRegistration(testEnv.DB, { ...input(), userId: 'b11-other' }))).rejects.toMatchObject({ code: 'conflict' });
    await prepare(testEnv.DB, 'DELETE FROM channel_groups').run();
    await expect(register()).rejects.toMatchObject({ code: 'conflict' });
  });

  it.each([
    "UPDATE api_keys SET status='revoked'", "UPDATE api_keys SET expires_at=1000", "UPDATE api_keys SET allowed_models_json='[]'",
    "UPDATE users SET status='disabled' WHERE id='b11-user'", "UPDATE groups SET status='disabled' WHERE id='b11-group'",
    "UPDATE channels SET status='disabled'", "UPDATE models SET status='disabled'", "UPDATE users SET balance_units=0 WHERE id='b11-user'",
    "UPDATE models SET price_version=2", "UPDATE channel_models SET upstream_model='changed'",
  ])('checks current state in the same INSERT %#', async sql => {
    const registration = prepareRequestRegistration(testEnv.DB, input());
    await prepare(testEnv.DB, sql).run();
    await expect(commitRequestRegistration(testEnv.DB, registration)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects snapshot price manipulation even if the supplied version is unchanged', async () => {
    const value = input();
    value.priceSnapshotJson = createPriceSnapshot({ publicModelId: 'b11-model', upstreamModel: 'upstream-model', upstreamProtocol: 'chat', priceVersion: 1,
      sellPrices: { input: '0', output: '0' } }).json;
    await expect(commitRequestRegistration(testEnv.DB, prepareRequestRegistration(testEnv.DB, value))).rejects.toMatchObject({ code: 'conflict' });
  });

  it('requires new snapshots to bind the registered group and current multiplier', async () => {
    const base = { publicModelId: 'b11-model', upstreamModel: 'upstream-model', upstreamProtocol: 'chat' as const,
      priceVersion: 1, sellPrices: { input: '1', output: '2' } };
    const wrongGroup = { ...input(), priceSnapshotJson: createPriceSnapshot({ ...base, groupId: 'other-group', groupVersion: 1, billingMultiplier: '1' }).json };
    await expect(commitRequestRegistration(testEnv.DB, prepareRequestRegistration(testEnv.DB, wrongGroup))).rejects.toMatchObject({ code: 'conflict' });
    const wrongMultiplier = { ...input(), priceSnapshotJson: createPriceSnapshot({ ...base, groupId: 'b11-group', groupVersion: 1, billingMultiplier: '0.2' }).json };
    await expect(commitRequestRegistration(testEnv.DB, prepareRequestRegistration(testEnv.DB, wrongMultiplier))).rejects.toMatchObject({ code: 'conflict' });
  });

  it('keeps the admitted price snapshot when the group multiplier changes later', async () => {
    const value = { ...input(), priceSnapshotJson: createPriceSnapshot({ publicModelId: 'b11-model', upstreamModel: 'upstream-model',
      upstreamProtocol: 'chat', priceVersion: 1, sellPrices: { input: '1', output: '2' }, groupId: 'b11-group', groupVersion: 1,
      billingMultiplier: '1' }).json };
    const row = await commitRequestRegistration(testEnv.DB, prepareRequestRegistration(testEnv.DB, value));
    await prepare(testEnv.DB, "UPDATE groups SET billing_multiplier='0.2',version=2 WHERE id='b11-group'").run();
    expect((await getRequest(testEnv.DB, row.id, 'b11-user'))?.price_snapshot).toBe(value.priceSnapshotJson);
  });

  it('rolls back other same-batch writes when the conditional INSERT matches zero rows', async () => {
    const registration = prepareRequestRegistration(testEnv.DB, { ...input(), userId: 'b11-other' });
    await expect(batch(testEnv.DB, [prepare(testEnv.DB, "UPDATE users SET balance_units=200 WHERE id='b11-user'"), ...registration.statements])).rejects.toThrow();
    expect((await prepare(testEnv.DB, "SELECT balance_units FROM users WHERE id='b11-user'").first())?.balance_units).toBe(100);
    expect((await prepare(testEnv.DB, 'SELECT count(*) AS n FROM requests').first())?.n).toBe(0);
  });

  it('rejects duplicate submission of the same prepared request ID', async () => {
    const registration = prepareRequestRegistration(testEnv.DB, input());
    await commitRequestRegistration(testEnv.DB, registration);
    await expect(commitRequestRegistration(testEnv.DB, registration)).rejects.toMatchObject({ code: 'conflict' });
    expect((await prepare(testEnv.DB, 'SELECT count(*) AS n FROM requests').first())?.n).toBe(1);
  });

  it('rebinds expiry checks after lease waits without changing UUID or selected facts', async () => {
    const value = input();
    const registration = prepareRequestRegistration(testEnv.DB, value);
    value.userId = 'b11-other'; value.versions.channel = 99;
    await prepare(testEnv.DB, 'UPDATE api_keys SET expires_at=1001').run();
    const refreshed = registration.refreshTime(1001);
    expect(refreshed.requestId).toBe(registration.requestId);
    await expect(commitRequestRegistration(testEnv.DB, refreshed)).rejects.toMatchObject({ code: 'conflict' });
    await prepare(testEnv.DB, 'UPDATE api_keys SET expires_at=2000').run();
    const row = await commitRequestRegistration(testEnv.DB, registration.refreshTime(1002));
    expect(row).toMatchObject({ id: registration.requestId, user_id: 'b11-user', created_at: 1002 });
  });

  it('allows only one terminal CAS and rejects late downgrade/start updates', async () => {
    const row = await register();
    expect(await markRequestStarted(testEnv.DB, row.id, 'b11-user', now + 1)).toBe(true);
    const results = await Promise.all([
      finishRequest(testEnv.DB, row.id, 'b11-user', { status: 'succeeded', upstreamRequestId: 'provider-1' }, now + 2),
      finishRequest(testEnv.DB, row.id, 'b11-user', { status: 'cancelled', errorCode: 'client_cancelled' }, now + 2),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const terminal = await getRequest(testEnv.DB, row.id, 'b11-user');
    expect(await finishRequest(testEnv.DB, row.id, 'b11-user', { status: 'failed', errorCode: 'upstream_error' }, now + 3)).toBe(false);
    expect(await markRequestStarted(testEnv.DB, row.id, 'b11-user', now + 3)).toBe(false);
    expect(await getRequest(testEnv.DB, row.id, 'b11-user')).toEqual(terminal);
    expect((await prepare(testEnv.DB, 'SELECT usage_json,cost_units FROM requests WHERE id=?', [row.id]).first()))
      .toEqual({ usage_json: null, cost_units: null });
  });

  it('rejects oversized/control-character upstream IDs and wrong-user updates', async () => {
    const row = await register();
    await expect(finishRequest(testEnv.DB, row.id, 'b11-user', { status: 'succeeded', responseId: 'x'.repeat(257) }, now + 1)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(finishRequest(testEnv.DB, row.id, 'b11-user', { status: 'succeeded', upstreamRequestId: 'bad\n' }, now + 1)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await finishRequest(testEnv.DB, row.id, 'b11-other', { status: 'failed' }, now + 1)).toBe(false);
    expect(await finishRequest(testEnv.DB, row.id, 'b11-user', { status: 'failed' }, now - 1)).toBe(false);
  });
});
