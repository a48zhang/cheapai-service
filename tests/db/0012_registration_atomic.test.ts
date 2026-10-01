import { beforeEach, describe, expect, it } from 'vitest';
import { prepare } from '../../apps/worker/db';
import type { DbValue } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

let now: number;
const group = 'd12-group';
const creator = 'd12-admin';
const codeId = 'd12-code';
const email = 'd12-user@example.invalid';
const mac = 'a1'.repeat(32);

async function policy(mode = 'open', verify = false) {
  await prepare(testEnv.DB, `INSERT INTO settings (key,value_json,version,updated_at) VALUES (?, ?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,version=settings.version+1,updated_at=excluded.updated_at`,
    ['registration', JSON.stringify({ registrationMode: mode, emailVerificationEnabled: verify }), now]).run();
}
function register(overrides: Record<string, DbValue> = {}) {
  const row = { id: 'd12-user', email_normalized: email, password_hash: 'test-only-hash', role: 'user', status: 'active',
    group_id: group, balance_units: 0, concurrency_limit: 2, rpm_limit: 60, created_via: 'registration',
    created_at: now, updated_at: now, ...overrides };
  const columns = Object.keys(row);
  return prepare(testEnv.DB, `INSERT INTO users (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')}) RETURNING id`, Object.values(row)).run();
}
async function invitation() {
  await prepare(testEnv.DB, `INSERT INTO registration_codes
    (id,code_hash,display_prefix,expires_at,created_by,created_at,operation_id,ordinal) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    [codeId, 'b2'.repeat(32), 's2a_invite_ABCDEFGH', now + 600_000, creator, now - 1, 'd12-operation']).run();
}
async function challenge() {
  await prepare(testEnv.DB, `INSERT INTO email_challenges
    (id,email_normalized,purpose,generation,code_mac,expires_at,attempts,send_status,created_at,updated_at,send_requested_at)
    VALUES (?, ?, 'registration', 2, ?, ?, 0, 'accepted', ?, ?, ?)`,
    ['d12-challenge', email, mac, now + 600_000, now - 60_000, now, now - 60_000]).run();
}
async function absent(id = 'd12-user') {
  expect(await prepare(testEnv.DB, 'SELECT id FROM users WHERE id=?', [id]).first()).toBeNull();
}

beforeEach(async () => {
  now = Date.now();
  await prepare(testEnv.DB, 'INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES (?,?,?,1,?,?)',
    [group, 'D12 Group', 'active', now, now]).run();
  await prepare(testEnv.DB, `INSERT INTO settings (key,value_json,version,updated_at) VALUES ('default_group_id',?,1,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`, [JSON.stringify(group), now]).run();
  await policy();
  await register({ id: creator, email_normalized: 'd12-admin@example.invalid', role: 'admin', created_via: 'bootstrap' });
});

describe('atomic registration guards and consumption on native D1', () => {
  it('allows open registration only as an unverified zero-balance ordinary user', async () => {
    expect((await register()).rows).toEqual([{ id: 'd12-user' }]);
    expect(await prepare(testEnv.DB, 'SELECT role,balance_units,email_verified_at FROM users WHERE id=?', ['d12-user']).first())
      .toEqual({ role: 'user', balance_units: 0, email_verified_at: null });
  });

  it('fails closed for missing, malformed or closed registration policies', async () => {
    for (const value of ['{}', 'null', '[]', '{"registrationMode":"open","emailVerificationEnabled":"false"}', '{"registrationMode":"other","emailVerificationEnabled":false}']) {
      await prepare(testEnv.DB, 'UPDATE settings SET value_json=? WHERE key=?', [value, 'registration']).run();
      await expect(register()).rejects.toThrow('registration_policy_rejected');
    }
    await policy('closed');
    await expect(register()).rejects.toThrow('registration_policy_rejected');
    await prepare(testEnv.DB, 'DELETE FROM settings WHERE key=?', ['registration']).run();
    await expect(register()).rejects.toThrow('registration_policy_rejected');
    await absent();
  });

  it('rejects elevated role, nonzero balance, wrong/disabled default group and fake verification', async () => {
    await expect(register({ role: 'admin' })).rejects.toThrow('registration_policy_rejected');
    await expect(register({ balance_units: 1 })).rejects.toThrow('registration_policy_rejected');
    await expect(register({ balance_units: -1 })).rejects.toThrow('registration_policy_rejected');
    await expect(register({ group_id: 'other' })).rejects.toThrow('registration_policy_rejected');
    await expect(register({ email_verified_at: now })).rejects.toThrow('registration_email_rejected');
    await expect(register({ registration_code_id: codeId })).rejects.toThrow('registration_invitation_rejected');
    await prepare(testEnv.DB, 'UPDATE groups SET status=? WHERE id=?', ['disabled', group]).run();
    await expect(register()).rejects.toThrow('registration_policy_rejected');
    await absent();
  });

  it('requires a valid unused invitation and consumes it in the user insertion', async () => {
    await policy('invite');
    await expect(register()).rejects.toThrow('registration_invitation_rejected');
    await invitation();
    await prepare(testEnv.DB, 'UPDATE registration_codes SET revoked_at=? WHERE id=?', [now, codeId]).run();
    await expect(register({ registration_code_id: codeId })).rejects.toThrow('registration_invitation_rejected');
    await prepare(testEnv.DB, 'UPDATE registration_codes SET revoked_at=NULL WHERE id=?', [codeId]).run();
    expect((await register({ registration_code_id: codeId })).rows).toEqual([{ id: 'd12-user' }]);
    await expect(register({ id: 'd12-reuse', email_normalized: 'd12-reuse@example.invalid', registration_code_id: codeId }))
      .rejects.toThrow('registration_invitation_rejected');
  });

  it('rejects an expired code even if the INSERT backdates the user timestamp', async () => {
    await policy('invite'); await invitation();
    await prepare(testEnv.DB, 'UPDATE registration_codes SET created_at=?,expires_at=? WHERE id=?', [now - 120_000, now - 60_000, codeId]).run();
    await expect(register({ registration_code_id: codeId, created_at: now - 90_000 })).rejects.toThrow('registration_invitation_rejected');
    await absent();
  });

  it('requires the current accepted, unexpired, unconsumed challenge and a matching verification timestamp', async () => {
    await policy('open', true);
    await expect(register({ email_verified_at: now })).rejects.toThrow('registration_email_rejected');
    await challenge();
    await expect(register()).rejects.toThrow('registration_email_rejected');
    await expect(register({ email_verified_at: now - 1 })).rejects.toThrow('registration_email_rejected');
    for (const state of ['sending', 'failed', 'unknown']) {
      await prepare(testEnv.DB, 'UPDATE email_challenges SET send_status=? WHERE id=?', [state, 'd12-challenge']).run();
      await expect(register({ email_verified_at: now })).rejects.toThrow('registration_email_rejected');
    }
    await prepare(testEnv.DB, "UPDATE email_challenges SET send_status='accepted',attempts=5 WHERE id=?", ['d12-challenge']).run();
    await expect(register({ email_verified_at: now })).rejects.toThrow('registration_email_rejected');
    await prepare(testEnv.DB, 'UPDATE email_challenges SET attempts=0,consumed_at=? WHERE id=?', [now, 'd12-challenge']).run();
    await expect(register({ email_verified_at: now })).rejects.toThrow('registration_email_rejected');
    await prepare(testEnv.DB, 'UPDATE email_challenges SET consumed_at=NULL,expires_at=? WHERE id=?', [now - 1, 'd12-challenge']).run();
    await expect(register({ email_verified_at: now })).rejects.toThrow('registration_email_rejected');
    await absent();
  });

  it('atomically consumes both credentials after one successful invite registration', async () => {
    await policy('invite', true); await invitation(); await challenge();
    expect((await register({ registration_code_id: codeId, email_verified_at: now })).rows).toEqual([{ id: 'd12-user' }]);
    expect(await prepare(testEnv.DB, 'SELECT used_by,used_at FROM registration_codes WHERE id=?', [codeId]).first())
      .toEqual({ used_by: 'd12-user', used_at: now });
    expect(await prepare(testEnv.DB, 'SELECT consumed_at FROM email_challenges WHERE id=?', ['d12-challenge']).first()).toEqual({ consumed_at: now });
  });

  it('permits only one winner when two users compete for the same invitation', async () => {
    await policy('invite'); await invitation();
    const outcomes = await Promise.allSettled([
      register({ id: 'd12-race-a', email_normalized: 'd12-race-a@example.invalid', registration_code_id: codeId }),
      register({ id: 'd12-race-b', email_normalized: 'd12-race-b@example.invalid', registration_code_id: codeId }),
    ]);
    expect(outcomes.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    const users = (await prepare(testEnv.DB, 'SELECT id FROM users WHERE id IN (?,?)', ['d12-race-a', 'd12-race-b']).all()).rows;
    expect(users).toHaveLength(1);
    expect(await prepare(testEnv.DB, 'SELECT used_by FROM registration_codes WHERE id=?', [codeId]).first()).toEqual({ used_by: users[0]!.id });
  });

  it('permits one winner for same-email competition and consumes the challenge once', async () => {
    await policy('open', true); await challenge();
    const outcomes = await Promise.allSettled([
      register({ id: 'd12-email-a', email_verified_at: now }), register({ id: 'd12-email-b', email_verified_at: now }),
    ]);
    expect(outcomes.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect((await prepare(testEnv.DB, 'SELECT id FROM users WHERE email_normalized=?', [email]).all()).rows).toHaveLength(1);
    expect(await prepare(testEnv.DB, 'SELECT consumed_at FROM email_challenges WHERE id=?', ['d12-challenge']).first()).toEqual({ consumed_at: now });
  });

  it('rolls back user creation when an invitation update unexpectedly affects zero rows', async () => {
    await policy('invite'); await invitation();
    await testEnv.DB.exec('CREATE TRIGGER d12_block_code BEFORE UPDATE ON registration_codes BEGIN SELECT RAISE(IGNORE); END');
    await expect(register({ registration_code_id: codeId })).rejects.toThrow('registration_invitation_consumption_failed');
    await absent();
    expect(await prepare(testEnv.DB, 'SELECT used_by FROM registration_codes WHERE id=?', [codeId]).first()).toEqual({ used_by: null });
  });

  it('rolls back the user and prior invitation consumption when challenge consumption fails', async () => {
    await policy('invite', true); await invitation(); await challenge();
    await testEnv.DB.exec('CREATE TRIGGER d12_block_challenge BEFORE UPDATE ON email_challenges BEGIN SELECT RAISE(IGNORE); END');
    await expect(register({ registration_code_id: codeId, email_verified_at: now })).rejects.toThrow('registration_email_consumption_failed');
    await absent();
    expect(await prepare(testEnv.DB, 'SELECT used_by,used_at FROM registration_codes WHERE id=?', [codeId]).first()).toEqual({ used_by: null, used_at: null });
    expect(await prepare(testEnv.DB, 'SELECT consumed_at FROM email_challenges WHERE id=?', ['d12-challenge']).first()).toEqual({ consumed_at: null });
  });

  it('leaves credentials untouched for administrator/bootstrap user creation', async () => {
    await policy('closed', true); await invitation(); await challenge();
    await register({ created_via: 'admin', registration_code_id: codeId, email_verified_at: now });
    await register({ id: 'd12-bootstrap', email_normalized: 'd12-bootstrap@example.invalid', created_via: 'bootstrap', registration_code_id: codeId });
    expect(await prepare(testEnv.DB, 'SELECT used_by FROM registration_codes WHERE id=?', [codeId]).first()).toEqual({ used_by: null });
    expect(await prepare(testEnv.DB, 'SELECT consumed_at FROM email_challenges WHERE id=?', ['d12-challenge']).first()).toEqual({ consumed_at: null });
  });

  it('keeps HMAC equality in the A18 single INSERT SELECT predicate, not in the trigger', async () => {
    await policy('open', true); await challenge();
    const insert = (submittedMac: string, generation: number) => prepare(testEnv.DB,
      `INSERT INTO users (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at,email_verified_at)
       SELECT ?,?,'test-only-hash','user','active',?,2,60,'registration',?,?,?
       WHERE EXISTS (SELECT 1 FROM email_challenges WHERE id=? AND email_normalized=? AND generation=? AND code_mac=?) RETURNING id`,
      ['d12-user', email, group, now, now, now, 'd12-challenge', email, generation, submittedMac]).run();
    expect((await insert('c3'.repeat(32), 2)).rows).toEqual([]);
    expect((await insert(mac, 1)).rows).toEqual([]);
    await absent();
    expect((await insert(mac, 2)).rows).toEqual([{ id: 'd12-user' }]);
  });
});
