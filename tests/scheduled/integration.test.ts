import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import worker, { Gate } from '../../apps/worker/index';
import { runScheduledMaintenance } from '../../apps/worker/scheduled/index';
import * as settlements from '../../apps/worker/scheduled/settlements';
import * as cleanup from '../../apps/worker/scheduled/cleanup';
import { saveSettlementRecovery } from '../../apps/worker/billing/recovery';
import { createPriceSnapshot } from '../../apps/worker/billing/fingerprint';
import { encryptChannelSecret } from '../../apps/worker/admin/channel-secrets';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import type { UsageSnapshot } from '../../packages/apicompat/types/shared';
import { testEnv } from '../helpers/database';

const now = 2_000_000;
let price: string;
const usage: UsageSnapshot = { quality: 'complete', protocol: 'chat', counts: { inputTokens: 1000, outputTokens: 500 },
  semantics: { cacheRead: 'included_in_input', cacheWrite: 'included_in_input', reasoning: 'included_in_output', cacheWriteTtl: 'unknown' }, sources: [{ protocol: 'chat', path: 'usage' }], issues: [] };
async function request(id: string) {
  await testEnv.DB.prepare(`INSERT INTO requests(id,user_id,api_key_id,channel_id,public_model_id,upstream_model,downstream_protocol,upstream_protocol,price_snapshot,created_at,updated_at)
    VALUES(?,'b21-user','b21-key','b21-channel','b21-model','provider','chat','chat',?,0,0)`).bind(id, price).run();
}
beforeEach(async () => {
  vi.restoreAllMocks();
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('b21-group','Fixture','active',1,0,0)").run();
  await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES('b21-user','b21@example.invalid','synthetic','user','active','b21-group',100000,1,60,'admin',0,0)`).run();
  await testEnv.DB.prepare("INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at) VALUES('b21-key','b21-user',?,'s2a_key_ABCDEFGH','Fixture','active',0,0)").bind('1'.repeat(64)).run();
  const encrypted = await encryptChannelSecret('synthetic', 'b21-channel', 'v1', crypto.getRandomValues(new Uint8Array(32)));
  await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES('b21-channel','Fixture','https://example.invalid',?,'v1','active',0,1,60,1,0,0)`).bind(encrypted).run();
  await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('b21-model','active','{"input":"1","output":"2"}',1,0,10,0,0)`).run();
  price = createPriceSnapshot({ publicModelId: 'b21-model', upstreamModel: 'provider', upstreamProtocol: 'chat', priceVersion: 1, sellPrices: { input: '1', output: '2' } }).json;
  await request('known'); await request('lost');
  await saveSettlementRecovery(testEnv.DB, { requestId: 'known', userId: 'b21-user', usage }, 1000);
  await createCookieSession(testEnv.DB, 'b21-user', 1000, { sessionTtlMs: 60000 });
  await createCookieSession(testEnv.DB, 'b21-user', 1000, { sessionTtlMs: 120000 });
});

describe('B21 same-Worker scheduled orchestration', () => {
  it('runs one bounded real D1 page for settlement, abandonment and identity cleanup', async () => {
    const context = createExecutionContext();
    const result = await runScheduledMaintenance(testEnv.DB, context, { now: () => now, cleanupLimit: 1 });
    await waitOnExecutionContext(context);
    expect(result.settlements).toMatchObject({ status: 'completed', result: { settled: 1 } });
    expect(result.abandoned).toMatchObject({ status: 'completed', result: { abandoned: 1 } });
    expect(result.cleanup).toMatchObject({ status: 'completed', result: { sessionsDeleted: 1, moreSessions: true } });
    expect(result.uncertain).toBe(false);
    expect(await testEnv.DB.prepare("SELECT billing_status FROM requests WHERE id='known'").first('billing_status')).toBe('settled');
    expect(await testEnv.DB.prepare("SELECT billing_status FROM requests WHERE id='lost'").first('billing_status')).toBe('usage_unknown');
  });

  it('retains other task outcomes when one task fails without exposing its exception', async () => {
    vi.spyOn(settlements, 'retryPendingSettlements').mockRejectedValue(new Error('PRIVATE_FAILURE'));
    const context = createExecutionContext();
    const result = await runScheduledMaintenance(testEnv.DB, context, { now: () => now });
    await waitOnExecutionContext(context);
    expect(result.settlements).toEqual({ status: 'failed', code: 'service_unavailable' });
    expect(result.cleanup).toMatchObject({ status: 'completed', result: { sessionsDeleted: 2 } });
    expect(result.abandoned).toMatchObject({ status: 'completed', result: { abandoned: 1 } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_FAILURE');
  });

  it('associates settlement in-flight promises with waitUntil and reports uncertainty', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(settlements, 'retryPendingSettlements').mockResolvedValue({ selected: 1, claimed: 1, settled: 0, pending: 1, skipped: 0, invalid: 0, inFlight: [pending] });
    const owned: Promise<unknown>[] = [];
    const result = await runScheduledMaintenance(testEnv.DB, { waitUntil: promise => { owned.push(promise); } }, { now: () => now });
    expect(result.uncertain).toBe(true);
    expect(result.settlements).toMatchObject({ status: 'completed', result: { inFlightCount: 1 } });
    expect(owned.length).toBeGreaterThanOrEqual(4);
    release(); await Promise.all(owned);
  });

  it('bounds a hanging task while retaining completed siblings and owning late work', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(cleanup, 'cleanupExpiredIdentityData').mockImplementation(async () => { await pending; return { cutoff: now, sessionsDeleted: 0, challengesDeleted: 0, moreSessions: true, moreChallenges: false }; });
    const context = createExecutionContext();
    const result = await runScheduledMaintenance(testEnv.DB, context, { now: () => now, budgetMs: 150 });
    expect(result.cleanup.status).toBe('uncertain'); expect(result.uncertain).toBe(true);
    expect(result.abandoned.status).toBe('completed');
    release(); await waitOnExecutionContext(context);
  });

  it('exports scheduled beside unchanged fetch/Gate and uses processing time rather than scheduledTime', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const context = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: 1, cron: '*/5 * * * *' }), testEnv, context);
    await waitOnExecutionContext(context);
    expect(log).toHaveBeenCalledWith('scheduled_maintenance', expect.objectContaining({ processedAt: now }));
    expect(typeof Gate).toBe('function');
    const response = await worker.fetch(new Request('https://local.test/healthz'), testEnv, context);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ status: 'ok' });
  });
});
