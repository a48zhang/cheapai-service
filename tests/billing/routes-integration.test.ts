import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../../apps/worker/app';
import type { Env } from '../../apps/worker/env';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { issueCsrfToken } from '../../apps/worker/auth/csrf';
import { createPriceSnapshot } from '../../apps/worker/billing/fingerprint';
import { saveSettlementRecovery } from '../../apps/worker/billing/recovery';
import type { UsageSnapshot } from '../../packages/apicompat/types/shared';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const origin = 'https://console.example';
const owner = 'b20-route-owner';
const other = 'b20-route-other';
const admin = 'b20-route-admin';
let ownerCookie: string;
let otherCookie: string;
let adminCookie: string;
let price: string;

const bindings = (): Env => ({ ...testEnv, ENVIRONMENT: 'local', PUBLIC_BASE_URL: origin });
function csrfHeaders(cookie: string, method = 'GET'): Record<string, string> {
  const nonce = issueCsrfToken();
  return { Cookie: `${cookie}; ${nonce.setCookie.split(';')[0]}`,
    ...(method === 'GET' ? {} : { Origin: origin, 'X-CSRF-Token': nonce.token, 'Content-Type': 'application/json' }) };
}
function call(path: string, options: { method?: string; body?: unknown; cookie?: string; env?: Env } = {}) {
  const method = options.method ?? 'GET';
  return app.fetch(new Request(origin + path, { method, headers: csrfHeaders(options.cookie ?? '', method),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }), options.env ?? bindings());
}
async function session(id: string): Promise<string> {
  return (await createCookieSession(testEnv.DB, id, Date.now())).setCookie.split(';')[0]!;
}
async function insertRequest(id: string, userId = owner, createdAt = 1000): Promise<void> {
  await prepare(testEnv.DB, `INSERT INTO requests
    (id,user_id,api_key_id,channel_id,public_model_id,upstream_model,downstream_protocol,upstream_protocol,price_snapshot,created_at,updated_at)
    VALUES (?,?,'b20-key','b20-channel','b20-model','b20-upstream','chat','chat',?,?,?)`, [id, userId, price, createdAt, createdAt]).run();
}
const usage: UsageSnapshot = { quality: 'complete', protocol: 'chat', counts: { inputTokens: 1000, outputTokens: 500 },
  semantics: { cacheRead: 'included_in_input', cacheWrite: 'included_in_input', reasoning: 'included_in_output', cacheWriteTtl: 'unknown' },
  sources: [{ protocol: 'chat', path: 'usage' }], issues: [] };

beforeEach(async () => {
  const now = Date.now();
  await prepare(testEnv.DB, "INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('b20-route-group','B20','active',1,?,?)", [now, now]).run();
  for (const [id, role] of [[owner, 'user'], [other, 'user'], [admin, 'admin']] as const) {
    await prepare(testEnv.DB, `INSERT INTO users
      (id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES (?,?, 'test-only',?,'active','b20-route-group',0,2,60,'bootstrap',?,?)`,
    [id, `${id}@example.invalid`, role, now, now]).run();
  }
  ownerCookie = await session(owner); otherCookie = await session(other); adminCookie = await session(admin);
  price = createPriceSnapshot({ publicModelId: 'b20-model', upstreamModel: 'b20-upstream', upstreamProtocol: 'chat',
    priceVersion: 1, sellPrices: { input: '1', output: '2' } }).json;
  await prepare(testEnv.DB, `INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at)
    VALUES('b20-key',?,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','s2a_key_ABCDEFGH','B20','active',0,0)`, [owner]).run();
  await prepare(testEnv.DB, `INSERT INTO channels(id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES('b20-channel','B20','https://provider.example',?,'v1','active',1,1,60,1,0,0)`,
  [JSON.stringify({ algorithm: 'A256GCM', format_version: 1, key_version: 'v1', nonce: 'synthetic', ciphertext: 'synthetic' })]).run();
  await prepare(testEnv.DB, `INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('b20-model','active','{"input":"1","output":"2"}',1,0,4096,0,0)`).run();
  await insertRequest('b20-owner-request'); await insertRequest('b20-other-request', other, 1001);
});

describe('B20/O03 mounted management routes on the real app', () => {
  it('keeps request and billing scopes isolated, retries known settlement evidence, and reconciles it', async () => {
    const ownerPage = await call('/api/v1/usage/requests', { cookie: ownerCookie });
    expect(ownerPage.status).toBe(200);
    expect((await ownerPage.json<{ data: { items: { user_id: string }[] } }>()).data.items).toEqual([
      expect.objectContaining({ user_id: owner }),
    ]);
    expect((await call('/api/v1/admin/requests', { cookie: ownerCookie })).status).toBe(403);
    const adminPage = await call('/api/v1/admin/requests', { cookie: adminCookie });
    expect(adminPage.status).toBe(200);
    expect((await adminPage.json<{ data: { items: { user_id: string }[] } }>()).data.items.map(item => item.user_id).sort())
      .toEqual([other, owner].sort());

    await saveSettlementRecovery(testEnv.DB, { requestId: 'b20-owner-request', userId: owner, usage }, 2000);
    const retryPath = '/api/v1/admin/requests/b20-owner-request/retry-settlement';
    const retry = await call(retryPath, { method: 'POST', cookie: adminCookie, body: {} });
    expect(retry.status).toBe(200);
    expect((await retry.json<{ data: { status: string } }>()).data.status).toBe('settled');
    expect(await testEnv.DB.prepare("SELECT billing_status FROM requests WHERE id='b20-owner-request'").first('billing_status')).toBe('settled');

    const reconciliation = await call('/api/v1/admin/billing/reconciliation?limit=10', { cookie: adminCookie });
    expect(reconciliation.status).toBe(200);
    expect((await reconciliation.json<{ data: { items: { userId: string; matches: boolean }[] } }>()).data.items)
      .toEqual(expect.arrayContaining([expect.objectContaining({ userId: owner, matches: true })]));
    expect((await call('/api/v1/admin/billing/reconciliation', { cookie: ownerCookie })).status).toBe(403);
  });

  it('mounts audit query with the same session boundary and preserves no-store JSON errors', async () => {
    const anonymous = await call('/api/v1/admin/audit');
    expect(anonymous.status).toBe(401);
    const ordinary = await call('/api/v1/admin/audit', { cookie: ownerCookie });
    expect(ordinary.status).toBe(403);
    const response = await call('/api/v1/admin/audit?limit=2', { cookie: adminCookie });
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toHaveProperty('data.items');
  });
});
