import { beforeEach, describe, expect, it } from 'vitest';
import { generateRegistrationCodes, listRegistrationCodes, revokeRegistrationCode, REGISTRATION_CODE_LIMITS } from '../../apps/worker/auth/registration-codes';
import type { GenerateRegistrationCodesInput } from '../../apps/worker/auth/registration-codes';
import { verifyToken } from '../../apps/worker/auth/tokens';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const now = 1_788_628_000_123;
const actor = 'a11-admin';
const actor2 = 'a11-other-admin';
const issue = (patch: Partial<GenerateRegistrationCodesInput> = {}) => generateRegistrationCodes(testEnv.DB,
  { actorId: actor, operationId: 'a11-operation', quantity: 2, expiresAt: now + 60_000, now, ...patch });
const rows = () => prepare(testEnv.DB, 'SELECT * FROM registration_codes WHERE created_by=? ORDER BY ordinal', [actor]).all();
const batches = () => prepare(testEnv.DB, 'SELECT * FROM registration_code_batches WHERE actor_id=?', [actor]).all();
const audits = () => prepare(testEnv.DB, 'SELECT * FROM admin_audit WHERE actor_id=?', [actor]).all();

beforeEach(async () => {
  await prepare(testEnv.DB, 'INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES (?,?,?,1,?,?)',
    ['a11-group', 'A11 Group', 'active', now, now]).run();
  for (const id of [actor, actor2]) {
    await prepare(testEnv.DB, `INSERT INTO users (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES (?,?,?,'admin','active',?,2,60,'bootstrap',?,?)`, [id, `${id}@example.invalid`, 'test-only-hash', 'a11-group', now, now]).run();
  }
});

