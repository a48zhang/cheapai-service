import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../../apps/worker/app';
import type { Env } from '../../apps/worker/env';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { issueCsrfToken } from '../../apps/worker/auth/csrf';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const origin = 'https://console.example';
const owner = 'billing-entry-owner'; const admin = 'billing-entry-admin';
let ownerCookie: string; let adminCookie: string;
const bindings = (): Env => ({ ...testEnv, ENVIRONMENT: 'local', PUBLIC_BASE_URL: origin });
const invoke = (path: string, init: RequestInit = {}, env = bindings()) => app.fetch(new Request(origin + path, init), env);
function writeHeaders(cookie: string, operation: string) {
  const csrf = issueCsrfToken();
  return { 'Content-Type': 'application/json', Origin: origin, Cookie: `${cookie}; ${csrf.setCookie.split(';')[0]}`,
    'X-CSRF-Token': csrf.token, 'Idempotency-Key': operation };
}
beforeEach(async () => {
  const now = Date.now();
  for (const id of [owner, admin]) await prepare(testEnv.DB, `INSERT INTO users
    (id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES (?,?,'fixture-not-for-login',?,'active','default',0,2,60,'bootstrap',?,?)`,
  [id, `${id}@example.invalid`, id === admin ? 'admin' : 'user', now, now]).run();
  ownerCookie = (await createCookieSession(testEnv.DB, owner, now)).setCookie.split(';')[0]!;
  adminCookie = (await createCookieSession(testEnv.DB, admin, now)).setCookie.split(';')[0]!;
});

describe('production billing entry integration with native D1', () => {
  it('grants once, replays without a second grant, permits negative adjustment and exposes exact owner ledger', async () => {
    const path = `/api/v1/admin/users/${owner}/balance-adjustments`;
    const headers = writeHeaders(adminCookie, 'grant-integration-1');
    const grant = { kind: 'grant', deltaUnits: '100', reason: 'Local integration fixture' };
    expect((await invoke(path, { method: 'POST', headers, body: JSON.stringify(grant) })).status).toBe(201);
    expect((await invoke(path, { method: 'POST', headers, body: JSON.stringify(grant) })).status).toBe(200);
    expect((await invoke(path, { method: 'POST', headers, body: JSON.stringify({ ...grant, deltaUnits: '101' }) })).status).toBe(409);
    const adjustment = await invoke(path, { method: 'POST', headers: writeHeaders(adminCookie, 'adjust-integration-2'),
      body: JSON.stringify({ kind: 'adjustment', deltaUnits: '-150', reason: 'Signed adjustment fixture' }) });
    expect(adjustment.status).toBe(201);
    const balance = await invoke('/api/v1/account/balance', { headers: { Cookie: ownerCookie } });
    expect(await balance.json()).toMatchObject({ data: { balance_units: '-50', balance_usd: '-0.00000050', currency: 'USD', decimals: 8 } });
    expect(balance.headers.get('Cache-Control')).toBe('no-store');
    const entries = await invoke('/api/v1/billing/entries', { headers: { Cookie: ownerCookie } });
    const page = await entries.json<{ data: { items: { deltaUnits: string }[] } }>();
    expect(page.data.items.map(item => item.deltaUnits).sort()).toEqual(['-150', '100']);
    expect(await (await invoke('/api/v1/billing/entries', { headers: { Cookie: adminCookie } })).json()).toMatchObject({ data: { items: [] } });
    const global = await invoke(`/api/v1/admin/billing/entries?userId=${owner}`, { headers: { Cookie: adminCookie } });
    expect((await global.json<{ data: { items: unknown[] } }>()).data.items).toHaveLength(2);
  });

  it('authenticates before write config, keeps reads independent, and never reads unrelated Secrets', async () => {
    const env = bindings(); delete env.PUBLIC_BASE_URL;
    Object.defineProperty(env, 'CHANNEL_KEYRING_JSON', { enumerable: true, get() { throw new Error('Secret must remain unread'); } });
    for (const path of ['/api/v1/account/balance', '/api/v1/billing/entries', '/api/v1/admin/billing/entries']) {
      expect((await invoke(path, {}, env)).status).toBe(401);
    }
    const path = `/api/v1/admin/users/${owner}/balance-adjustments`;
    expect((await invoke(path, { method: 'POST' }, env)).status).toBe(401);
    expect((await invoke(path, { method: 'POST', headers: writeHeaders(ownerCookie, 'denied') }, env)).status).toBe(403);
    expect((await invoke(path, { method: 'POST', headers: writeHeaders(adminCookie, 'no-origin') }, env)).status).toBe(503);
    expect((await invoke('/api/v1/account/balance', { headers: { Cookie: ownerCookie } }, env)).status).toBe(200);
    expect((await invoke('/api/v1/billing/entries?userId=billing-entry-admin', { headers: { Cookie: ownerCookie } }, env)).status).toBe(400);
    expect((await invoke('/api/v1/admin/billing/entries', { headers: { Cookie: ownerCookie } }, env)).status).toBe(403);
  });

  it('does not publish a successful adjustment if its atomic audit fails', async () => {
    await testEnv.DB.exec("CREATE TRIGGER fail_billing_entry_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
    const response = await invoke(`/api/v1/admin/users/${owner}/balance-adjustments`, { method: 'POST',
      headers: writeHeaders(adminCookie, 'audit-failure'), body: JSON.stringify({ kind: 'grant', deltaUnits: '100', reason: 'Audit failure fixture' }) });
    expect(response.status).toBe(503);
    expect(await (await invoke('/api/v1/account/balance', { headers: { Cookie: ownerCookie } })).json()).toMatchObject({ data: { balance_units: '0' } });
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first()).toEqual({ n: 0 });
  });
});
