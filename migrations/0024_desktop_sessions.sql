-- A desktop bearer has its own row and lifetime. Keep plaintext tokens out of
-- D1; the current API Key ciphertext exists only so the same Key can be
-- returned to this session after a restart or a retried request.
CREATE TABLE desktop_sessions (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(id)) > 0),
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  expires_at INTEGER NOT NULL CHECK (
    typeof(expires_at) = 'integer' AND expires_at BETWEEN 0 AND 9007199254740991 AND expires_at > created_at
  ),
  revoked_at INTEGER CHECK (
    revoked_at IS NULL OR (typeof(revoked_at) = 'integer' AND revoked_at BETWEEN 0 AND 9007199254740991)
  ),
  current_key_id TEXT REFERENCES api_keys(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  current_key_ciphertext TEXT,
  key_generation INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(key_generation) = 'integer' AND key_generation BETWEEN 0 AND 9007199254740991
  ),
  created_at INTEGER NOT NULL CHECK (
    typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991
  ),
  updated_at INTEGER NOT NULL CHECK (
    typeof(updated_at) = 'integer' AND updated_at BETWEEN 0 AND 9007199254740991
  ),
  CHECK (current_key_id IS NOT NULL OR current_key_ciphertext IS NULL),
  CHECK (current_key_ciphertext IS NULL OR length(current_key_ciphertext) > 0)
);

CREATE INDEX idx_desktop_sessions_user_expires ON desktop_sessions(user_id, expires_at);
CREATE INDEX idx_desktop_sessions_expires ON desktop_sessions(expires_at);
CREATE INDEX idx_desktop_sessions_revoked ON desktop_sessions(revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX idx_desktop_sessions_current_key ON desktop_sessions(current_key_id) WHERE current_key_id IS NOT NULL;

-- Existing API and web_chat rows remain unbound. Only ordinary API Keys may
-- carry this nullable ownership link.
ALTER TABLE api_keys ADD COLUMN desktop_session_id TEXT
  REFERENCES desktop_sessions(id) ON DELETE RESTRICT ON UPDATE RESTRICT
  CHECK (desktop_session_id IS NULL OR kind = 'api');

CREATE INDEX idx_api_keys_desktop_session
  ON api_keys(desktop_session_id) WHERE desktop_session_id IS NOT NULL;

-- The two single-column foreign keys establish existence. These guards also
-- bind both directions to the same user and session, including current_key_id.
CREATE TRIGGER api_keys_desktop_session_insert
BEFORE INSERT ON api_keys
WHEN NEW.desktop_session_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM desktop_sessions s
    WHERE s.id = NEW.desktop_session_id AND s.user_id = NEW.user_id
  )
BEGIN
  SELECT RAISE(ABORT, 'api_key_desktop_session_mismatch');
END;

CREATE TRIGGER api_keys_desktop_session_update
BEFORE UPDATE OF desktop_session_id, user_id, kind ON api_keys
WHEN NEW.desktop_session_id IS NOT NULL
  AND (NEW.kind <> 'api' OR NOT EXISTS (
    SELECT 1 FROM desktop_sessions s
    WHERE s.id = NEW.desktop_session_id AND s.user_id = NEW.user_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'api_key_desktop_session_mismatch');
END;

CREATE TRIGGER api_keys_desktop_session_immutable
BEFORE UPDATE OF desktop_session_id ON api_keys
WHEN NEW.desktop_session_id IS NOT OLD.desktop_session_id
BEGIN
  SELECT RAISE(ABORT, 'api_key_desktop_session_immutable');
END;

CREATE TRIGGER desktop_sessions_current_key_insert
BEFORE INSERT ON desktop_sessions
WHEN NEW.current_key_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM api_keys k
    WHERE k.id = NEW.current_key_id AND k.user_id = NEW.user_id
      AND k.desktop_session_id = NEW.id AND k.kind = 'api'
  )
BEGIN
  SELECT RAISE(ABORT, 'desktop_session_current_key_mismatch');
END;

CREATE TRIGGER desktop_sessions_current_key_update
BEFORE UPDATE OF id, user_id, current_key_id ON desktop_sessions
WHEN NEW.current_key_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM api_keys k
    WHERE k.id = NEW.current_key_id AND k.user_id = NEW.user_id
      AND k.desktop_session_id = NEW.id AND k.kind = 'api'
  )
BEGIN
  SELECT RAISE(ABORT, 'desktop_session_current_key_mismatch');
END;

CREATE TRIGGER desktop_sessions_identity_immutable
BEFORE UPDATE OF id, token_hash, user_id, created_at ON desktop_sessions
WHEN NEW.id IS NOT OLD.id OR NEW.token_hash IS NOT OLD.token_hash
  OR NEW.user_id IS NOT OLD.user_id OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'desktop_session_identity_immutable');
END;
