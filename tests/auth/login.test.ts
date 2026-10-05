import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../apps/worker/config';
import { login } from '../../apps/worker/auth/login';
import type { LoginDependencies } from '../../apps/worker/auth/login';
import type { AuthGateNamespace } from '../../apps/worker/limits/auth-rate-limit';
import * as passwords from '../../apps/worker/auth/password';
import * as users from '../../apps/worker/auth/users';
import * as sessions from '../../apps/worker/auth/sessions';
import { testEnv } from '../helpers/database';

const password = 'correct horse battery staple';
const hash = '$argon2id$v=19$m=19456,t=2,p=1$ABEiM0RVZneImaq7zN3u/w$zNlY8+rVrxPryRQjL30GJ7r4tOgZLsK6gVRDMWy/cD0';
const input = { email: 'a07@example.invalid', password };
const ip = '198.51.100.7';
let dependencies: LoginDependencies;
let verify: ReturnType<typeof vi.spyOn<typeof passwords, 'verifyPassword'>>;
async function activeSessions() {
  return testEnv.DB.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id='a07-user' AND revoked_at IS NULL").first('count');
}

describe('login service with real D1/DO admission and session persistence', () => {
  beforeEach(async () => {
    dependencies = { database: testEnv.DB, gates: testEnv.GATE, now: () => 2000,
      rateConfig: { ...DEFAULT_CONFIG, loginAccountFailureLimit: 1, loginIpAttemptLimit: 30 } };
    await testEnv.DB.prepare("INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES ('a07-group','A07 group','active',1,0,0)").run();
    await testEnv.DB.prepare(`INSERT INTO users (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES ('a07-user','a07@example.invalid',?,'user','active','a07-group',2,60,'admin',0,0)`).bind(hash).run();
    verify = vi.spyOn(passwords, 'verifyPassword').mockResolvedValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('normalizes email and verifies one real Argon2id hash before issuing a usable secure cookie', async () => {
    verify.mockRestore();
    const result = await login(dependencies, { email: '  A07@Example.Invalid  ', password }, ip);
    expect(result.user).toMatchObject({ id: 'a07-user', email_normalized: input.email, status: 'active', role: 'user' });
    expect(result.setCookie).toContain('__Host-sub2api_session=');
    expect(result.setCookie).toContain('Secure; HttpOnly; SameSite=Lax');
    expect(Object.keys(result)).toEqual(['user', 'setCookie']);
    expect(Object.getOwnPropertyNames(result.user)).not.toContain('password_hash');
    expect(JSON.stringify(result.user)).not.toContain(password);
    expect(JSON.stringify(result)).not.toContain(hash);
    expect(await sessions.readCookieSession(testEnv.DB, result.setCookie.split(';')[0]!, 2000)).toMatchObject({ user_id: 'a07-user' });
    expect(await activeSessions()).toBe(1);
  }, 30_000);

  it('returns the same unauthorized error for wrong password and unknown email, counting failures', async () => {
    verify.mockResolvedValue(false);
    for (const email of [input.email, 'unknown@example.invalid']) {
      await expect(login(dependencies, { ...input, email }, ip)).rejects.toMatchObject({ code: 'unauthorized', message: 'Authentication required.' });
      await expect(login(dependencies, { ...input, email }, ip)).rejects.toMatchObject({ code: 'rate_limited' });
    }
    expect(verify).toHaveBeenCalledTimes(1);
    expect(await activeSessions()).toBe(0);
  });

  it('enforces IP attempts before user lookup/KDF, while successful logins do not count account failures', async () => {
    dependencies.rateConfig = { ...DEFAULT_CONFIG, loginAccountFailureLimit: 1, loginIpAttemptLimit: 2 };
    const lookup = vi.spyOn(users, 'findInternalAuthUserByEmail');
    const first = await login(dependencies, input, ip);
    const second = await login(dependencies, input, ip);
    expect(first.setCookie).not.toBe(second.setCookie);
    const lookups = lookup.mock.calls.length;
    await expect(login(dependencies, input, ip)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenCalledTimes(lookups);
  });

  it('maps PasswordBusy/runtime faults to 503 without counting credential failures', async () => {
    verify.mockRejectedValueOnce(new passwords.PasswordBusyError()).mockRejectedValueOnce(new Error('secret runtime fault'));
    await expect(login(dependencies, input, ip)).rejects.toMatchObject({ code: 'service_unavailable' });
    await expect(login(dependencies, input, ip)).rejects.toMatchObject({ code: 'service_unavailable' });
    expect((await login(dependencies, input, ip)).user.id).toBe('a07-user');
  });

  it('does not disguise lookup/DO/failure-counter service faults as bad credentials', async () => {
    const lookup = vi.spyOn(users, 'findInternalAuthUserByEmail').mockRejectedValueOnce(new Error('database failure'));
    await expect(login(dependencies, input, ip)).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(verify).not.toHaveBeenCalled();
    lookup.mockRestore();
    const gates = { idFromName: testEnv.GATE.idFromName.bind(testEnv.GATE), get() { throw new Error('DO unavailable'); } };
    await expect(login({ ...dependencies, gates }, input, ip)).rejects.toMatchObject({ code: 'service_unavailable' });
    expect((await login(dependencies, input, ip)).user.id).toBe('a07-user');
  });

  it('returns 503 if recording a wrong-password failure is unavailable', async () => {
    const names = new Map<string, string>();
    const gates: AuthGateNamespace = {
      idFromName(name) { const id = testEnv.GATE.idFromName(name); names.set(id.toString(), name); return id; },
      get(id) {
        const stub = testEnv.GATE.get(id);
        return {
          ratePeek: (value) => stub.ratePeek(value),
          rateCheck: (value) => {
            if (names.get(id.toString())?.startsWith('auth:login-failure:')) throw new Error('failure counter unavailable');
            return stub.rateCheck(value);
          },
        };
      },
    };
    verify.mockResolvedValueOnce(false);
    await expect(login({ ...dependencies, gates }, input, ip)).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(await activeSessions()).toBe(0);
    expect((await login(dependencies, input, ip)).user.id).toBe('a07-user');
  });

  it('keeps initially disabled accounts indistinguishable from invalid credentials', async () => {
    await testEnv.DB.prepare("UPDATE users SET status='disabled' WHERE id='a07-user'").run();
    await expect(login(dependencies, input, ip)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(login(dependencies, input, ip)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(verify).not.toHaveBeenCalled();
    expect(await activeSessions()).toBe(0);
  });

  it('rejects malformed credentials before touching identity or KDF', async () => {
    const lookup = vi.spyOn(users, 'findInternalAuthUserByEmail');
    for (const invalid of [null, [], {}, { ...input, email: 'not-email' }, { ...input, password: null }, { ...input, password: 'x'.repeat(257) }]) {
      await expect(login(dependencies, invalid, ip)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it.each(['user', 'group', 'role', 'password'])('does not create a session when %s changes during KDF', async (change) => {
    if (change === 'role') await testEnv.DB.prepare("UPDATE users SET role='admin' WHERE id='a07-user'").run();
    verify.mockImplementationOnce(async () => {
      if (change === 'user') await testEnv.DB.prepare("UPDATE users SET status='disabled' WHERE id='a07-user'").run();
      if (change === 'group') await testEnv.DB.prepare("UPDATE groups SET status='disabled' WHERE id='a07-group'").run();
      if (change === 'role') await testEnv.DB.prepare("UPDATE users SET role='user' WHERE id='a07-user'").run();
      if (change === 'password') await testEnv.DB.prepare("UPDATE users SET password_hash='new-test-hash' WHERE id='a07-user'").run();
      return true;
    });
    await expect(login(dependencies, input, ip)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(await activeSessions()).toBe(0);
    await testEnv.DB.prepare("UPDATE users SET status='active' WHERE id='a07-user'").run();
    await testEnv.DB.prepare("UPDATE groups SET status='active' WHERE id='a07-group'").run();
    expect((await login(dependencies, input, ip)).user.id).toBe('a07-user'); // Revalidation failure did not consume account failure budget.
  });

  it('revokes a newly created session if identity changes in the creation gap, and withholds its cookie', async () => {
    await testEnv.DB.prepare("UPDATE users SET role='admin' WHERE id='a07-user'").run();
    const realCreate = sessions.createCookieSession;
    vi.spyOn(sessions, 'createCookieSession').mockImplementationOnce(async (...args) => {
      const created = await realCreate(...args);
      await testEnv.DB.prepare("UPDATE users SET role='user' WHERE id='a07-user'").run();
      return created;
    });
    await expect(login(dependencies, input, ip)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(await activeSessions()).toBe(0);
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id='a07-user' AND revoked_at IS NOT NULL").first('count')).toBe(1);
  });

  it('honors the atomic active-user check if disable happens just before the session insert', async () => {
    const realCreate = sessions.createCookieSession;
    vi.spyOn(sessions, 'createCookieSession').mockImplementationOnce(async (...args) => {
      await testEnv.DB.prepare("UPDATE users SET status='disabled' WHERE id='a07-user'").run();
      return realCreate(...args);
    });
    await expect(login(dependencies, input, ip)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(await activeSessions()).toBe(0);
    await testEnv.DB.prepare("UPDATE users SET status='active' WHERE id='a07-user'").run();
    expect((await login(dependencies, input, ip)).user.id).toBe('a07-user');
  });

  it('propagates session persistence failures as 503 without consuming account failure budget', async () => {
    const create = vi.spyOn(sessions, 'createCookieSession').mockRejectedValueOnce(new Error('database failure on insert'));
    await expect(login(dependencies, input, ip)).rejects.toMatchObject({ code: 'service_unavailable' });
    create.mockRestore();
    expect((await login(dependencies, input, ip)).user.id).toBe('a07-user');
  });
});
