-- New sessions persist their returnable API token directly. Keep legacy
-- ciphertext as history; it cannot be recovered without the removed keyring.
ALTER TABLE desktop_sessions ADD COLUMN current_key TEXT
  CHECK (current_key IS NULL OR (length(current_key) > 0 AND current_key_id IS NOT NULL));

-- Existing encrypted sessions must sign in again. Revoke their API Keys too
-- so a cached credential cannot outlive the session transition. No rows or
-- legacy ciphertext are deleted, and sessions without encrypted keys survive.
UPDATE api_keys
SET status = 'revoked',
    updated_at = MAX(updated_at, unixepoch() * 1000),
    version = CASE WHEN version < 9007199254740991 THEN version + 1 ELSE version END
WHERE status = 'active' AND desktop_session_id IN (
  SELECT id FROM desktop_sessions WHERE current_key_ciphertext IS NOT NULL
);

UPDATE desktop_sessions
SET revoked_at = COALESCE(revoked_at, MAX(created_at, unixepoch() * 1000)),
    updated_at = MAX(updated_at, unixepoch() * 1000)
WHERE current_key_ciphertext IS NOT NULL;
