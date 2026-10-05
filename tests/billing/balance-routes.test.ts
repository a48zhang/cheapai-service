import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBalanceRoutes } from '../../apps/worker/billing/balance-routes';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const now = 1_788_619_000_000;
const path = '/api/v1/account/balance';
const owner = 'b07-owner';
let cookie: string;
const routes = () => createBalanceRoutes({ now: () => now });
beforeEach(async () => {
  for (const id of [owner, 'b07-other']) {
    await prepare(testEnv.DB, `INSERT INTO users
      (id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES (?,?,'fixture-only','user','active','default',?,2,60,'admin',?,?)`,
    [id, `${id}@example.invalid`, id === owner ? -123 : 99_000_000, now, now]).run();
  }
  cookie = (await createCookieSession(testEnv.DB, owner, now, { sessionTtlMs: 60_000 })).setCookie.split(';')[0]!;
});

describe('B07 authoritative self-service balance', () => {
  it.each([
    ['-123', '-0.00000123'], ['0', '0.00000000'], ['9007199254740991', '90071992.54740991'],
  ])('preserves signed exact units %s and currency scale', async (units, usd) => {
    await prepare(testEnv.DB, 'UPDATE users SET balance_units=? WHERE id=?', [Number(units), owner]).run();
    const response = await routes().request(path, { headers: { Cookie: cookie } }, testEnv);
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ data: { currency: 'USD', decimals: 8, balance_units: units, balance_usd: usd }, request_id: expect.any(String) });
  });

  it('refreshes D1 after a balance change and ignores a poisoned KV cache', async () => {
    await testEnv.CACHE.put(`v1:balance:${owner}`, '{"balance_units":"99999999"}');
    const first = await routes().request(path, { headers: { Cookie: cookie } }, testEnv);
    expect(await first.json()).toMatchObject({ data: { balance_units: '-123' } });
    await prepare(testEnv.DB, 'UPDATE users SET balance_units=777 WHERE id=?', [owner]).run();
    const second = await routes().request(path, { headers: { Cookie: cookie } }, testEnv);
    expect(await second.json()).toMatchObject({ data: { balance_units: '777' } });
  });

  it('requires a live session and ignores identity query overrides, including for administrators', async () => {
    expect((await routes().request(path, {}, testEnv)).status).toBe(401);
    await prepare(testEnv.DB, "UPDATE users SET role='admin' WHERE id=?", [owner]).run();
    const response = await routes().request(path + '?userId=b07-other', { headers: { Cookie: cookie } }, testEnv);
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ data: { balance_units: '-123' } });
    await prepare(testEnv.DB, "UPDATE users SET status='disabled' WHERE id=?", [owner]).run();
    expect((await routes().request(path, { headers: { Cookie: cookie } }, testEnv)).status).toBe(401);
  });

  it('returns 503 for storage failure without exposing data or calling KV', async () => {
    const database = { prepare: () => { throw new Error('private storage failure'); } } as unknown as D1Database;
    const cache = { get: vi.fn() };
    const response = await routes().request(path, { headers: { Cookie: cookie } }, { DB: database, CACHE: cache });
    expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).not.toMatch(/private|balance_units|fixture-only/);
    expect(cache.get).not.toHaveBeenCalled();
  });
});
