import { beforeEach, describe, expect, it } from 'vitest';
import { routes } from '../../apps/worker/routes';
import type { Env } from '../../apps/worker/env';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { testEnv } from '../helpers/database';

const base = 'https://details.example.invalid';
let adminCookie: string;
let userCookie: string;
const entities = [
  { kind: 'channels', id: 'details-channel', expected: { id: 'details-channel', hasCredential: true, configVersion: 1 } },
  { kind: 'models', id: 'details/vendor:model', expected: { publicModelId: 'details/vendor:model', priceVersion: 1, sellPrices: { input: '1', output: '2' } } },
  { kind: 'groups', id: 'details-group', expected: { id: 'details-group', channelIds: ['details-channel'], billingMultiplier: '1' } },
  { kind: 'users', id: 'details-user', expected: { id: 'details-user', role: 'user', balance_units: '-9007199254740991', allowed_group_ids: ['details-group'] } },
];
const request = (kind: string, id: string, cookie = adminCookie, query = '') => routes.request(`${base}/api/v1/admin/${kind}/${encodeURIComponent(id)}${query}`, { headers: { Cookie: cookie } }, { DB: testEnv.DB } as Env);

beforeEach(async () => {
  const now = Date.now();
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('details-group','Details','active',1,?,?)").bind(now, now).run();
  for (const [id, role, balance] of [['details-admin', 'admin', 0], ['details-user', 'user', -9007199254740991]] as const) {
    await testEnv.DB.prepare("INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at) VALUES(?,?,'PRIVATE PASSWORD HASH',?,'active','details-group',?,2,60,'admin',?,?)").bind(id, `${id}@example.invalid`, role, balance, now, now).run();
  }
  adminCookie = (await createCookieSession(testEnv.DB, 'details-admin', now)).setCookie.split(';')[0]!;
  userCookie = (await createCookieSession(testEnv.DB, 'details-user', now)).setCookie.split(';')[0]!;
  const ciphertext = JSON.stringify({ algorithm: 'A256GCM', format_version: 1, key_version: 'PRIVATE KEY VERSION', nonce: 'PRIVATE NONCE', ciphertext: 'PRIVATE CIPHERTEXT' });
  await testEnv.DB.prepare("INSERT INTO channels(id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at) VALUES('details-channel','Details','https://provider.example.invalid',?,'PRIVATE KEY VERSION','active',1,2,60,1,?,?)").bind(ciphertext, now, now).run();
  await testEnv.DB.prepare("INSERT INTO channel_groups(channel_id,group_id) VALUES('details-channel','details-group')").run();
  await testEnv.DB.prepare("INSERT INTO models(public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES('details/vendor:model','active','{\"input\":\"1\",\"output\":\"2\"}',1,0,4096,?,?)").bind(now, now).run();
});

describe.each(entities)('administrator $kind detail', entity => {
  it('requires a session and the administrator role through the Worker dispatcher', async () => {
    expect((await request(entity.kind, entity.id, '')).status).toBe(401);
    expect((await request(entity.kind, entity.id, userCookie)).status).toBe(403);
  });
  it('returns the safe projection without write configuration or credentials', async () => {
    const response = await request(entity.kind, entity.id);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const text = await response.text();
    expect(text).not.toMatch(/PRIVATE|password_hash|secret_ciphertext|secret_key_version|token_hash|upstreamKey/u);
    expect(JSON.parse(text).data).toMatchObject(entity.expected);
  });
  it('returns 404 for a missing entity and rejects unsupported query fields', async () => {
    expect((await request(entity.kind, 'details-missing')).status).toBe(404);
    expect((await request(entity.kind, entity.id, adminCookie, '?limit=20')).status).toBe(400);
  });
});
