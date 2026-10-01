import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readDefaultGroupId, readRegistrationSettings, updateRegistrationSettings } from '../../apps/worker/auth/registration-settings';
import type { RegistrationSettingsUpdate } from '../../apps/worker/auth/registration-settings';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const now = 1_788_627_000_123;
const actor = 'a09-admin';
const update = (overrides: Partial<RegistrationSettingsUpdate> = {}, emailAvailable = false) => updateRegistrationSettings(testEnv.DB,
  { patch: { registrationMode: 'invite', emailVerificationEnabled: false }, expectedVersion: 1,
    actorId: actor, operationId: 'a09-operation', now, ...overrides }, { emailAvailable });
const audits = () => prepare(testEnv.DB, 'SELECT * FROM admin_audit WHERE actor_id=?', [actor]).all();

beforeEach(async () => {
  await prepare(testEnv.DB, 'INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES (?,?,?,1,?,?)',
    ['a09-group', 'A09 Group', 'active', now, now]).run();
  await prepare(testEnv.DB, `INSERT INTO users (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES (?,?,?,'admin','active',?,2,60,'bootstrap',?,?)`, [actor, 'a09-admin@example.invalid', 'test-only-hash', 'a09-group', now, now]).run();
});

describe('registration settings read policy', () => {
  it('reads D14 closed defaults and an active default group', async () => {
    expect(await readRegistrationSettings(testEnv.DB)).toMatchObject({ registrationMode: 'closed', emailVerificationEnabled: true, version: 1, valid: true });
    expect(await readDefaultGroupId(testEnv.DB)).toBe('default');
  });

  it('fails closed for missing or malformed policy shapes', async () => {
    for (const json of ['null', '[]', '{}', '{"registrationMode":"open"}', '{"registrationMode":"open","emailVerificationEnabled":"false"}',
      '{"registrationMode":"open","emailVerificationEnabled":false,"extra":true}']) {
      await prepare(testEnv.DB, 'UPDATE settings SET value_json=? WHERE key=?', [json, 'registration']).run();
      expect(await readRegistrationSettings(testEnv.DB, { emailAvailable: true })).toMatchObject({ registrationMode: 'closed', emailVerificationEnabled: true, valid: false });
    }
    await prepare(testEnv.DB, 'DELETE FROM settings WHERE key=?', ['registration']).run();
    expect(await readRegistrationSettings(testEnv.DB)).toEqual({ registrationMode: 'closed', emailVerificationEnabled: true, version: null, updatedAt: null, valid: false });
    await expect(update()).rejects.toMatchObject({ code: 'conflict' });
  });

  it('fails closed when verified registration is configured without email readiness', async () => {
    await prepare(testEnv.DB, 'UPDATE settings SET value_json=? WHERE key=?',
      ['{"registrationMode":"open","emailVerificationEnabled":true}', 'registration']).run();
    expect(await readRegistrationSettings(testEnv.DB)).toMatchObject({ registrationMode: 'closed', valid: false });
    expect(await readRegistrationSettings(testEnv.DB, { emailAvailable: true })).toMatchObject({ registrationMode: 'open', valid: true });
  });

  it('returns no default group for missing, malformed, nonexistent or disabled selection', async () => {
    for (const value_json of ['null', '{}', '""', '" missing "', '"a09-missing"']) {
      await prepare(testEnv.DB, 'UPDATE settings SET value_json=? WHERE key=?', [value_json, 'default_group_id']).run();
      expect(await readDefaultGroupId(testEnv.DB)).toBeNull();
    }
    await prepare(testEnv.DB, 'UPDATE settings SET value_json=? WHERE key=?', ['"default"', 'default_group_id']).run();
    await prepare(testEnv.DB, 'UPDATE groups SET status=? WHERE id=?', ['disabled', 'default']).run();
    expect(await readDefaultGroupId(testEnv.DB)).toBeNull();
    await prepare(testEnv.DB, 'DELETE FROM settings WHERE key=?', ['default_group_id']).run();
    expect(await readDefaultGroupId(testEnv.DB)).toBeNull();
  });
});

describe('registration settings atomic updates', () => {
  it('persists only the two policy fields with one matching O01 audit', async () => {
    expect(await update()).toEqual({ registrationMode: 'invite', emailVerificationEnabled: false, version: 2, updatedAt: now, valid: true });
    const row = await prepare<{ value_json: string }>(testEnv.DB, 'SELECT value_json FROM settings WHERE key=?', ['registration']).first();
    expect(JSON.parse(row!.value_json)).toEqual({ registrationMode: 'invite', emailVerificationEnabled: false });
    const saved = (await audits()).rows;
    expect(saved).toHaveLength(1);
    expect(JSON.parse(saved[0]!.redacted_change_json as string)).toEqual({
      before: { registration_mode: 'closed', email_verification_enabled: true },
      after: { registration_mode: 'invite', email_verification_enabled: false },
    });
    expect(await readDefaultGroupId(testEnv.DB)).toBe('default');
  });

  it('uses F10 readiness validation and preserves the other field during partial changes', async () => {
    await expect(update({ patch: { registrationMode: 'open' } })).rejects.toMatchObject({ code: 'invalid_request' });
    await update({ patch: { registrationMode: 'open' } }, true);
    expect(await update({ expectedVersion: 2, patch: { emailVerificationEnabled: false }, operationId: 'a09-disable-email' }))
      .toMatchObject({ registrationMode: 'open', emailVerificationEnabled: false, version: 3 });
  });

  it('rejects old versions without writing another audit', async () => {
    await update();
    await expect(update()).rejects.toMatchObject({ code: 'conflict' });
    expect((await audits()).rows).toHaveLength(1);
  });

  it('allows exactly one writer and one audit for concurrent updates with the same version', async () => {
    const results = await Promise.allSettled([update(), update({ operationId: 'a09-other', patch: { registrationMode: 'open', emailVerificationEnabled: false } })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'conflict' } });
    expect((await audits()).rows).toHaveLength(1);
    expect(await readRegistrationSettings(testEnv.DB)).toMatchObject({ version: 2 });
  });

  it('rolls back settings if actor FK rejects the audit', async () => {
    await expect(update({ actorId: 'a09-missing' })).rejects.toThrow();
    expect(await readRegistrationSettings(testEnv.DB)).toMatchObject({ registrationMode: 'closed', version: 1 });
    expect((await audits()).rows).toEqual([]);
  });

  it('treats an unexpected zero-row update as 409 and prevents a success audit', async () => {
    await testEnv.DB.exec("CREATE TRIGGER a09_ignore BEFORE UPDATE ON settings WHEN OLD.key='registration' BEGIN SELECT RAISE(IGNORE); END");
    await expect(update()).rejects.toMatchObject({ code: 'conflict' });
    expect(await readRegistrationSettings(testEnv.DB)).toMatchObject({ registrationMode: 'closed', version: 1 });
    expect((await audits()).rows).toEqual([]);
  });

  it('rejects unknown fields, accessors and unsafe versions/times before changing state', async () => {
    for (const patch of [{}, { other: true }, { registrationMode: 'unknown' }, { emailVerificationEnabled: 'false' }]) {
      await expect(update({ patch: patch as RegistrationSettingsUpdate['patch'] })).rejects.toMatchObject({ code: 'invalid_request' });
    }
    const getter = vi.fn(() => 'open');
    const patch = Object.defineProperty({}, 'registrationMode', { get: getter });
    await expect(update({ patch })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(getter).not.toHaveBeenCalled();
    for (const expectedVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) await expect(update({ expectedVersion })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(update({ now: -1 })).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await audits()).rows).toEqual([]);
  });
});
