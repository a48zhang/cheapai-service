import { beforeEach, describe, expect, it } from 'vitest';
import { checkBalanceAdmission } from '../../apps/worker/billing/admission';
import { authenticatePlatformKey } from '../../apps/worker/auth/api-key-auth';
import { createPlatformKey } from '../../apps/worker/auth/key-repository';
import type { InternalPlatformKeyAuth } from '../../apps/worker/auth/key-repository';
import { balanceCacheKey, readBalance } from '../../apps/worker/cache/balance';
import { encodeSnapshot } from '../../apps/worker/cache/snapshot';
import { testEnv } from '../helpers/database';

let subject: InternalPlatformKeyAuth;
const at = 5000;
const admit = (db = testEnv.DB) => checkBalanceAdmission(db, subject, 'b05-model', at);
beforeEach(async () => {
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('b05-group','Fixture','active',1,0,0)").run();
  await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES('b05-user','b05@example.invalid','synthetic','user','active','b05-group',100,2,60,'admin',0,0)`).run();
  await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('b05-model','active','{"input":"1","output":"2"}',1,100,4096,0,0)`).run();
  const key = await createPlatformKey(testEnv.DB, 'b05-user', { operationId: 'b05-create', name: 'Fixture', allowedModels: null }, 1000);
  if (key.kind !== 'created') throw new Error('Expected synthetic key');
  subject = await authenticatePlatformKey(testEnv.DB, new Request('https://example.invalid/v1/messages', { headers: { 'x-api-key': key.token } }), 2000);
});

describe('B05 current D1 balance admission', () => {
  it('allows equality at a positive threshold and returns a read result, not a reservation', async () => {
    expect(await admit()).toMatchObject({ userId: 'b05-user', publicModelId: 'b05-model', balanceUnits: '100', admissionMinBalanceUnits: '100', source: 'd1', requiresAuthoritativeRegistration: true });
    await admit();
    expect(await testEnv.DB.prepare("SELECT balance_units FROM users WHERE id='b05-user'").first('balance_units')).toBe(100);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM requests').first('n')).toBe(0);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(0);
  });

  it.each([-100, 0, 99])('denies current balance %s although A27 previously observed 100', async balance => {
    await testEnv.DB.prepare("UPDATE users SET balance_units=? WHERE id='b05-user'").bind(balance).run();
    await expect(admit()).rejects.toMatchObject({ code: 'insufficient_balance' });
  });

  it('requires a strictly positive balance even when the model threshold is zero', async () => {
    await testEnv.DB.prepare("UPDATE models SET admission_min_balance_units=0 WHERE public_model_id='b05-model'").run();
    await testEnv.DB.prepare("UPDATE users SET balance_units=0 WHERE id='b05-user'").run();
    await expect(admit()).rejects.toMatchObject({ code: 'insufficient_balance' });
    await testEnv.DB.prepare("UPDATE users SET balance_units=1 WHERE id='b05-user'").run();
    expect((await admit()).balanceUnits).toBe('1');
  });

  it('uses current model threshold/version and exact safe-integer values', async () => {
    await testEnv.DB.prepare("UPDATE models SET admission_min_balance_units=?,price_version=2 WHERE public_model_id='b05-model'").bind(Number.MAX_SAFE_INTEGER).run();
    await expect(admit()).rejects.toMatchObject({ code: 'insufficient_balance' });
    await testEnv.DB.prepare("UPDATE users SET balance_units=?,version=2 WHERE id='b05-user'").bind(Number.MAX_SAFE_INTEGER).run();
    expect(await admit()).toMatchObject({ balanceUnits: '9007199254740991', admissionMinBalanceUnits: '9007199254740991', priceVersion: 2, userVersion: 2 });
  });

  it('never authorizes a positive C15 cache hint when D1 is negative or unavailable', async () => {
    await testEnv.CACHE.put(balanceCacheKey('b05-user'), encodeSnapshot({ schema_version: 1, observed_at: at,
      data: { user_id: 'b05-user', balance_units: '9999', user_version: 1 } })!);
    const unavailable = { prepare() { throw new Error('Synthetic unavailable'); } } as unknown as D1Database;
    const hint = await readBalance(unavailable, testEnv.CACHE, 'b05-user', { balanceCacheEnabled: true, balanceCacheTtlMs: 15000, admissionMinBalanceUnits: '100' }, () => at);
    expect(hint).toMatchObject({ source: 'cache', requiresAuthoritativeAdmission: true });
    await expect(admit(unavailable)).rejects.toMatchObject({ code: 'service_unavailable' });
    await testEnv.DB.prepare("UPDATE users SET balance_units=-1 WHERE id='b05-user'").run();
    await expect(admit()).rejects.toMatchObject({ code: 'insufficient_balance' });
  });

  it('does not let a stale low cache reject a user credited in D1', async () => {
    await testEnv.CACHE.put(balanceCacheKey('b05-user'), encodeSnapshot({ schema_version: 1, observed_at: at, data: { user_id: 'b05-user', balance_units: '-100', user_version: 1 } })!);
    await testEnv.DB.prepare("UPDATE users SET balance_units=200 WHERE id='b05-user'").run();
    expect((await admit()).balanceUnits).toBe('200');
  });

  it.each(['key', 'user', 'group', 'expiry'])('rechecks current %s eligibility after A27', async kind => {
    if (kind === 'key') await testEnv.DB.prepare("UPDATE api_keys SET status='revoked' WHERE id=?").bind(subject.key.id).run();
    if (kind === 'user') await testEnv.DB.prepare("UPDATE users SET status='disabled' WHERE id='b05-user'").run();
    if (kind === 'group') await testEnv.DB.prepare("UPDATE groups SET status='disabled' WHERE id='b05-group'").run();
    if (kind === 'expiry') await testEnv.DB.prepare('UPDATE api_keys SET expires_at=? WHERE id=?').bind(at, subject.key.id).run();
    await expect(admit()).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('checks current Key model restrictions and active model state', async () => {
    await testEnv.DB.prepare("UPDATE api_keys SET allowed_models_json='[]' WHERE id=?").bind(subject.key.id).run();
    await expect(admit()).rejects.toMatchObject({ code: 'forbidden' });
    await testEnv.DB.prepare("UPDATE api_keys SET allowed_models_json='[\"b05-model\"]' WHERE id=?").bind(subject.key.id).run();
    expect((await admit()).publicModelId).toBe('b05-model');
    await testEnv.DB.prepare("UPDATE models SET status='disabled' WHERE public_model_id='b05-model'").run();
    await expect(admit()).rejects.toMatchObject({ code: 'forbidden' });
    await expect(checkBalanceAdmission(testEnv.DB, subject, 'missing', at)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects inconsistent internal subject identities and malformed inputs', async () => {
    await expect(checkBalanceAdmission(testEnv.DB, { ...subject, user: { ...subject.user, id: 'other' } }, 'b05-model', at)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(checkBalanceAdmission(testEnv.DB, subject, 'b05-model', -1)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(checkBalanceAdmission(testEnv.DB, subject, '', at)).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
