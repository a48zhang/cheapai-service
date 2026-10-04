import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupExpiredIdentityData } from '../../apps/worker/scheduled/cleanup';
import { testEnv } from '../helpers/database';

async function session(index: number, expiry = 1000, revoked: number | null = null) {
  await testEnv.DB.prepare('INSERT INTO sessions(id,user_id,token_hash,expires_at,revoked_at,created_at) VALUES(?,?,?,?,?,0)')
    .bind(`cleanup-session-${index}`, 'cleanup-admin', index.toString(16).padStart(64, '0'), expiry, revoked).run();
}
async function challenge(index: number, expiry = 1000) {
  await testEnv.DB.prepare(`INSERT INTO email_challenges(id,email_normalized,purpose,code_mac,expires_at,created_at,updated_at,send_requested_at)
    VALUES(?,?,'registration',?,?,0,0,0)`).bind(`cleanup-challenge-${index}`, `cleanup-${index}@example.invalid`, 'a'.repeat(64), expiry).run();
}
beforeEach(async () => {
  await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES('cleanup-admin','cleanup-admin@example.invalid','test-only','admin','active','default',2,60,'bootstrap',0,0)`).run();
});

describe('bounded native D1 identity cleanup', () => {
  it('deletes expiration==cutoff but preserves future expiries including revoked sessions', async () => {
    await session(1, 999); await session(2, 1000); await session(3, 1001); await session(4, 2000, 500);
    await challenge(1, 1000); await challenge(2, 1001);
    expect(await cleanupExpiredIdentityData(testEnv.DB, 1000)).toEqual({ cutoff: 1000, sessionsDeleted: 2, challengesDeleted: 1, moreSessions: false, moreChallenges: false, desktopSessionCiphertextsCleared: 0, moreDesktopSessionCiphertexts: false });
    expect((await testEnv.DB.prepare('SELECT id FROM sessions ORDER BY id').all()).results).toEqual([{ id: 'cleanup-session-3' }, { id: 'cleanup-session-4' }]);
    expect((await testEnv.DB.prepare('SELECT id FROM email_challenges').all()).results).toEqual([{ id: 'cleanup-challenge-2' }]);
  });
  it('drains bounded pages without skipping ties and is idempotent on empty pages', async () => {
    for (let index = 1; index <= 5; index++) { await session(index); await challenge(index); }
    expect(await cleanupExpiredIdentityData(testEnv.DB, 1000, { limit: 2 })).toMatchObject({ sessionsDeleted: 2, challengesDeleted: 2, moreSessions: true, moreChallenges: true });
    expect(await cleanupExpiredIdentityData(testEnv.DB, 1000, { limit: 2 })).toMatchObject({ sessionsDeleted: 2, challengesDeleted: 2, moreSessions: true, moreChallenges: true });
    expect(await cleanupExpiredIdentityData(testEnv.DB, 1000, { limit: 2 })).toMatchObject({ sessionsDeleted: 1, challengesDeleted: 1, moreSessions: false, moreChallenges: false });
    expect(await cleanupExpiredIdentityData(testEnv.DB, 1000)).toMatchObject({ sessionsDeleted: 0, challengesDeleted: 0 });
  });
  it('does not delete a challenge refreshed beyond the fixed cutoff', async () => {
    await challenge(1); await challenge(2);
    await testEnv.DB.prepare("UPDATE email_challenges SET generation=2,expires_at=2000,updated_at=900,send_requested_at=900 WHERE id='cleanup-challenge-1'").run();
    expect((await cleanupExpiredIdentityData(testEnv.DB, 1000)).challengesDeleted).toBe(1);
    expect(await testEnv.DB.prepare("SELECT generation,expires_at FROM email_challenges WHERE id='cleanup-challenge-1'").first()).toEqual({ generation: 2, expires_at: 2000 });
  });
  it('allows overlapping invocations while each remains page bounded', async () => {
    for (let index = 1; index <= 6; index++) { await session(index); await challenge(index); }
    const results = await Promise.all([cleanupExpiredIdentityData(testEnv.DB, 1000, { limit: 2 }), cleanupExpiredIdentityData(testEnv.DB, 1000, { limit: 2 })]);
    expect(results.every(result => result.sessionsDeleted <= 2 && result.challengesDeleted <= 2)).toBe(true);
    expect(results.reduce((sum, result) => sum + result.sessionsDeleted, 0)).toBe(4);
    expect(results.reduce((sum, result) => sum + result.challengesDeleted, 0)).toBe(4);
  });
  it('preserves used-code history, batch/Key idempotency anchors, unsettled requests and the ledger', async () => {
    await testEnv.DB.prepare(`INSERT INTO registration_code_batches(id,actor_id,operation_id,fingerprint,quantity,expires_at,created_at)
      VALUES('cleanup-batch','cleanup-admin','cleanup-op',?,1,500,0)`).bind('b'.repeat(64)).run();
    await testEnv.DB.prepare(`INSERT INTO registration_codes(id,code_hash,display_prefix,expires_at,used_by,used_at,created_by,created_at,operation_id,ordinal)
      VALUES('cleanup-code',?,'s2a_invite_ABCDEFGH',500,'cleanup-admin',100,'cleanup-admin',0,'cleanup-batch',0)`).bind('c'.repeat(64)).run();
    await testEnv.DB.prepare(`INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,expires_at,created_at,updated_at,creation_operation_id,creation_fingerprint)
      VALUES('cleanup-key','cleanup-admin',?,'s2a_key_ABCDEFGH','cleanup','revoked',500,0,0,'cleanup-key-op',?)`).bind('d'.repeat(64), 'e'.repeat(64)).run();
    await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
      VALUES('cleanup-channel','cleanup','https://example.invalid',?,'test','active',1,2,60,1,0,0)`).bind(JSON.stringify({ algorithm: 'A256GCM', format_version: 1, key_version: 'test', nonce: 'fixture', ciphertext: 'fixture' })).run();
    await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('cleanup-model','active','{"input":"1","output":"2"}',1,0,4096,0,0)`).run();
    await testEnv.DB.prepare(`INSERT INTO requests(id,user_id,api_key_id,channel_id,public_model_id,upstream_model,downstream_protocol,upstream_protocol,price_snapshot,created_at,updated_at)
      VALUES('cleanup-request','cleanup-admin','cleanup-key','cleanup-channel','cleanup-model','upstream','chat','chat','{}',0,0)`).run();
    await testEnv.DB.prepare(`INSERT INTO billing_entries(id,operation_id,kind,user_id,delta_units,fingerprint,created_by,reason,created_at)
      VALUES('cleanup-entry','cleanup-ledger-op','grant','cleanup-admin',1,'fingerprint','cleanup-admin','Fixture grant',0)`).run();
    await session(1); await challenge(1);
    await cleanupExpiredIdentityData(testEnv.DB, 1000);
    expect(await testEnv.DB.prepare("SELECT used_by,used_at FROM registration_codes WHERE id='cleanup-code'").first()).toEqual({ used_by: 'cleanup-admin', used_at: 100 });
    expect(await testEnv.DB.prepare("SELECT id FROM registration_code_batches WHERE id='cleanup-batch'").first()).toEqual({ id: 'cleanup-batch' });
    expect(await testEnv.DB.prepare("SELECT creation_operation_id FROM api_keys WHERE id='cleanup-key'").first()).toEqual({ creation_operation_id: 'cleanup-key-op' });
    expect(await testEnv.DB.prepare("SELECT billing_status,cost_units FROM requests WHERE id='cleanup-request'").first()).toEqual({ billing_status: 'awaiting_usage', cost_units: null });
    expect(await testEnv.DB.prepare("SELECT operation_id FROM billing_entries WHERE id='cleanup-entry'").first()).toEqual({ operation_id: 'cleanup-ledger-op' });
  });
  it('rejects unsafe cutoffs and unbounded page sizes', async () => {
    for (const now of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) await expect(cleanupExpiredIdentityData(testEnv.DB, now)).rejects.toMatchObject({ code: 'invalid_request' });
    for (const limit of [0, -1, 1.5, 101]) await expect(cleanupExpiredIdentityData(testEnv.DB, 1000, { limit })).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
