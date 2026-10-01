import { beforeEach, describe, expect, it } from 'vitest';
import { createSettlementRoutes } from '../../apps/worker/admin/settlement-routes';
import { saveSettlementRecovery } from '../../apps/worker/billing/recovery';
import { createPriceSnapshot } from '../../apps/worker/billing/fingerprint';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { issueCsrfToken } from '../../apps/worker/auth/csrf';
import type { UsageSnapshot } from '../../packages/apicompat/types/shared';
import { testEnv } from '../helpers/database';

const usage: UsageSnapshot = { quality: 'complete', protocol: 'chat', counts: { inputTokens: 1000, outputTokens: 500 },
  semantics: { cacheRead: 'included_in_input', cacheWrite: 'included_in_input', reasoning: 'included_in_output', cacheWriteTtl: 'unknown' }, sources: [{ protocol: 'chat', path: 'usage' }], issues: [] };
const origin = 'https://console.example'; const path = '/api/v1/admin/requests/b18-request/retry-settlement';
const cookies = new Map<string, string>();
function headers(user = 'b18-admin') { const csrf = issueCsrfToken(); return { Cookie: `${cookies.get(user) ?? ''}; ${csrf.setCookie.split(';')[0]}`, Origin: origin, 'X-CSRF-Token': csrf.token, 'Content-Type': 'application/json' }; }
function request(body: unknown = {}, user = 'b18-admin', extra: Record<string, string> = {}) {
  return createSettlementRoutes({ now: () => 3000, trustedOrigin: () => origin }).request(origin + path,
    { method: 'POST', headers: { ...headers(user), ...extra }, body: JSON.stringify(body) }, { DB: testEnv.DB });
}
beforeEach(async () => {
  cookies.clear();
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('b18-group','B18','active',1,0,0)").run();
  for (const id of ['b18-admin', 'b18-user']) {
    await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES(?,?,?,?,'active','b18-group',100000,2,60,'bootstrap',0,0)`).bind(id, `${id}@example.invalid`, 'test-only', id === 'b18-admin' ? 'admin' : 'user').run();
    cookies.set(id, (await createCookieSession(testEnv.DB, id, 1000)).setCookie.split(';')[0]!);
  }
  await testEnv.DB.prepare("INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at) VALUES('b18-key','b18-user',?,'s2a_key_ABCDEFGH','test','active',0,0)").bind('8'.repeat(64)).run();
  await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES('b18-channel','test','https://example.invalid',?,'v1','active',0,2,60,1,0,0)`).bind(JSON.stringify({ algorithm: 'A256GCM', format_version: 1, key_version: 'v1', nonce: 'synthetic', ciphertext: 'synthetic' })).run();
  await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('b18-model','active','{"input":"1","output":"2"}',1,0,4096,0,0)`).run();
  const price = createPriceSnapshot({ publicModelId: 'b18-model', upstreamModel: 'provider', upstreamProtocol: 'chat', priceVersion: 1, sellPrices: { input: '1', output: '2' } }).json;
  await testEnv.DB.prepare(`INSERT INTO requests(id,user_id,api_key_id,channel_id,public_model_id,upstream_model,downstream_protocol,upstream_protocol,price_snapshot,created_at,updated_at)
    VALUES('b18-request','b18-user','b18-key','b18-channel','b18-model','provider','chat','chat',?,1000,1000)`).bind(price).run();
  await saveSettlementRecovery(testEnv.DB, { requestId: 'b18-request', userId: 'b18-user', usage }, 2000);
});

describe('administrator known-evidence settlement retry on native D1', () => {
  it('debits the original operation once and returns only safe amounts/identity on replay', async () => {
    const response = await request(); expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ data: { status: 'settled', costUnits: '200000' } });
    const before = await testEnv.DB.prepare('SELECT * FROM billing_entries').all();
    expect(await (await request()).json()).toMatchObject({ data: { status: 'already_settled', costUnits: '200000' } });
    expect((await testEnv.DB.prepare('SELECT * FROM billing_entries').all()).results).toEqual(before.results);
    expect(await testEnv.DB.prepare("SELECT balance_units FROM users WHERE id='b18-user'").first('balance_units')).toBe(-100000);
    expect(before.results).toHaveLength(1); expect(before.results[0]?.operation_id).toBe('consume:b18-request');
    expect((await testEnv.DB.prepare('SELECT action FROM admin_audit').all()).results).toEqual([{ action: 'settlement.retry_requested' }]);
  });
  it('converges concurrent manual requests to a single immutable debit', async () => {
    const responses = await Promise.all([request(), request()]); expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(1);
    expect(await testEnv.DB.prepare("SELECT balance_units FROM users WHERE id='b18-user'").first('balance_units')).toBe(-100000);
  });
  it('rejects unknown or tampered evidence and does not substitute zero', async () => {
    await testEnv.DB.prepare("UPDATE requests SET cost_units=1 WHERE id='b18-request'").run();
    expect((await request()).status).toBe(409);
    await testEnv.DB.prepare("UPDATE requests SET usage_quality='missing',usage_json=NULL,cost_units=NULL,billing_status='usage_unknown' WHERE id='b18-request'").run();
    expect((await request()).status).toBe(409);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(0);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM admin_audit').first('n')).toBe(0);
  });
  it('requires session/admin/Origin/CSRF and rejects caller-supplied settlement facts', async () => {
    const bare = createSettlementRoutes({ now: () => 3000 });
    expect((await bare.request(origin + path, { method: 'POST' }, { DB: testEnv.DB })).status).toBe(401);
    expect((await request({}, 'b18-user')).status).toBe(403);
    expect((await request({}, 'b18-admin', { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await request({}, 'b18-admin', { 'X-CSRF-Token': '' })).status).toBe(403);
    for (const body of [{ costUnits: '0' }, { usage }, { actorId: 'b18-admin' }, { resetRetries: true }]) expect((await request(body)).status).toBe(400);
  });
  it('does not debit when attempt-audit storage fails', async () => {
    await testEnv.DB.exec("CREATE TRIGGER b18_fail_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'PRIVATE AUDIT'); END");
    const response = await request(); expect(response.status).toBe(503); expect(await response.text()).not.toContain('PRIVATE');
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(0);
    expect(await testEnv.DB.prepare("SELECT billing_status FROM requests WHERE id='b18-request'").first('billing_status')).toBe('settlement_pending');
  });
  it('retains pending evidence and truthful intent audit on a failed debit, then retries safely', async () => {
    await testEnv.DB.exec("CREATE TRIGGER b18_fail_debit BEFORE INSERT ON billing_entries BEGIN SELECT RAISE(ABORT,'PRIVATE DEBIT'); END");
    const response = await request(); expect(response.status).toBe(503); expect(await response.text()).not.toContain('PRIVATE');
    expect((await testEnv.DB.prepare('SELECT action FROM admin_audit').all()).results).toEqual([{ action: 'settlement.retry_requested' }]);
    expect(await testEnv.DB.prepare("SELECT usage_quality,billing_status FROM requests WHERE id='b18-request'").first()).toEqual({ usage_quality: 'complete', billing_status: 'settlement_pending' });
    await testEnv.DB.exec('DROP TRIGGER b18_fail_debit'); expect((await request()).status).toBe(200);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(1);
  });
});
