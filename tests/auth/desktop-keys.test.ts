import { beforeEach, describe, expect, it } from 'vitest';
import { authenticateDesktopSession } from '../../apps/worker/auth/desktop/authenticate';
import { createDesktopSession } from '../../apps/worker/auth/desktop/session-repository';
import { getOrCreateCurrentKey } from '../../apps/worker/auth/desktop/keys';
import { DESKTOP_KEY_MAX_TTL_MS } from '../../apps/worker/auth/desktop/types';
import { hashToken, verifyToken } from '../../apps/worker/auth/tokens';
import { revokePlatformKey } from '../../apps/worker/auth/key-repository';
import { testEnv } from '../helpers/database';

const now = 1_788_619_000_123;
const day = 24 * 60 * 60 * 1000;
const groupId = 'desktop-keys-group';
const userId = 'desktop-keys-owner';
const encryptionKey = { keyVersion: 'desktop-test-v1', key: new Uint8Array(32).fill(23) };
const keyring = new Map([[encryptionKey.keyVersion, encryptionKey.key]]);

async function desktopKey(token: string, at = now) {
  const authenticated = await authenticateDesktopSession(testEnv.DB,
    new Request('https://example.invalid', { headers: { Authorization: `Bearer ${token}` } }), at);
  return getOrCreateCurrentKey(testEnv.DB, authenticated.session, at, encryptionKey, keyring);
}

async function sessionState(sessionId: string) {
  return testEnv.DB.prepare(`SELECT current_key_id,current_key_ciphertext,key_generation,expires_at
    FROM desktop_sessions WHERE id=?`).bind(sessionId).first<{
      current_key_id: string | null;
      current_key_ciphertext: string | null;
      key_generation: number;
      expires_at: number;
    }>();
}

beforeEach(async () => {
  await testEnv.DB.prepare('INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES (?,?,?,1,?,?)')
    .bind(groupId, 'Desktop test group', 'active', now, now).run();
  await testEnv.DB.prepare(`INSERT INTO users
    (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES (?,?,'test-only-hash','user','active',?,2,60,'admin',?,?)`)
    .bind(userId, `${userId}@example.invalid`, groupId, now, now).run();
});

