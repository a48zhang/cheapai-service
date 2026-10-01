import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSessionCookie, createCookieSession, readCookieSession, revokeCookieSession, SESSION_COOKIE_NAME } from '../../apps/worker/auth/sessions';
import { SessionCreationError } from '../../apps/worker/auth/session-repository';
import * as tokens from '../../apps/worker/auth/tokens';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const now = 1_788_619_000_000;
const userId = 'a03-user';
const requestCookie = (setCookie: string): string => setCookie.split(';')[0]!;

beforeEach(async () => {
  await prepare(testEnv.DB,
    'INSERT INTO groups (id, name, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['a03-group', 'A03 Test Group', 'active', 1, now, now]).run();
  await prepare(testEnv.DB,
    `INSERT INTO users (id, email_normalized, password_hash, role, status, group_id,
     concurrency_limit, rpm_limit, created_via, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, 'a03@example.invalid', 'test-only-hash', 'user', 'active', 'a03-group', 2, 60, 'admin', now, now]).run();
});

describe('cookie sessions on native D1', () => {
  it('issues a seven-day secure host-only cookie and stores only its hash', async () => {
    const issued = await createCookieSession(testEnv.DB, userId, now);
    expect(issued.setCookie).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=s2a_session_[A-Za-z0-9_-]{43};`));
    expect(issued.setCookie).toContain('; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=604800;');
    expect(issued.setCookie).toContain(`Expires=${new Date(now + 604_800_000).toUTCString()}`);
    expect(issued.setCookie).not.toContain('Domain=');
    const raw = requestCookie(issued.setCookie).slice(SESSION_COOKIE_NAME.length + 1);
    const row = await prepare(testEnv.DB, 'SELECT * FROM sessions WHERE id = ?', [issued.session.id]).first();
    expect(row?.token_hash).toBe(await tokens.hashToken('session', raw));
    expect(JSON.stringify(row)).not.toContain(raw);
    expect(JSON.stringify(issued.session)).not.toContain(raw);
    expect(issued.session.expires_at).toBe(now + 604_800_000);
    expect(await readCookieSession(testEnv.DB, `other=value; ${requestCookie(issued.setCookie)}`, now)).toEqual(issued.session);
  });

  it('uses fresh login tokens and IDs, never accepting caller-selected tokens', async () => {
    const first = await createCookieSession(testEnv.DB, userId, now);
    const second = await createCookieSession(testEnv.DB, userId, now);
    expect(requestCookie(first.setCookie)).not.toBe(requestCookie(second.setCookie));
    expect(first.session.id).not.toBe(second.session.id);
  });

  it('keeps expiry fixed and rejects now equal to expiry', async () => {
    const issued = await createCookieSession(testEnv.DB, userId, now, { sessionTtlMs: 60_000 });
    const cookie = requestCookie(issued.setCookie);
    expect(issued.setCookie).toContain('Max-Age=60;');
    expect(await readCookieSession(testEnv.DB, cookie, now + 59_999)).toEqual(issued.session);
    expect(await readCookieSession(testEnv.DB, cookie, now + 60_000)).toBeNull();
    expect((await prepare(testEnv.DB, 'SELECT expires_at FROM sessions WHERE id = ?', [issued.session.id]).first())?.expires_at)
      .toBe(now + 60_000);
  });

  it('revokes on logout and clears the same cookie attributes idempotently', async () => {
    const issued = await createCookieSession(testEnv.DB, userId, now);
    const cookie = requestCookie(issued.setCookie);
    const cleared = await revokeCookieSession(testEnv.DB, cookie, now + 1);
    expect(cleared).toBe(`${SESSION_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
    expect(await readCookieSession(testEnv.DB, cookie, now + 1)).toBeNull();
    expect(await revokeCookieSession(testEnv.DB, cookie, now + 2)).toBe(cleared);
    expect((await prepare(testEnv.DB, 'SELECT revoked_at FROM sessions WHERE id = ?', [issued.session.id]).first())?.revoked_at).toBe(now + 1);
  });

  it('revokes even a disabled user session so later reactivation cannot revive it', async () => {
    const issued = await createCookieSession(testEnv.DB, userId, now);
    await prepare(testEnv.DB, 'UPDATE users SET status = ? WHERE id = ?', ['disabled', userId]).run();
    const cookie = requestCookie(issued.setCookie);
    expect(await readCookieSession(testEnv.DB, cookie, now + 1)).toBeNull();
    await revokeCookieSession(testEnv.DB, cookie, now + 2);
    await prepare(testEnv.DB, 'UPDATE users SET status = ? WHERE id = ?', ['active', userId]).run();
    expect(await readCookieSession(testEnv.DB, cookie, now + 3)).toBeNull();
  });

  it('does not issue a cookie when active-user conditional creation fails', async () => {
    await prepare(testEnv.DB, 'UPDATE users SET status = ? WHERE id = ?', ['disabled', userId]).run();
    await expect(createCookieSession(testEnv.DB, userId, now)).rejects.toThrow(SessionCreationError);
    expect((await prepare(testEnv.DB, 'SELECT COUNT(*) AS count FROM sessions').first())?.count).toBe(0);
  });

  it('rejects duplicate generated tokens through the D1 uniqueness constraint', async () => {
    const token = tokens.generateToken('session');
    const spy = vi.spyOn(tokens, 'generateToken').mockReturnValue(token);
    try {
      await createCookieSession(testEnv.DB, userId, now);
      await expect(createCookieSession(testEnv.DB, userId, now)).rejects.toThrow();
      expect((await prepare(testEnv.DB, 'SELECT COUNT(*) AS count FROM sessions').first())?.count).toBe(1);
    } finally { spy.mockRestore(); }
  });

  it('rejects duplicate cookie names without revoking or choosing either value', async () => {
    const issued = await createCookieSession(testEnv.DB, userId, now);
    const cookie = requestCookie(issued.setCookie);
    for (const duplicate of [`${cookie}; ${cookie}`, `${cookie}; ${SESSION_COOKIE_NAME}=bad`, `${SESSION_COOKIE_NAME}; ${cookie}`]) {
      expect(await readCookieSession(testEnv.DB, duplicate, now)).toBeNull();
      expect(await revokeCookieSession(testEnv.DB, duplicate, now)).toBe(clearSessionCookie());
    }
    expect(await readCookieSession(testEnv.DB, cookie, now)).not.toBeNull();
  });

  it.each([null, '', 'other=value', `${SESSION_COOKIE_NAME}=bad`, `${SESSION_COOKIE_NAME}=%73${'a'.repeat(54)}`,
    `${SESSION_COOKIE_NAME}="s2a_session_${'A'.repeat(43)}"`, `${SESSION_COOKIE_NAME}=s2a_key_${'A'.repeat(43)}`])
    ('rejects malformed credentials before touching D1 %#', async (cookie) => {
      const database = { prepare: vi.fn(() => { throw new Error('Unexpected database access'); }) } as unknown as D1Database;
      expect(await readCookieSession(database, cookie, now)).toBeNull();
      expect(await revokeCookieSession(database, cookie, now)).toBe(clearSessionCookie());
      expect(database.prepare).not.toHaveBeenCalled();
    });

  it.each([0, 59_999, 30 * 86_400_000 + 1, NaN, 60_000.5])('rejects invalid TTL %s', async (sessionTtlMs) => {
    await expect(createCookieSession(testEnv.DB, userId, now, { sessionTtlMs })).rejects.toThrow(TypeError);
  });
});
