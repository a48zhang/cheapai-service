import { beforeEach, describe, expect, it } from 'vitest';
import { adjustBalance, findBalanceAdjustment } from '../../apps/worker/billing/adjustments';
import type { BalanceAdjustmentInput } from '../../apps/worker/billing/adjustments';
import { testEnv } from '../helpers/database';

const input = (patch: Partial<BalanceAdjustmentInput> = {}): BalanceAdjustmentInput => ({ kind: 'adjustment', operationId: 'b06-operation', userId: 'b06-user', deltaUnits: '-200', reason: "Synthetic correction's reason", ...patch });
const actor = 'b06-admin';
async function state() {
  return { user: await testEnv.DB.prepare("SELECT * FROM users WHERE id='b06-user'").first(),
    ledger: (await testEnv.DB.prepare('SELECT * FROM billing_entries ORDER BY id').all()).results,
    audit: (await testEnv.DB.prepare('SELECT * FROM admin_audit ORDER BY id').all()).results };
}

/** Fault only acknowledgement/read transport; SQL still executes on native D1. */
function faultDatabase(loseRead = false, beforeCommit = false): D1Database {
  let failed = false;
  return new Proxy(testEnv.DB, { get(target, property) {
    if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
      if (beforeCommit && !failed) { failed = true; throw new Error('Synthetic unavailable'); }
      const result = await target.batch(statements);
      if (!failed) { failed = true; throw new Error('Synthetic lost acknowledgement'); }
      return result;
    };
    if (property === 'prepare') return (sql: string) => {
      if (failed && loseRead && sql.includes('FROM billing_entries')) throw new Error('Synthetic read unavailable');
      return target.prepare(sql);
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

beforeEach(async () => {
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('b06-group','Fixture','active',1,0,0)").run();
  for (const id of [actor, 'b06-second-admin', 'b06-user', 'b06-other']) {
    await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES(?,?,'synthetic',?,'active','b06-group',100,2,60,'admin',0,0)`).bind(id, `${id}@example.invalid`, id.includes('admin') ? 'admin' : 'user').run();
  }
});

describe('B06 administrator adjustments with native D1', () => {
  it('appends a negative adjustment and audit atomically while allowing negative balance', async () => {
    const result = await adjustBalance(testEnv.DB, input(), actor, 2000);
    expect(result).toMatchObject({ outcome: 'inserted', entry: { kind: 'adjustment', operationId: 'b06-operation', userId: 'b06-user', deltaUnits: '-200', currency: 'USD', createdBy: actor, reason: input().reason, requestId: null, createdAt: 2000 } });
    const saved = await state();
    expect(saved.user).toMatchObject({ balance_units: -100 });
    expect(saved.ledger).toHaveLength(1); expect(saved.audit).toHaveLength(1);
    expect(saved.audit[0]).toMatchObject({ action: 'balance.adjustment', target_type: 'user', target_id: 'b06-user', actor_id: actor, operation_id: 'b06-operation', redacted_change_json: '{"delta_units":-200}' });
    expect(JSON.stringify(saved.audit)).not.toContain(input().reason);
  });

  it('supports positive grants and explicit zero adjustments without modifying earlier ledger facts', async () => {
    const grant = await adjustBalance(testEnv.DB, input({ kind: 'grant', deltaUnits: 50n }), actor, 2000);
    const original = await testEnv.DB.prepare('SELECT * FROM billing_entries WHERE id=?').bind(grant.entry.id).first();
    await adjustBalance(testEnv.DB, input({ operationId: 'second', deltaUnits: '-250' }), actor, 3000);
    await adjustBalance(testEnv.DB, input({ operationId: 'zero', deltaUnits: '0' }), actor, 4000);
    expect((await state()).user).toMatchObject({ balance_units: -100 });
    expect(await testEnv.DB.prepare('SELECT * FROM billing_entries WHERE id=?').bind(grant.entry.id).first()).toEqual(original);
    expect((await state()).audit).toHaveLength(3);
  });

  it('replays identical operation facts without another balance or audit effect', async () => {
    const first = await adjustBalance(testEnv.DB, input(), actor, 2000);
    const before = await state();
    expect(await adjustBalance(testEnv.DB, { ...input({ deltaUnits: -200n }), fingerprint: 'ignored', createdBy: 'ignored' } as BalanceAdjustmentInput, actor, 9999)).toEqual({ outcome: 'existing', entry: first.entry });
    expect(await findBalanceAdjustment(testEnv.DB, input(), actor)).toEqual(first.entry);
    expect(await state()).toEqual(before);
  });

  it('serializes concurrent duplicate calls and independent signed adjustments', async () => {
    const duplicates = await Promise.all(Array.from({ length: 6 }, (_, i) => adjustBalance(testEnv.DB, input(), actor, 2000 + i)));
    expect(duplicates.filter(result => result.outcome === 'inserted')).toHaveLength(1);
    expect(new Set(duplicates.map(result => result.entry.id)).size).toBe(1);
    await Promise.all([
      adjustBalance(testEnv.DB, input({ operationId: 'credit', kind: 'grant', deltaUnits: '300' }), actor, 3000),
      adjustBalance(testEnv.DB, input({ operationId: 'debit', deltaUnits: '-400' }), actor, 3000),
    ]);
    expect((await state()).user).toMatchObject({ balance_units: -200 });
    expect((await state()).ledger).toHaveLength(3); expect((await state()).audit).toHaveLength(3);
  });

  it('returns 409 for changed amount, recipient, kind, actor, reason or request reference', async () => {
    const positive = input({ deltaUnits: '10' });
    await adjustBalance(testEnv.DB, positive, actor, 2000);
    const before = await state();
    for (const patch of [{ deltaUnits: '11' }, { userId: 'b06-other' }, { kind: 'grant' as const }, { reason: 'Changed reason' }, { requestId: 'different-request' }]) {
      await expect(adjustBalance(testEnv.DB, { ...positive, ...patch }, actor, 3000)).rejects.toMatchObject({ code: 'conflict' });
    }
    await expect(adjustBalance(testEnv.DB, positive, 'b06-second-admin', 3000)).rejects.toMatchObject({ code: 'conflict' });
    expect(await state()).toEqual(before);
  });

  it('requires a current active administrator, including for read-only replay lookup', async () => {
    await expect(adjustBalance(testEnv.DB, input(), 'b06-user', 2000)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(adjustBalance(testEnv.DB, input(), 'missing', 2000)).rejects.toMatchObject({ code: 'forbidden' });
    await adjustBalance(testEnv.DB, input(), actor, 2000);
    const before = await state();
    await testEnv.DB.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(actor).run();
    await expect(adjustBalance(testEnv.DB, input(), actor, 3000)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(findBalanceAdjustment(testEnv.DB, input(), actor)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await state()).toEqual(before);
  });

  it('rechecks administrator role inside the write after the initial authorization read', async () => {
    const raced = new Proxy(testEnv.DB, { get(target, property) {
      if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
        await target.prepare("UPDATE users SET role='user' WHERE id=?").bind(actor).run();
        return target.batch(statements);
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const before = await state();
    await expect(adjustBalance(raced, input(), actor, 2000)).rejects.toMatchObject({ code: 'conflict' });
    expect(await state()).toEqual(before);
  });

  it('requires a reason and safe explicit units without partial writes', async () => {
    for (const patch of [{ reason: '' }, { reason: ' \n ' }, { reason: 'x'.repeat(4097) }, { reason: undefined },
      { deltaUnits: 1 }, { deltaUnits: '1.5' }, { deltaUnits: '-0' }, { deltaUnits: '01' }, { deltaUnits: '9007199254740992' },
      { deltaUnits: 9007199254740992n }, { kind: 'consumption' }, { kind: 'grant', deltaUnits: '0' }, { kind: 'grant', deltaUnits: '-1' },
    ]) await expect(adjustBalance(testEnv.DB, { ...input(), ...patch } as unknown as BalanceAdjustmentInput, actor, 2000)).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await state()).ledger).toHaveLength(0); expect((await state()).audit).toHaveLength(0);
  });

  it('rolls back both ledger and balance if the same-batch audit fails', async () => {
    const before = await state();
    await testEnv.DB.exec("CREATE TRIGGER b06_fail_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'synthetic_audit_failure'); END;");
    await expect(adjustBalance(testEnv.DB, input(), actor, 2000)).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(await state()).toEqual(before);
  });

  it('rolls back zero-row insertion and trigger side effects, without an orphan audit', async () => {
    const before = await state();
    await testEnv.DB.exec("CREATE TRIGGER b06_ignore_entry BEFORE INSERT ON billing_entries BEGIN UPDATE groups SET version=version+1 WHERE id='b06-group'; SELECT RAISE(IGNORE); END;");
    await expect(adjustBalance(testEnv.DB, input(), actor, 2000)).rejects.toMatchObject({ code: 'conflict' });
    expect(await state()).toEqual(before);
    expect(await testEnv.DB.prepare("SELECT version FROM groups WHERE id='b06-group'").first('version')).toBe(1);
  });

  it('recovers lost commit acknowledgement with exactly one ledger and audit', async () => {
    expect((await adjustBalance(faultDatabase(), input(), actor, 2000)).outcome).toBe('existing');
    expect((await state()).user).toMatchObject({ balance_units: -100 });
    expect((await state()).ledger).toHaveLength(1); expect((await state()).audit).toHaveLength(1);
  });

  it('supports read-only reconciliation after commit and immediate lookup are both uncertain', async () => {
    await expect(adjustBalance(faultDatabase(true), input(), actor, 2000)).rejects.toMatchObject({ code: 'service_unavailable' });
    const before = await state();
    const found = await findBalanceAdjustment(testEnv.DB, input(), actor);
    expect(found).not.toBeNull();
    expect((await adjustBalance(testEnv.DB, input(), actor, 3000)).entry).toEqual(found);
    expect(await state()).toEqual(before);
  });

  it('allows the same operation to retry after a known precommit transport failure', async () => {
    await expect(adjustBalance(faultDatabase(false, true), input(), actor, 2000)).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(await findBalanceAdjustment(testEnv.DB, input(), actor)).toBeNull();
    expect((await adjustBalance(testEnv.DB, input(), actor, 3000)).outcome).toBe('inserted');
    expect((await state()).ledger).toHaveLength(1);
  });

  it('rejects overflow but permits correcting a disabled target with a negative balance', async () => {
    await testEnv.DB.prepare("UPDATE users SET balance_units=?,status='disabled' WHERE id='b06-user'").bind(-Number.MAX_SAFE_INTEGER).run();
    const before = await state();
    await expect(adjustBalance(testEnv.DB, input({ deltaUnits: '-1' }), actor, 2000)).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(await state()).toEqual(before);
    await adjustBalance(testEnv.DB, input({ kind: 'grant', deltaUnits: '1' }), actor, 2000);
    expect((await state()).user).toMatchObject({ balance_units: -Number.MAX_SAFE_INTEGER + 1, status: 'disabled' });
  });

  it('requires an owned request reference and leaves the original request untouched', async () => {
    await testEnv.DB.prepare(`INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at)
      VALUES('b06-key','b06-user',?,'s2a_key_ABCDEFGH','Synthetic','active',0,0)`).bind('6'.repeat(64)).run();
    const credential = 'synthetic';
    await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
      VALUES('b06-channel','Synthetic','https://example.invalid',?,'active',0,1,1,1,0,0)`).bind(credential).run();
    await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('b06-model','active','{}',1,0,10,0,0)`).run();
    await testEnv.DB.prepare(`INSERT INTO requests(id,user_id,api_key_id,channel_id,public_model_id,upstream_model,downstream_protocol,upstream_protocol,price_snapshot,created_at,updated_at)
      VALUES('b06-request','b06-user','b06-key','b06-channel','b06-model','model','chat','chat','{}',0,0)`).run();
    const original = await testEnv.DB.prepare("SELECT * FROM requests WHERE id='b06-request'").first();
    await expect(adjustBalance(testEnv.DB, input({ requestId: 'b06-request', userId: 'b06-other' }), actor, 2000)).rejects.toMatchObject({ code: 'conflict' });
    await expect(adjustBalance(testEnv.DB, input({ requestId: 'missing-request' }), actor, 2000)).rejects.toMatchObject({ code: 'conflict' });
    await adjustBalance(testEnv.DB, input({ requestId: 'b06-request' }), actor, 2000);
    expect(await testEnv.DB.prepare("SELECT * FROM requests WHERE id='b06-request'").first()).toEqual(original);
  });
});