describe('desktop session API Keys on native D1', () => {
  it('returns the same Key when the same Token retries after a lost response', async () => {
    const issued = await createDesktopSession(testEnv.DB, userId, now);
    const first = await desktopKey(issued.token);
    // Treat the first committed response as lost; the client retries its same bearer.
    const retry = await desktopKey(issued.token);

    expect(retry).toEqual(first);
    const state = await sessionState(issued.session.id);
    const storedKey = await testEnv.DB.prepare('SELECT key_hash,status,desktop_session_id FROM api_keys WHERE id=?')
      .bind(first.keyId).first<{ key_hash: string; status: string; desktop_session_id: string | null }>();
    expect(state).toMatchObject({ current_key_id: first.keyId, key_generation: 1, expires_at: issued.session.expires_at });
    expect(state?.current_key_ciphertext).toBeTruthy();
    expect(state?.current_key_ciphertext).not.toContain(first.key);
    expect(storedKey).toMatchObject({ key_hash: await hashToken('apiKey', first.key), status: 'active', desktop_session_id: issued.session.id });
    expect(await verifyToken('apiKey', retry.key, storedKey?.key_hash)).toBe(true);
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM api_keys WHERE desktop_session_id=?')
      .bind(issued.session.id).first<{ count: number }>())?.count).toBe(1);
  });

  it('isolates Keys for distinct Tokens owned by the same user', async () => {
    const firstSession = await createDesktopSession(testEnv.DB, userId, now);
    const secondSession = await createDesktopSession(testEnv.DB, userId, now);
    const [first, second] = await Promise.all([
      desktopKey(firstSession.token), desktopKey(secondSession.token),
    ]);

    expect(firstSession.token).not.toBe(secondSession.token);
    expect(firstSession.session.id).not.toBe(secondSession.session.id);
    expect(first.keyId).not.toBe(second.keyId);
    expect(first.key).not.toBe(second.key);
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM api_keys WHERE desktop_session_id IN (?,?) AND status=\'active\'')
      .bind(firstSession.session.id, secondSession.session.id).first<{ count: number }>())?.count).toBe(2);
    expect(await testEnv.DB.prepare('SELECT current_key_id FROM desktop_sessions WHERE id=?')
      .bind(firstSession.session.id).first<{ current_key_id: string }>()).toEqual({ current_key_id: first.keyId });
    expect(await testEnv.DB.prepare('SELECT current_key_id FROM desktop_sessions WHERE id=?')
      .bind(secondSession.session.id).first<{ current_key_id: string }>()).toEqual({ current_key_id: second.keyId });
  });

  it('commits only one Key for concurrent first retrievals', async () => {
    const issued = await createDesktopSession(testEnv.DB, userId, now);
    const [first, second] = await Promise.all([
      desktopKey(issued.token), desktopKey(issued.token),
    ]);

    expect(first).toEqual(second);
    expect(await sessionState(issued.session.id)).toMatchObject({ current_key_id: first.keyId, key_generation: 1 });
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM api_keys WHERE desktop_session_id=? AND status=\'active\'')
      .bind(issued.session.id).first<{ count: number }>())?.count).toBe(1);
  });

  it('atomically rotates one expired Key for concurrent retrievals', async () => {
    const issued = await createDesktopSession(testEnv.DB, userId, now);
    const original = await desktopKey(issued.token);
    const rotationTime = original.expiresAt;
    const [first, retry] = await Promise.all([
      desktopKey(issued.token, rotationTime), desktopKey(issued.token, rotationTime),
    ]);

    expect(first).toEqual(retry);
    expect(first.keyId).not.toBe(original.keyId);
    expect(first.key).not.toBe(original.key);
    expect(first.expiresAt).toBe(rotationTime + DESKTOP_KEY_MAX_TTL_MS);
    expect(await sessionState(issued.session.id)).toMatchObject({ current_key_id: first.keyId, key_generation: 2 });
    expect(await testEnv.DB.prepare('SELECT status FROM api_keys WHERE id=?').bind(original.keyId)
      .first<{ status: string }>()).toEqual({ status: 'revoked' });
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM api_keys WHERE desktop_session_id=? AND status=\'active\'')
      .bind(issued.session.id).first<{ count: number }>())?.count).toBe(1);
  });

  it('caps Key expiry at the parent session expiry', async () => {
    const issued = await createDesktopSession(testEnv.DB, userId, now);
    const shortSessionExpiry = now + day;
    await testEnv.DB.prepare('UPDATE desktop_sessions SET expires_at=? WHERE id=?')
      .bind(shortSessionExpiry, issued.session.id).run();

    const key = await desktopKey(issued.token);
    expect(key.expiresAt).toBe(shortSessionExpiry);
    expect(await sessionState(issued.session.id)).toMatchObject({ expires_at: shortSessionExpiry, current_key_id: key.keyId });
  });

  it('does not reactivate a manually revoked bound Key', async () => {
    const issued = await createDesktopSession(testEnv.DB, userId, now);
    const key = await desktopKey(issued.token);
    expect(await revokePlatformKey(testEnv.DB, userId, key.keyId, 1, now + 1)).toMatchObject({ kind: 'revoked' });

    await expect(desktopKey(issued.token, now + 2)).rejects.toMatchObject({ reason: 'key_revoked' });
    expect(await sessionState(issued.session.id)).toMatchObject({ current_key_id: key.keyId, key_generation: 1 });
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM api_keys WHERE desktop_session_id=?')
      .bind(issued.session.id).first<{ count: number }>())?.count).toBe(1);
  });

  it('fails closed on damaged ciphertext without issuing a replacement', async () => {
    const issued = await createDesktopSession(testEnv.DB, userId, now);
    const key = await desktopKey(issued.token);
    await testEnv.DB.prepare('UPDATE desktop_sessions SET current_key_ciphertext=? WHERE id=?')
      .bind('damaged-envelope', issued.session.id).run();

    await expect(desktopKey(issued.token, now + 1)).rejects.toMatchObject({ reason: 'binding_unavailable' });
    expect(await sessionState(issued.session.id)).toMatchObject({ current_key_id: key.keyId, current_key_ciphertext: 'damaged-envelope', key_generation: 1 });
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM api_keys WHERE desktop_session_id=?')
      .bind(issued.session.id).first<{ count: number }>())?.count).toBe(1);
  });
});
