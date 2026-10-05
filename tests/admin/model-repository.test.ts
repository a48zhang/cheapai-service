import { beforeEach, describe, expect, it } from 'vitest';
import { createModel, getModelById, updateModel } from '../../apps/worker/admin/model-repository';
import type { CreateModelInput, ModelAuditContext, ModelPatch } from '../../apps/worker/admin/model-repository';
import { calculatePrice } from '../../apps/worker/billing/pricing';
import type { UsageSnapshot } from '../../packages/apicompat/types/shared';
import { testEnv } from '../helpers/database';

// Synthetic local database inputs; no provider calls or production prices.
const input = (): CreateModelInput => ({ publicModelId: 'vendor/model-v1', sellPrices: { input: '1.25', output: '2.5' }, admissionMinBalanceUnits: '0', maxOutputTokens: 4096 });
const audit = (operationId: string, now = 1000): ModelAuditContext => ({ actorId: 'c08-admin', operationId, now });
const counts = async () => ({
  models: await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM models').first('count'),
  audits: await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM admin_audit WHERE target_type='model'").first('count'),
});

describe('model repository with native D1', () => {
  beforeEach(async () => {
    // These repository cases assert isolated record counts; seed installation has its own migration tests.
    await testEnv.DB.prepare('DELETE FROM models').run();
    await testEnv.DB.prepare("INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES ('c08-group','Fixture group','active',1,0,0)").run();
    await testEnv.DB.prepare(`INSERT INTO users (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES ('c08-admin','c08@example.invalid','synthetic-only','admin','active','c08-group',2,60,'admin',0,0)`).run();
  });

  it('creates and reads explicit model configuration with an atomic audit', async () => {
    const saved = await createModel(testEnv.DB, input(), audit('create'));
    expect(saved).toEqual({ ...input(), status: 'active', priceVersion: 1, createdAt: 1000, updatedAt: 1000 });
    expect(await getModelById(testEnv.DB, saved.publicModelId)).toEqual(saved);
    expect(await counts()).toEqual({ models: 1, audits: 1 });
    const row = await testEnv.DB.prepare('SELECT sell_prices_json,admission_min_balance_units FROM models WHERE public_model_id=?').bind(saved.publicModelId).first<{ sell_prices_json: string; admission_min_balance_units: number }>();
    expect(row).toEqual({ sell_prices_json: '{"input":"1.25","output":"2.5"}', admission_min_balance_units: 0 });
    const event = await testEnv.DB.prepare("SELECT action,target_type,target_id,redacted_change_json FROM admin_audit WHERE operation_id='create'").first<{ action: string; target_type: string; target_id: string; redacted_change_json: string }>();
    expect(event).toMatchObject({ action: 'model.create', target_type: 'model', target_id: saved.publicModelId });
    expect(JSON.parse(event!.redacted_change_json)).toEqual({ after: { status: 'active', price_version: 1, admission_min_balance_units: 0, max_output_tokens: 4096 } });
  });

  it('preserves explicit free rates, optional absence and maximum safe units exactly', async () => {
    const saved = await createModel(testEnv.DB, { ...input(), sellPrices: { input: '0', output: '0.00000000', cacheRead: '0', cacheWrite1h: '90071992.54740991' }, admissionMinBalanceUnits: '9007199254740991', maxOutputTokens: Number.MAX_SAFE_INTEGER }, audit('zero'));
    expect(saved.sellPrices).toEqual({ input: '0', output: '0.00000000', cacheRead: '0', cacheWrite1h: '90071992.54740991' });
    expect(Object.hasOwn(saved.sellPrices, 'cacheWrite')).toBe(false);
    expect(Object.hasOwn(saved.sellPrices, 'reasoning')).toBe(false);
    expect(saved.admissionMinBalanceUnits).toBe('9007199254740991');
    expect(await testEnv.DB.prepare('SELECT admission_min_balance_units FROM models').first('admission_min_balance_units')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('does not interpret an omitted excluded-usage price as free in B02', async () => {
    const saved = await createModel(testEnv.DB, input(), audit('base-prices'));
    const usage: UsageSnapshot = { quality: 'complete', protocol: 'messages', counts: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0, reasoningTokens: 0 },
      semantics: { cacheRead: 'excluded_from_input', cacheWrite: 'excluded_from_input', reasoning: 'included_in_output', cacheWriteTtl: 'subsets_of_cache_write' },
      sources: [{ protocol: 'messages', path: 'usage' }], issues: [] };
    expect(() => calculatePrice(usage, saved.sellPrices)).toThrow('missing_price');
    const next = await updateModel(testEnv.DB, saved.publicModelId, 1, { sellPrices: { input: '1.25', output: '2.5', cacheRead: '0' } }, audit('explicit-zero'));
    expect(calculatePrice(usage, next.sellPrices).items.find(item => item.bucket === 'cacheRead')?.unitsPerMillionTokens).toBe(0n);
  });

  it('updates model configuration under priceVersion CAS and replaces the entire price table', async () => {
    const saved = await createModel(testEnv.DB, { ...input(), sellPrices: { input: '1', output: '2', cacheRead: '0.1', reasoning: '3' } }, audit('create'));
    const changed = await updateModel(testEnv.DB, saved.publicModelId, 1, { sellPrices: { input: '3', output: '4' }, status: 'disabled', admissionMinBalanceUnits: '123', maxOutputTokens: 2048 }, audit('update', 2000));
    expect(changed).toMatchObject({ sellPrices: { input: '3', output: '4' }, status: 'disabled', admissionMinBalanceUnits: '123', maxOutputTokens: 2048, priceVersion: 2, createdAt: 1000, updatedAt: 2000 });
    expect(Object.hasOwn(changed.sellPrices, 'cacheRead')).toBe(false);
    expect(Object.hasOwn(changed.sellPrices, 'reasoning')).toBe(false);
    expect(saved.sellPrices).toEqual({ input: '1', output: '2', cacheRead: '0.1', reasoning: '3' });
    const statusOnly = await updateModel(testEnv.DB, saved.publicModelId, 2, { status: 'active' }, audit('status-only', 1500));
    expect(statusOnly).toMatchObject({ priceVersion: 3, sellPrices: changed.sellPrices, updatedAt: 2000, maxOutputTokens: 2048 });
    const event = await testEnv.DB.prepare("SELECT redacted_change_json FROM admin_audit WHERE operation_id='update'").first<string>('redacted_change_json');
    expect(JSON.parse(event!)).toMatchObject({ before: { price_version: 1, status: 'active', admission_min_balance_units: 0 }, after: { price_version: 2, status: 'disabled', admission_min_balance_units: 123 } });
  });

  it('requires both base rates and rejects invalid or implicit rates before any write', async () => {
    const invalid = [undefined, null, [], {}, { input: '1' }, { output: '2' },
      ...[0, null, undefined, '-1', '-0', '01', ' 1', '1e2', '0.000000001', '90071992.54740992', "1'; DROP TABLE models; --"].map(rate => ({ input: rate, output: '2' })),
      { input: '1', output: '2', cacheRead: null }, { input: '1', output: '2', reasoning: undefined },
    ];
    for (const sellPrices of invalid) {
      await expect(createModel(testEnv.DB, { ...input(), sellPrices } as unknown as CreateModelInput, audit('invalid-price'))).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(await counts()).toEqual({ models: 0, audits: 0 });
  });

  it('requires valid max/default output and canonical nonnegative admission units', async () => {
    for (const patch of [
      { maxOutputTokens: undefined }, { maxOutputTokens: null }, { maxOutputTokens: 0 },
      { maxOutputTokens: 0.5 }, { maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 },
      ...[undefined, null, 0, '-1', '-0', '00', '1.0', '+1', '1e2', ' 1', '9007199254740992'].map(admissionMinBalanceUnits => ({ admissionMinBalanceUnits })),
      { status: 'enabled' }, { publicModelId: "m';DROP TABLE models;--" }, { publicModelId: '' }, { publicModelId: 'x'.repeat(129) },
    ]) await expect(createModel(testEnv.DB, { ...input(), ...patch } as unknown as CreateModelInput, audit('invalid-input'))).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await counts()).toEqual({ models: 0, audits: 0 });
  });

  it('rejects empty patches, identity/version changes and partial price replacements without changing stored state', async () => {
    const saved = await createModel(testEnv.DB, input(), audit('create'));
    for (const patch of [{}, { publicModelId: 'renamed' }, { priceVersion: 9 }, { sellPrices: { input: '4' } }, { sellPrices: null }, { sellPrices: undefined }, { maxOutputTokens: 0 }, { defaultOutputTokens: 5000 }, { admissionMinBalanceUnits: -1 }]) {
      await expect(updateModel(testEnv.DB, saved.publicModelId, 1, patch as unknown as ModelPatch, audit('invalid-patch'))).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(await getModelById(testEnv.DB, saved.publicModelId)).toEqual(saved);
    expect(await counts()).toEqual({ models: 1, audits: 1 });
  });

  it('permits only one concurrent create and one same-version update', async () => {
    const created = await Promise.allSettled([createModel(testEnv.DB, input(), audit('create-one')), createModel(testEnv.DB, input(), audit('create-two'))]);
    expect(created.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(created.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    const updated = await Promise.allSettled([
      updateModel(testEnv.DB, input().publicModelId, 1, { sellPrices: { input: '3', output: '4' } }, audit('update-one', 2000)),
      updateModel(testEnv.DB, input().publicModelId, 1, { maxOutputTokens: 512 }, audit('update-two', 2000)),
    ]);
    expect(updated.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(updated.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    expect((await getModelById(testEnv.DB, input().publicModelId))?.priceVersion).toBe(2);
    expect(await counts()).toEqual({ models: 1, audits: 2 });
  });

  it('turns a zero-row update into rollback including an earlier trigger side effect', async () => {
    const saved = await createModel(testEnv.DB, input(), audit('create'));
    await testEnv.DB.exec("CREATE TRIGGER c08_ignore_model_update BEFORE UPDATE ON models BEGIN UPDATE groups SET version=version+1 WHERE id='c08-group'; SELECT RAISE(IGNORE); END;");
    await expect(updateModel(testEnv.DB, saved.publicModelId, 1, { status: 'disabled' }, audit('ignored', 2000))).rejects.toMatchObject({ code: 'conflict' });
    expect(await getModelById(testEnv.DB, saved.publicModelId)).toEqual(saved);
    expect(await testEnv.DB.prepare("SELECT version FROM groups WHERE id='c08-group'").first('version')).toBe(1);
    expect(await counts()).toEqual({ models: 1, audits: 1 });
  });

  it('rolls back business creates and updates when the audit statement fails', async () => {
    const saved = await createModel(testEnv.DB, input(), audit('create'));
    await testEnv.DB.exec("CREATE TRIGGER c08_fail_model_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT, 'synthetic_audit_failure'); END;");
    await expect(createModel(testEnv.DB, { ...input(), publicModelId: 'second-model' }, audit('failed-create'))).rejects.toMatchObject({ code: 'service_unavailable' });
    await expect(updateModel(testEnv.DB, saved.publicModelId, 1, { sellPrices: { input: '0', output: '0' } }, audit('failed-update'))).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(await getModelById(testEnv.DB, saved.publicModelId)).toEqual(saved);
    expect(await counts()).toEqual({ models: 1, audits: 1 });
  });

  it('requires a real audit actor and safely handles missing models and version exhaustion', async () => {
    await expect(createModel(testEnv.DB, input(), { ...audit('orphan'), actorId: 'missing-actor' })).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(await counts()).toEqual({ models: 0, audits: 0 });
    expect(await getModelById(testEnv.DB, 'missing-model')).toBeNull();
    await expect(updateModel(testEnv.DB, 'missing-model', 1, { status: 'disabled' }, audit('missing'))).rejects.toMatchObject({ code: 'not_found' });
    const saved = await createModel(testEnv.DB, input(), audit('create'));
    await expect(updateModel(testEnv.DB, saved.publicModelId, 2, { status: 'disabled' }, audit('stale'))).rejects.toMatchObject({ code: 'conflict' });
    await testEnv.DB.prepare('UPDATE models SET price_version=? WHERE public_model_id=?').bind(Number.MAX_SAFE_INTEGER, saved.publicModelId).run();
    await expect(updateModel(testEnv.DB, saved.publicModelId, Number.MAX_SAFE_INTEGER, { status: 'disabled' }, audit('overflow'))).rejects.toMatchObject({ code: 'conflict' });
    expect(await counts()).toEqual({ models: 1, audits: 1 });
  });

  it('fails closed when stored price JSON has no base prices or an invalid value', async () => {
    const saved = await createModel(testEnv.DB, input(), audit('create'));
    for (const sellPrices of [{}, { input: '1', output: 0 }, { input: '1', output: '2', cacheRead: null }]) {
      await testEnv.DB.prepare('UPDATE models SET sell_prices_json=? WHERE public_model_id=?').bind(JSON.stringify(sellPrices), saved.publicModelId).run();
      await expect(getModelById(testEnv.DB, saved.publicModelId)).rejects.toMatchObject({ code: 'service_unavailable' });
    }
  });

  it('leaves admitted request price snapshots byte-for-byte unchanged after price/status updates', async () => {
    const saved = await createModel(testEnv.DB, input(), audit('create'));
    await testEnv.DB.prepare(`INSERT INTO api_keys (id,user_id,key_hash,display_prefix,name,status,created_at,updated_at)
      VALUES ('c08-key','c08-admin',?,'s2a_key_ABCDEFGH','Synthetic key','active',0,0)`).bind('8'.repeat(64)).run();
    const credential = 'synthetic-upstream';
    await testEnv.DB.prepare(`INSERT INTO channels (id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
      VALUES ('c08-channel','Synthetic channel','https://example.invalid',?,'active',0,2,60,1,0,0)`).bind(credential).run();
    const snapshot = JSON.stringify({ schema_version: 1, price_version: saved.priceVersion, currency: 'USD', sell_prices: saved.sellPrices });
    await testEnv.DB.prepare(`INSERT INTO requests (id,user_id,api_key_id,channel_id,public_model_id,upstream_model,downstream_protocol,upstream_protocol,price_snapshot,created_at,updated_at)
      VALUES ('c08-request','c08-admin','c08-key','c08-channel',?,'fixture-upstream','chat','messages',?,1000,1000)`).bind(saved.publicModelId, snapshot).run();
    const before = await testEnv.DB.prepare("SELECT * FROM requests WHERE id='c08-request'").first();
    await updateModel(testEnv.DB, saved.publicModelId, 1, { sellPrices: { input: '10', output: '20' }, status: 'disabled' }, audit('new-price', 2000));
    expect(await testEnv.DB.prepare("SELECT * FROM requests WHERE id='c08-request'").first()).toEqual(before);
    expect(await testEnv.DB.prepare("SELECT price_snapshot FROM requests WHERE id='c08-request'").first('price_snapshot')).toBe(snapshot);
  });
});
