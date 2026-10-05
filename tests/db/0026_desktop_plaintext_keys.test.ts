import { applyD1Migrations } from 'cloudflare:test';
import { expect, inject, it } from 'vitest';
import { resetTestDatabase, testEnv } from '../helpers/database';
import { preparePlatformKeyCreation } from '../../apps/worker/auth/key-creation';
import { generateToken, hashToken } from '../../apps/worker/auth/tokens';
import { authenticateDesktopSession } from '../../apps/worker/auth/desktop/authenticate';
import { createDesktopSession } from '../../apps/worker/auth/desktop/session-repository';
import { getOrCreateCurrentKey } from '../../apps/worker/auth/desktop/keys';
import { cleanupExpiredDesktopSessionSecrets } from '../../apps/worker/auth/desktop/cleanup';

it('preserves legacy ciphertext, revokes its credentials, and lets a new login obtain a usable plaintext key', async () => {
  const migrations = inject('d1Migrations');
  await resetTestDatabase(migrations.filter(migration => migration.name < '0026'));
  const now = Date.now();
  const expiresAt = now + 60_000;
  await testEnv.DB.prepare(`INSERT INTO users
    (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES ('legacy-owner','legacy@example.invalid','fixture-hash','user','active','default',2,60,'admin',?,?)`)
    .bind(now, now).run();

  const legacyToken = generateToken('desktopSession');
  await testEnv.DB.prepare(`INSERT INTO desktop_sessions
    (id,token_hash,user_id,expires_at,key_generation,created_at,updated_at)
    VALUES ('legacy-session',?,'legacy-owner',?,0,?,?)`)
    .bind(await hashToken('desktopSession', legacyToken), expiresAt, now, now).run();
  const emptyToken = generateToken('desktopSession');
  await testEnv.DB.prepare(`INSERT INTO desktop_sessions
    (id,token_hash,user_id,expires_at,key_generation,created_at,updated_at)
    VALUES ('empty-session',?,'legacy-owner',?,0,?,?)`)
    .bind(await hashToken('desktopSession', emptyToken), expiresAt, now, now).run();
  const legacyKey = await preparePlatformKeyCreation(testEnv.DB, 'legacy-owner', {
    operationId: 'legacy-key', name: 'Legacy key', expiresAt,
  }, now, { desktopSessionId: 'legacy-session' });
  await legacyKey.statement.run();
  const ordinaryKey = await preparePlatformKeyCreation(testEnv.DB, 'legacy-owner', {
    operationId: 'ordinary-key', name: 'Ordinary key', expiresAt,
  }, now);
  await ordinaryKey.statement.run();
  const ciphertext = '{"algorithm":"A256GCM","ciphertext":"retained-legacy-fixture"}';
  await testEnv.DB.prepare(`UPDATE desktop_sessions
    SET current_key_id=?,current_key_ciphertext=?,key_generation=1 WHERE id='legacy-session'`)
    .bind(legacyKey.candidate.id, ciphertext).run();

  await applyD1Migrations(testEnv.DB, migrations.filter(migration => migration.name.startsWith('0026_')));

  expect(await testEnv.DB.prepare(`SELECT current_key_id,current_key,current_key_ciphertext,revoked_at
    FROM desktop_sessions WHERE id='legacy-session'`).first())
    .toEqual({ current_key_id: legacyKey.candidate.id, current_key: null, current_key_ciphertext: ciphertext, revoked_at: expect.any(Number) });
  expect(await testEnv.DB.prepare('SELECT status FROM api_keys WHERE id=?').bind(legacyKey.candidate.id).first('status'))
    .toBe('revoked');
  expect(await testEnv.DB.prepare('SELECT status FROM api_keys WHERE id=?').bind(ordinaryKey.candidate.id).first('status'))
    .toBe('active');
  const request = (token: string) => new Request('https://example.invalid', { headers: { Authorization: `Bearer ${token}` } });
  await expect(authenticateDesktopSession(testEnv.DB, request(legacyToken), now)).rejects.toMatchObject({ reason: 'session_revoked' });
  expect((await authenticateDesktopSession(testEnv.DB, request(emptyToken), now)).session.id).toBe('empty-session');

  const fresh = await createDesktopSession(testEnv.DB, 'legacy-owner', now);
  const [key, retry] = await Promise.all([
    getOrCreateCurrentKey(testEnv.DB, fresh.session, now),
    getOrCreateCurrentKey(testEnv.DB, fresh.session, now),
  ]);
  expect(retry).toEqual(key);
  expect(await testEnv.DB.prepare('SELECT current_key FROM desktop_sessions WHERE id=?').bind(fresh.session.id).first('current_key'))
    .toBe(key.key);

  await cleanupExpiredDesktopSessionSecrets(testEnv.DB, fresh.session.expires_at);
  expect(await testEnv.DB.prepare('SELECT current_key FROM desktop_sessions WHERE id=?').bind(fresh.session.id).first('current_key')).toBeNull();
  expect(await testEnv.DB.prepare("SELECT current_key_ciphertext FROM desktop_sessions WHERE id='legacy-session'").first('current_key_ciphertext'))
    .toBe(ciphertext);
  expect((await testEnv.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
});
