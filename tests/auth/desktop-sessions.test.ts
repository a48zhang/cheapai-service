import { beforeEach, describe, expect, it } from 'vitest';
import { authenticateDesktopSession } from '../../apps/worker/auth/desktop/authenticate';
import { logoutDesktopSession } from '../../apps/worker/auth/desktop/logout';
import { createDesktopSession } from '../../apps/worker/auth/desktop/session-repository';
import { getOrCreateCurrentKey } from '../../apps/worker/auth/desktop/keys';
import { hashToken } from '../../apps/worker/auth/tokens';
import { testEnv } from '../helpers/database';

const now = 1_788_619_000_123;
const groupId = 'desktop-sessions-group';
const userId = 'desktop-sessions-owner';

function bearer(token: string): Request {
  return new Request('https://example.invalid', { headers: { Authorization: `Bearer ${token}` } });
}

async function desktopKey(token: string, at = now) {
  const authenticated = await authenticateDesktopSession(testEnv.DB, bearer(token), at);
  return getOrCreateCurrentKey(testEnv.DB, authenticated.session, at);
}

beforeEach(async () => {
  await testEnv.DB.prepare('INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES (?,?,?,1,?,?)')
    .bind(groupId, 'Desktop session test group', 'active', now, now).run();
  await testEnv.DB.prepare(`INSERT INTO users
    (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES (?,?,'test-only-hash','user','active',?,2,60,'admin',?,?)`)
    .bind(userId, `${userId}@example.invalid`, groupId, now, now).run();
});

describe('desktop bearer sessions on native D1', () => {
  it('stores only a purpose-specific digest and returns a safe authenticated identity', async () => {
    const issued = await createDesktopSession(testEnv.DB, userId, now);
    const stored = await testEnv.DB.prepare('SELECT * FROM desktop_sessions WHERE id=?')
      .bind(issued.session.id).first<Record<string, unknown>>();

    expect(issued.token).toMatch(/^s2a_desktop_[A-Za-z0-9_-]{43}$/);
    expect(issued.session.expires_at).toBeGreaterThan(now);
    expect(issued.session.token_hash).toBe(await hashToken('desktopSession', issued.token));
    expect(stored?.token_hash).toBe(await hashToken('desktopSession', issued.token));
    expect(JSON.stringify(stored)).not.toContain(issued.token);
    expect(JSON.stringify(issued.session)).not.toContain(issued.token);

    const authenticated = await authenticateDesktopSession(testEnv.DB, bearer(issued.token), now);
    expect(authenticated.session).toEqual({
      id: issued.session.id, user_id: userId, expires_at: issued.session.expires_at,
    });
    expect(authenticated.session).not.toHaveProperty('token_hash');
    expect(authenticated.session).not.toHaveProperty('current_key');
  });

  it('rejects the exact expiry boundary without extending the persisted session', async () => {
    const issued = await createDesktopSession(testEnv.DB, userId, now);
    const expiresAt = now + 60_000;
    await testEnv.DB.prepare('UPDATE desktop_sessions SET expires_at=? WHERE id=?')
      .bind(expiresAt, issued.session.id).run();

    expect((await authenticateDesktopSession(testEnv.DB, bearer(issued.token), expiresAt - 1)).session.expires_at)
      .toBe(expiresAt);
    await expect(authenticateDesktopSession(testEnv.DB, bearer(issued.token), expiresAt))
      .rejects.toMatchObject({ reason: 'session_expired' });
    expect(await testEnv.DB.prepare('SELECT expires_at FROM desktop_sessions WHERE id=?')
      .bind(issued.session.id).first<{ expires_at: number }>()).toEqual({ expires_at: expiresAt });
  });

  it('logout revokes and clears only the presented session, and is safe to retry', async () => {
    const firstSession = await createDesktopSession(testEnv.DB, userId, now);
    const otherSession = await createDesktopSession(testEnv.DB, userId, now);
    const firstKey = await desktopKey(firstSession.token);
    const otherKey = await desktopKey(otherSession.token);

    await logoutDesktopSession(testEnv.DB, bearer(firstSession.token), now + 1);
    await logoutDesktopSession(testEnv.DB, bearer(firstSession.token), now + 2);

    const firstState = await testEnv.DB.prepare(`SELECT revoked_at,current_key_id,current_key
      FROM desktop_sessions WHERE id=?`).bind(firstSession.session.id)
      .first<{ revoked_at: number | null; current_key_id: string | null; current_key: string | null }>();
    const otherState = await testEnv.DB.prepare(`SELECT revoked_at,current_key_id,current_key
      FROM desktop_sessions WHERE id=?`).bind(otherSession.session.id)
      .first<{ revoked_at: number | null; current_key_id: string | null; current_key: string | null }>();

    expect(firstState).toMatchObject({ revoked_at: now + 1, current_key_id: firstKey.keyId, current_key: null });
    expect(otherState?.revoked_at).toBeNull();
    expect(otherState?.current_key_id).toBe(otherKey.keyId);
    expect(otherState?.current_key).toBeTruthy();
    expect(await testEnv.DB.prepare('SELECT status FROM api_keys WHERE id=?').bind(firstKey.keyId)
      .first<{ status: string }>()).toEqual({ status: 'revoked' });
    expect(await testEnv.DB.prepare('SELECT status FROM api_keys WHERE id=?').bind(otherKey.keyId)
      .first<{ status: string }>()).toEqual({ status: 'active' });

    await expect(authenticateDesktopSession(testEnv.DB, bearer(firstSession.token), now + 3))
      .rejects.toMatchObject({ reason: 'session_revoked' });
    expect((await authenticateDesktopSession(testEnv.DB, bearer(otherSession.token), now + 3)).session.id)
      .toBe(otherSession.session.id);
    expect(await desktopKey(otherSession.token, now + 3)).toEqual(otherKey);
  });
});
