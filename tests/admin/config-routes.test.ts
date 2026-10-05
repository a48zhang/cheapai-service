import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../../apps/worker/app';
import type { Env } from '../../apps/worker/env';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { issueCsrfToken } from '../../apps/worker/auth/csrf';
import { testEnv } from '../helpers/database';

const origin = 'https://console.example';
const actor = 'c17-admin';
const ordinary = 'c17-user';
let env: Env;
const cookies = new Map<string, string>();
const channelInput = { name: 'C17 Channel', baseUrl: 'https://provider.example.invalid', upstreamKey: 'c17-local-upstream-secret', concurrencyLimit: 2, rpmLimit: 60 };
const modelInput = { publicModelId: 'c17-model', sellPrices: { input: '1', output: '2' }, admissionMinBalanceUnits: '0', maxOutputTokens: 4096 };
function call(path: string, options: { method?: string; body?: unknown; actor?: string; bindings?: Env; headers?: Record<string, string> } = {}) {
  const method = options.method ?? 'GET';
  const csrf = issueCsrfToken();
  const cookie = cookies.get(options.actor ?? actor);
  return app.fetch(new Request(origin + path, { method,
    headers: { ...(cookie ? { Cookie: `${cookie}; ${csrf.setCookie.split(';')[0]}` } : {}),
      ...(method === 'GET' ? {} : { Origin: origin, 'X-CSRF-Token': csrf.token }),
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }), options.bindings ?? env);
}
async function data<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status); expect(response.headers.get('Cache-Control')).toBe('no-store');
  return (await response.json<{ data: T }>()).data;
}
async function channel() { return data<{ id: string; configVersion: number }>(await call('/api/v1/admin/channels', { method: 'POST', body: channelInput }), 201); }
beforeEach(async () => {
  cookies.clear();
  env = { ...testEnv, ENVIRONMENT: 'local', PUBLIC_BASE_URL: origin, EMAIL_VERIFICATION_READY: false };
  const now = Date.now();
  for (const [id, role] of [[actor, 'admin'], [ordinary, 'user']] as const) {
    await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES(?,?,?,?,'active','default',2,60,'bootstrap',?,?)`).bind(id, `${id}@example.invalid`, 'test-only-hash', role, now, now).run();
    cookies.set(id, (await createCookieSession(testEnv.DB, id, Date.now())).setCookie.split(';')[0]!);
  }
});

describe('configuration CRUD through the real app entry', () => {
  it('creates and updates channels, groups, models and mappings with safe output and versioned audit', async () => {
    const createdChannel = await channel();
    const group = await data<{ id: string; channelIds: string[] }>(await call('/api/v1/admin/groups', { method: 'POST', body: { name: 'C17 Group', channelIds: [createdChannel.id] } }), 201);
    expect(group.channelIds).toEqual([createdChannel.id]);
    await data(await call(`/api/v1/admin/groups/${group.id}`, { method: 'PATCH', body: { version: 1, name: 'C17 Renamed Group' } }));
    const model = await data<{ priceVersion: number; sellPrices: { input: string } }>(await call('/api/v1/admin/models', { method: 'POST', body: modelInput }), 201);
    expect(model.priceVersion).toBe(1); expect(model.sellPrices.input).toBe('1');
    const mappingPath = '/api/v1/admin/models/c17-model/mappings';
    const mapping = await data<{ configVersion: number }>(await call(mappingPath, { method: 'POST', body: {
      channelId: createdChannel.id, protocol: 'chat', upstreamModel: 'upstream-model', capabilities: { protocol: 'chat', features: [], maxOutputTokens: 4096 },
    } }), 201);
    expect(mapping.configVersion).toBe(1);
    await data(await call(`${mappingPath}/${createdChannel.id}/chat`, { method: 'PATCH', body: { version: 1, upstreamModel: 'changed-upstream' } }));
    expect((await call(`${mappingPath}/${createdChannel.id}/chat`, { method: 'PATCH', body: { version: 1, upstreamModel: 'stale' } })).status).toBe(409);
    const updatedModel = await data<{ priceVersion: number }>(await call('/api/v1/admin/models/c17-model', { method: 'PATCH', body: { version: 1, sellPrices: { input: '3', output: '4' } } }));
    expect(updatedModel.priceVersion).toBe(2);
    await data(await call(`/api/v1/admin/channels/${createdChannel.id}`, { method: 'PATCH', body: { version: 1, status: 'disabled' } }));
    for (const path of ['/api/v1/admin/channels', '/api/v1/admin/groups', '/api/v1/admin/models', mappingPath]) {
      const output = JSON.stringify(await data(await call(path)));
      expect(output).not.toContain(channelInput.upstreamKey);
      expect(output).not.toMatch(/upstream_key/);
    }
    const audits = (await testEnv.DB.prepare('SELECT action,redacted_change_json FROM admin_audit WHERE actor_id=?').bind(actor).all()).results;
    expect(audits.map(item => item.action)).toEqual(expect.arrayContaining(['channel.create', 'channel.update', 'group.create', 'group.update', 'model.create', 'model.update']));
    expect(JSON.stringify(audits)).not.toContain(channelInput.upstreamKey);
    expect(await testEnv.DB.prepare('SELECT config_version FROM channel_models WHERE channel_id=?').bind(createdChannel.id).first()).toEqual({ config_version: 2 });
  });

  it('creates and replaces stored credentials without an encryption configuration', async () => {
    const created = await channel();
    expect(await testEnv.DB.prepare('SELECT upstream_key FROM channels WHERE id=?').bind(created.id).first('upstream_key')).toBe(channelInput.upstreamKey);
    await data(await call(`/api/v1/admin/channels/${created.id}`, { method: 'PATCH', body: { version: 1, upstreamKey: 'c17-new-local-secret' } }));
    expect(await testEnv.DB.prepare('SELECT upstream_key FROM channels WHERE id=?').bind(created.id).first('upstream_key')).toBe('c17-new-local-secret');
  });

  it('enforces cross-role/Origin/CSRF protection and preserves unknown-path JSON404', async () => {
    for (const path of ['/api/v1/admin/channels', '/api/v1/admin/groups', '/api/v1/admin/models', '/api/v1/admin/models/c17-model/mappings']) {
      expect((await call(path, { actor: ordinary })).status).toBe(403);
      expect((await call(path, { method: 'POST', body: {}, headers: { Origin: 'https://evil.example' } })).status).toBe(403);
      expect((await call(path, { method: 'POST', body: {}, headers: { 'X-CSRF-Token': '' } })).status).toBe(403);
    }
    for (const path of ['/api/v1/admin/channels/missing/extra', '/api/v1/admin/groups/missing/extra', '/api/v1/admin/models/c17-model/mappings/extra/extra/more']) {
      const response = await call(path); expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
    }
  });

  it('rolls back a mounted configuration update and its audit on failure', async () => {
    const created = await channel();
    await testEnv.DB.exec("CREATE TRIGGER c17_fail_audit BEFORE INSERT ON admin_audit WHEN NEW.action='channel.update' BEGIN SELECT RAISE(ABORT,'PRIVATE AUDIT DETAIL'); END");
    const response = await call(`/api/v1/admin/channels/${created.id}`, { method: 'PATCH', body: { version: 1, name: 'Must roll back' } });
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('PRIVATE');
    expect(await testEnv.DB.prepare('SELECT name,config_version FROM channels WHERE id=?').bind(created.id).first()).toEqual({ name: channelInput.name, config_version: 1 });
  });
});
