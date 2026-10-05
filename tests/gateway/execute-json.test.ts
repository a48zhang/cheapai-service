import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeJson } from '../../apps/worker/gateway/execute-json';
import type { JsonExecutionAdapters } from '../../apps/worker/gateway/execute-json';
import { admitRequest } from '../../apps/worker/gateway/admit';
import { authenticatePlatformKey } from '../../apps/worker/auth/api-key-auth';
import type { InternalPlatformKeyAuth } from '../../apps/worker/auth/key-repository';
import { generateToken, hashToken } from '../../apps/worker/auth/tokens';
import * as settlement from '../../apps/worker/billing/settlement-repository';
import type { ProtocolRequest } from '../../packages/apicompat/capabilities/check';
import { testEnv } from '../helpers/database';

const now = 1_800_000_000_000;
let subject: InternalPlatformKeyAuth;
const request: ProtocolRequest = { protocol: 'chat', request: { model: 'g07-model', messages: [{ role: 'user', content: 'test prompt' }], max_completion_tokens: 1024 } };
const wire = { id: 'upstream_response_1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } };
function adapters(): JsonExecutionAdapters<unknown, unknown, unknown, Record<string, unknown>> {
  return {
    request: { from: 'chat', to: 'chat', convert: (input, context) => ({ ok: true, value: { ...(input as Record<string, unknown>), model: context.targetModel, messages: [{ role: 'user', content: 'converted' }] } }) },
    response: { from: 'chat', to: 'chat', convert: (_input, context) => ({ ok: true, value: {
      body: { id: context.identity.responseId, text: 'converted answer', usage: { input_tokens: 0, output_tokens: 0 } },
      identity: context.identity, terminal: { status: 'completed', reason: 'stop' },
    } }) },
  };
}
const admitted = () => admitRequest(testEnv, subject, request, { now: () => now, adapterAvailable: () => true });
const deps = (fetch: (url: string, init: RequestInit) => Promise<Response>) => ({ database: testEnv.DB, fetch, now: () => now });
const settleOptions = { settlement: { retryDelayMs: 0 } };
async function saved(id: string) {
  return { request: await testEnv.DB.prepare('SELECT execution_status,billing_status,usage_quality,cost_units,response_id FROM requests WHERE id=?').bind(id).first(),
    balance: await testEnv.DB.prepare("SELECT balance_units FROM users WHERE id='g07-user'").first('balance_units'),
    entries: (await testEnv.DB.prepare('SELECT * FROM billing_entries WHERE request_id=?').bind(id).all()).results };
}

describe('ordinary JSON execution with actual admission, D1 accounting and mock upstream', () => {
  beforeEach(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await testEnv.DB.prepare("INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES ('g07-group','G07 group','active',1,0,0)").run();
    await testEnv.DB.prepare(`INSERT INTO users (id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES ('g07-user','g07@example.invalid','test-only','user','active','g07-group',50000000,2,60,'admin',0,0)`).run();
    const token = generateToken('apiKey');
    await testEnv.DB.prepare("INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at) VALUES('g07-key','g07-user',?,'s2a_key_ABCDEFGH','G07 key','active',0,0)").bind(await hashToken('apiKey', token)).run();

    const credential = 'trusted-upstream';
    await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
      VALUES('g07-channel','G07 channel','https://provider.example.com',?,'active',1,2,60,1,0,0)`).bind(credential).run();
    await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('g07-model','active','{"input":"500","output":"500"}',1,0,4096,0,0)`).run();
    await testEnv.DB.prepare("INSERT INTO channel_groups(channel_id,group_id) VALUES('g07-channel','g07-group')").run();
    await testEnv.DB.prepare(`INSERT INTO channel_models(channel_id,public_model_id,protocol,upstream_model,capabilities_json,config_version)
      VALUES('g07-channel','g07-model','chat','provider-model','{"protocol":"chat","features":[],"maxOutputTokens":4096}',1)`).run();
    subject = await authenticatePlatformKey(testEnv.DB, new Request('https://gateway.example/v1/chat/completions', { headers: { Authorization: `Bearer ${token}` } }), now);
  });
  afterEach(() => vi.restoreAllMocks());

  it('settles original usage/original price before returning converted JSON and preserves native history ID', async () => {
    const admission = await admitted();
    await testEnv.DB.prepare("UPDATE models SET sell_prices_json=?,price_version=2 WHERE public_model_id='g07-model'").bind(JSON.stringify({ input: '999', output: '999' })).run();
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(init.body as string)).toMatchObject({ model: 'provider-model', stream: false, max_completion_tokens: 1024 });
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer trusted-upstream');
      return Response.json(wire, { headers: { 'x-request-id': 'upstream_request_1' } });
    });
    const result = await executeJson(deps(fetch), admission, adapters(), settleOptions);
    expect(result.body.id).toBe(`resp_${admission.request.id}`);
    expect(result.body.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(result.billingStatus).toBe('settled'); expect(result.cleanup.complete).toBe(true);
    const state = await saved(admission.request.id);
    expect(state.balance).toBe(-25_000_000);
    expect(state.request).toMatchObject({ execution_status: 'succeeded', billing_status: 'settled', cost_units: 75_000_000, response_id: 'upstream_response_1' });
    expect(state.entries).toHaveLength(1); expect(fetch).toHaveBeenCalledOnce();
  });

  it('confirms a lost settlement acknowledgement without replaying generation or double debit', async () => {
    const actual = settlement.settleConsumption;
    vi.spyOn(settlement, 'settleConsumption').mockImplementationOnce(async (...args) => { await actual(...args); throw new Error('lost acknowledgement'); });
    const admission = await admitted(); const fetch = vi.fn(async () => Response.json(wire));
    const result = await executeJson(deps(fetch), admission, adapters(), settleOptions);
    expect(result.billingStatus).toBe('settled'); expect(fetch).toHaveBeenCalledOnce();
    expect((await saved(admission.request.id)).entries).toHaveLength(1);
    await expect(executeJson(deps(fetch), admission, adapters(), settleOptions)).rejects.toMatchObject({ reason: 'already_started' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('marks a local conversion failure not_chargeable and never calls the upstream', async () => {
    const admission = await admitted(); const fetch = vi.fn(async () => Response.json(wire));
    const selected = adapters();
    selected.request = { ...selected.request, convert: () => ({ ok: false, error: { kind: 'unsupported_feature', code: 'unsupported', message: 'unsupported' } }) };
    await expect(executeJson(deps(fetch), admission, selected)).rejects.toMatchObject({ reason: 'conversion_failed', billingStatus: 'not_chargeable', cleanup: { complete: true } });
    expect(fetch).not.toHaveBeenCalled();
    expect((await saved(admission.request.id)).request).toMatchObject({ execution_status: 'failed', billing_status: 'not_chargeable', cost_units: null });
  });

  it('still settles incurred usage when response conversion fails', async () => {
    const admission = await admitted(); const selected = adapters();
    selected.response = { ...selected.response, convert: () => ({ ok: false, error: { kind: 'invalid_response', code: 'bad_output', message: 'invalid' } }) };
    await expect(executeJson(deps(async () => Response.json(wire)), admission, selected, settleOptions)).rejects.toMatchObject({ reason: 'conversion_failed', billingStatus: 'settled' });
    expect((await saved(admission.request.id)).request).toMatchObject({ execution_status: 'failed', billing_status: 'settled' });
    expect((await saved(admission.request.id)).balance).toBe(-25_000_000);
  });

  it('records unknown usage without inventing a zero-cost bill', async () => {
    const admission = await admitted();
    const { usage: _usage, ...withoutUsage } = wire;
    const result = await executeJson(deps(async () => Response.json(withoutUsage)), admission, adapters(), settleOptions);
    expect(result.billingStatus).toBe('usage_unknown');
    const state = await saved(admission.request.id);
    expect(state.balance).toBe(50_000_000); expect(state.entries).toEqual([]);
    expect(state.request).toMatchObject({ execution_status: 'succeeded', usage_quality: 'missing', cost_units: null, billing_status: 'usage_unknown' });
  });

  it('persists known recovery evidence if immediate settlement exhausts attempts', async () => {
    vi.spyOn(settlement, 'settleConsumption').mockRejectedValue(new Error('transient write failure'));
    const admission = await admitted(); const fetch = vi.fn(async () => Response.json(wire));
    const result = await executeJson(deps(fetch), admission, adapters(), { settlement: { maxAttempts: 1, retryDelayMs: 0 } });
    expect(result.billingStatus).toBe('settlement_pending'); expect(fetch).toHaveBeenCalledOnce();
    expect((await saved(admission.request.id)).request).toMatchObject({ execution_status: 'succeeded', usage_quality: 'complete', cost_units: 75_000_000, billing_status: 'settlement_pending' });
  });

  it('cancels before dispatch without charging and treats post-dispatch failure as uncertain usage', async () => {
    const admission = await admitted(); const controller = new AbortController(); controller.abort();
    const fetch = vi.fn(async () => Response.json(wire));
    await expect(executeJson(deps(fetch), admission, adapters(), { signal: controller.signal })).rejects.toMatchObject({ reason: 'cancelled', billingStatus: 'not_chargeable' });
    expect(fetch).not.toHaveBeenCalled();
    const next = await admitted();
    await expect(executeJson(deps(async () => { throw new Error('network uncertain'); }), next, adapters())).rejects.toMatchObject({ reason: 'upstream_failed', billingStatus: 'usage_unknown', cleanup: { complete: true } });
  });

  it('rejects fabricated request records and prevents concurrent reentry from releasing the winner lease', async () => {
    const admission = await admitted(); const fetch = vi.fn(async () => Response.json(wire));
    const results = await Promise.allSettled([executeJson(deps(fetch), admission, adapters(), settleOptions), executeJson(deps(fetch), admission, adapters(), settleOptions)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1); expect(fetch).toHaveBeenCalledOnce();
    await testEnv.DB.prepare("UPDATE users SET balance_units=50000000 WHERE id='g07-user'").run();
    const next = await admitted();
    await expect(executeJson(deps(fetch), { ...next, request: { ...next.request, id: 'fabricated' } }, adapters())).rejects.toMatchObject({ reason: 'admission_invalid' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('renews both real Gate leases while waiting for ordinary upstream JSON', async () => {
    const admission = await admitRequest(testEnv, subject, request, { now: () => now, adapterAvailable: () => true, leaseTtlMs: 120 });
    const userRenew = vi.spyOn(admission.lease.user.client, 'renew');
    const channelRenew = vi.spyOn(admission.lease.channel.client, 'renew');
    const result = await executeJson(deps(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); return Response.json(wire); }), admission, adapters(), settleOptions);
    expect(userRenew).toHaveBeenCalled(); expect(channelRenew).toHaveBeenCalled();
    expect(result.cleanup.complete).toBe(true);
  });
  it('records cancellation after dispatch as unknown usage without generating again', async () => {
    const admission = await admitted(); const controller = new AbortController();
    const fetch = vi.fn(() => { setTimeout(() => controller.abort(), 10); return new Promise<Response>(() => undefined); });
    await expect(executeJson(deps(fetch), admission, adapters(), { signal: controller.signal })).rejects.toMatchObject({ reason: 'cancelled', billingStatus: 'usage_unknown', cleanup: { complete: true } });
    expect(fetch).toHaveBeenCalledOnce();
    expect((await saved(admission.request.id)).request).toMatchObject({ execution_status: 'cancelled', billing_status: 'usage_unknown', cost_units: null });
  });
  it('does not claim a billing-state write succeeded when D1 changed zero rows, but still finishes execution', async () => {
    const admission = await admitted(); const selected = adapters();
    selected.request = { ...selected.request, convert: () => ({ ok: false, error: { kind: 'unsupported_feature', code: 'unsupported', message: 'unsupported' } }) };
    await testEnv.DB.exec("CREATE TRIGGER g07_ignore_billing BEFORE UPDATE OF billing_status ON requests BEGIN SELECT RAISE(IGNORE); END;");
    const fetch = vi.fn(async () => Response.json(wire));
    await expect(executeJson(deps(fetch), admission, selected)).rejects.toMatchObject({ reason: 'service_failure', billingStatus: 'awaiting_usage', cleanup: { complete: true } });
    expect((await saved(admission.request.id)).request).toMatchObject({ execution_status: 'failed', billing_status: 'awaiting_usage' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