describe('registration code metadata listing', () => {
  it('lets site administrators list all creators or filter a creator without plaintext or hashes', async () => {
    const created = await issue();
    await issue({ actorId: actor2 });
    const page = await listRegistrationCodes(testEnv.DB, { actorId: actor2, now });
    expect(page.items).toHaveLength(4);
    const filtered = await listRegistrationCodes(testEnv.DB, { actorId: actor2, now, createdBy: actor });
    expect(filtered.items.map((item) => item.id).sort()).toEqual(created.codes.map((item) => item.id).sort());
    expect(page.nextCursor).toBeNull();
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain('code_hash');
    expect(serialized).not.toContain('fingerprint');
    if (!created.replayed) for (const code of created.codes) expect(serialized).not.toContain(code.token);
  });

  it('reports usage, expiry and revocation with original timestamps and consumer IDs', async () => {
    const created = await issue({ quantity: 4 });
    const [unused, used, expired, revoked] = created.codes;
    await prepare(testEnv.DB, 'UPDATE registration_codes SET used_by=?,used_at=? WHERE id=?', [actor2, now + 1, used!.id]).run();
    await prepare(testEnv.DB, 'UPDATE registration_codes SET expires_at=? WHERE id=?', [now + 1, expired!.id]).run();
    await prepare(testEnv.DB, 'UPDATE registration_codes SET used_by=?,used_at=?,revoked_at=? WHERE id=?', [actor2, now + 1, now + 2, revoked!.id]).run();
    const page = await listRegistrationCodes(testEnv.DB, { actorId: actor, now: now + 3 });
    const byId = new Map(page.items.map((item) => [item.id, item]));
    expect(byId.get(unused!.id)).toMatchObject({ status: 'unused', usedBy: null, usedAt: null, revokedAt: null });
    expect(byId.get(used!.id)).toMatchObject({ status: 'used', usedBy: actor2, usedAt: now + 1 });
    expect(byId.get(expired!.id)).toMatchObject({ status: 'expired', expiresAt: now + 1 });
    expect(byId.get(revoked!.id)).toMatchObject({ status: 'revoked', usedBy: actor2, usedAt: now + 1, revokedAt: now + 2 });
  });

  it('paginates equal timestamps by ID without duplicates and excludes newer insertions', async () => {
    const created = await issue({ quantity: 5 });
    const first = await listRegistrationCodes(testEnv.DB, { actorId: actor, now, limit: 2 });
    expect(first.nextCursor).not.toBeNull();
    await issue({ operationId: 'a11-newer', quantity: 1, now: now + 1 });
    const second = await listRegistrationCodes(testEnv.DB, { actorId: actor, now: now + 2, limit: 2, cursor: first.nextCursor! });
    const third = await listRegistrationCodes(testEnv.DB, { actorId: actor, now: now + 3, limit: 2, cursor: second.nextCursor! });
    expect(third.nextCursor).toBeNull();
    expect(second.snapshotAt).toBe(now);
    expect(third.snapshotAt).toBe(now);
    const ids = [...first.items, ...second.items, ...third.items].map((item) => item.id);
    expect(ids).toEqual(created.codes.map((item) => item.id).sort().reverse());
    expect(new Set(ids).size).toBe(5);
  });

  it('rejects cross-actor cursors, invalid pagination and unavailable actors', async () => {
    await issue({ quantity: 3 });
    const first = await listRegistrationCodes(testEnv.DB, { actorId: actor, now, limit: 1 });
    await expect(listRegistrationCodes(testEnv.DB, { actorId: actor2, now, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(listRegistrationCodes(testEnv.DB, { actorId: actor, createdBy: actor, now, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'invalid_request' });
    for (const cursor of ['', 'invalid!', 'a'.repeat(1025), btoa('[]').replace(/=+$/, '')]) {
      await expect(listRegistrationCodes(testEnv.DB, { actorId: actor, now, cursor })).rejects.toMatchObject({ code: 'invalid_request' });
    }
    for (const limit of [0, -1, 1.5, 101]) await expect(listRegistrationCodes(testEnv.DB, { actorId: actor, now, limit })).rejects.toMatchObject({ code: 'invalid_request' });
    await prepare(testEnv.DB, 'UPDATE users SET status=? WHERE id=?', ['disabled', actor]).run();
    await expect(listRegistrationCodes(testEnv.DB, { actorId: actor, now })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('site administrator registration code revocation', () => {
  const revoke = (codeId: string, asActor = actor2, timestamp = now + 1) => revokeRegistrationCode(testEnv.DB,
    { codeId, actorId: asActor, operationId: 'a11-revoke-operation', now: timestamp });
  const revocationAudits = () => prepare(testEnv.DB, "SELECT actor_id,target_id,redacted_change_json FROM admin_audit WHERE action='registration_codes.revoke'").all();

  it('allows another site administrator to revoke an unused code atomically with audit', async () => {
    const code = (await issue()).codes[0]!;
    expect(await revoke(code.id)).toMatchObject({ status: 'revoked', revokedAt: now + 1 });
    expect((await revocationAudits()).rows).toEqual([{ actor_id: actor2, target_id: code.id,
      redacted_change_json: '{"revoked_at":{"before":null,"after":' + (now + 1) + '}}' }]);
    expect((await listRegistrationCodes(testEnv.DB, { actorId: actor, now: now + 2 })).items.find((item) => item.id === code.id))
      .toMatchObject({ status: 'revoked', revokedAt: now + 1 });
  });

  it('preserves the first revocation time and creates no duplicate audit on repeated requests', async () => {
    const code = (await issue()).codes[0]!;
    await revoke(code.id);
    expect(await revoke(code.id, actor, now + 9)).toMatchObject({ status: 'already_revoked', revokedAt: now + 1 });
    expect((await revocationAudits()).rows).toHaveLength(1);
  });

  it('returns explicit missing/used outcomes without mutating or auditing them', async () => {
    expect(await revoke('a11-missing-code')).toMatchObject({ status: 'not_found' });
    const code = (await issue()).codes[0]!;
    await prepare(testEnv.DB, 'UPDATE registration_codes SET used_by=?,used_at=? WHERE id=?', [actor, now + 1, code.id]).run();
    expect(await revoke(code.id)).toMatchObject({ status: 'already_used', usedBy: actor, usedAt: now + 1, revokedAt: null });
    expect((await revocationAudits()).rows).toEqual([]);
  });

  it('has one transition and one audit when administrators revoke concurrently', async () => {
    const code = (await issue()).codes[0]!;
    const results = await Promise.all([revoke(code.id, actor), revoke(code.id, actor2)]);
    expect(results.filter((result) => result.status === 'revoked')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'already_revoked')).toHaveLength(1);
    expect((await revocationAudits()).rows).toHaveLength(1);
  });

  it('rolls back revocation if audit fails', async () => {
    const code = (await issue()).codes[0]!;
    await testEnv.DB.exec("CREATE TRIGGER a11r_fail_audit BEFORE INSERT ON admin_audit WHEN NEW.action='registration_codes.revoke' BEGIN SELECT RAISE(ABORT,'test_revocation_audit_failure'); END");
    await expect(revoke(code.id)).rejects.toThrow('test_revocation_audit_failure');
    expect(await prepare(testEnv.DB, 'SELECT revoked_at FROM registration_codes WHERE id=?', [code.id]).first()).toEqual({ revoked_at: null });
    expect((await revocationAudits()).rows).toEqual([]);
  });

  it('does not insert an audit when an unexpected zero-row update occurs', async () => {
    const code = (await issue()).codes[0]!;
    await testEnv.DB.exec('CREATE TRIGGER a11r_ignore BEFORE UPDATE ON registration_codes BEGIN SELECT RAISE(IGNORE); END');
    await expect(revoke(code.id)).rejects.toMatchObject({ code: 'conflict' });
    expect((await revocationAudits()).rows).toEqual([]);
  });

  it('rejects ordinary users for both global listing and revocation', async () => {
    const code = (await issue()).codes[0]!;
    await prepare(testEnv.DB, 'UPDATE users SET role=? WHERE id=?', ['user', actor2]).run();
    await expect(revoke(code.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(listRegistrationCodes(testEnv.DB, { actorId: actor2, now })).rejects.toMatchObject({ code: 'forbidden' });
    expect((await revocationAudits()).rows).toEqual([]);
  });
});

describe('registration code generation with native D1 batch idempotency', () => {
  it('returns new invitation secrets once while persisting only hashes, metadata and one audit', async () => {
    const created = await issue();
    expect(created.replayed).toBe(false);
    expect(created.codes).toHaveLength(2);
    if (created.replayed) throw new Error('Expected first issuance');
    const stored = (await rows()).rows;
    expect(stored).toHaveLength(2);
    expect((await batches()).rows).toHaveLength(1);
    const auditRows = (await audits()).rows;
    expect(auditRows).toHaveLength(1);
    const allStored = JSON.stringify([stored, (await batches()).rows, auditRows]);
    for (const code of created.codes) {
      expect(code.token).toMatch(/^s2a_invite_/);
      expect(allStored).not.toContain(code.token);
      expect(await verifyToken('invitation', code.token, stored[code.ordinal]!.code_hash)).toBe(true);
      expect(stored[code.ordinal]).toMatchObject({ id: code.id, display_prefix: code.displayPrefix, operation_id: created.batchId });
    }
    expect(await prepare(testEnv.DB, 'SELECT balance_units FROM users WHERE id=?', [actor]).first()).toEqual({ balance_units: 0 });
  });

  it('returns original IDs/masks without secrets on identical replay, including after expiry', async () => {
    const first = await issue();
    const replayed = await issue({ now: now + 120_000 });
    expect(replayed.replayed).toBe(true);
    expect(replayed.batchId).toBe(first.batchId);
    expect(replayed.codes.map(({ id, displayPrefix }) => ({ id, displayPrefix }))).toEqual(first.codes.map(({ id, displayPrefix }) => ({ id, displayPrefix })));
    expect(replayed.codes.every((code) => !Object.hasOwn(code, 'token'))).toBe(true);
    expect((await rows()).rows).toHaveLength(2);
    expect((await audits()).rows).toHaveLength(1);
  });

  it('conflicts on changed quantity or expiry for a committed operation', async () => {
    await issue();
    await expect(issue({ quantity: 3 })).rejects.toMatchObject({ code: 'conflict' });
    await expect(issue({ expiresAt: now + 61_000 })).rejects.toMatchObject({ code: 'conflict' });
    expect((await rows()).rows).toHaveLength(2);
    expect((await audits()).rows).toHaveLength(1);
  });

  it('namespaces operation keys by actor rather than conflating different administrators', async () => {
    const first = await issue();
    const second = await issue({ actorId: actor2 });
    expect(second.replayed).toBe(false);
    expect(first.batchId).not.toBe(second.batchId);
    expect((await prepare(testEnv.DB, 'SELECT id FROM registration_code_batches WHERE operation_id=?', ['a11-operation']).all()).rows).toHaveLength(2);
  });

  it('has one creator and one metadata replay for concurrent identical requests', async () => {
    const results = await Promise.all([issue(), issue()]);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(results[0]!.batchId).toBe(results[1]!.batchId);
    expect((await rows()).rows).toHaveLength(2);
    expect((await batches()).rows).toHaveLength(1);
    expect((await audits()).rows).toHaveLength(1);
  });

  it('allows one winner and one conflict for concurrent different payloads', async () => {
    const results = await Promise.allSettled([issue(), issue({ quantity: 3 })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ status: 'rejected', reason: { code: 'conflict' } });
    expect((await batches()).rows).toHaveLength(1);
    expect((await audits()).rows).toHaveLength(1);
  });

  it('rolls back the claim and all codes when audit insertion fails, and permits a later clean retry', async () => {
    await testEnv.DB.exec("CREATE TRIGGER a11_fail_audit BEFORE INSERT ON admin_audit WHEN NEW.action='registration_codes.generate' BEGIN SELECT RAISE(ABORT,'test_audit_failure'); END");
    await expect(issue()).rejects.toThrow('test_audit_failure');
    expect((await rows()).rows).toEqual([]);
    expect((await batches()).rows).toEqual([]);
    expect((await audits()).rows).toEqual([]);
    await testEnv.DB.exec('DROP TRIGGER a11_fail_audit');
    expect((await issue()).replayed).toBe(false);
  });

  it('rolls back earlier code rows when a later row fails', async () => {
    await testEnv.DB.exec("CREATE TRIGGER a11_fail_second BEFORE INSERT ON registration_codes WHEN NEW.ordinal=1 BEGIN SELECT RAISE(ABORT,'test_code_failure'); END");
    await expect(issue()).rejects.toThrow('test_code_failure');
    expect((await rows()).rows).toEqual([]);
    expect((await batches()).rows).toEqual([]);
    expect((await audits()).rows).toEqual([]);
  });

  it('rejects unauthorized actors and does not disclose an existing batch after deactivation', async () => {
    await expect(issue({ actorId: 'a11-missing' })).rejects.toMatchObject({ code: 'forbidden' });
    await issue();
    await prepare(testEnv.DB, 'UPDATE users SET status=? WHERE id=?', ['disabled', actor]).run();
    await expect(issue()).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('bounds quantity, expiry and idempotency identifiers', async () => {
    for (const quantity of [0, -1, 1.5, REGISTRATION_CODE_LIMITS.quantity + 1]) {
      await expect(issue({ quantity })).rejects.toMatchObject({ code: 'invalid_request' });
    }
    for (const expiresAt of [now, now - 1, now + REGISTRATION_CODE_LIMITS.lifetimeMs + 1, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(issue({ expiresAt })).rejects.toMatchObject({ code: 'invalid_request' });
    }
    await expect(issue({ operationId: '' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await batches()).rows).toEqual([]);
  });

  it('successfully issues the configured maximum batch within the transaction', async () => {
    const created = await issue({ quantity: REGISTRATION_CODE_LIMITS.quantity, expiresAt: now + REGISTRATION_CODE_LIMITS.lifetimeMs });
    expect(created.codes).toHaveLength(REGISTRATION_CODE_LIMITS.quantity);
    expect((await rows()).rows).toHaveLength(REGISTRATION_CODE_LIMITS.quantity);
    expect((await audits()).rows).toHaveLength(1);
  });
});
