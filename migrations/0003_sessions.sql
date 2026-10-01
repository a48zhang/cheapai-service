-- Store only F13's SHA-256 digest (64 lowercase hexadecimal characters).
-- No plaintext token, sliding-expiry write or per-request last_seen column.
CREATE TABLE sessions (
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
  created_at INTEGER NOT NULL CHECK (
    typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991
  )
);

CREATE INDEX idx_sessions_user_expires ON sessions (user_id, expires_at);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);
CREATE INDEX idx_sessions_revoked ON sessions (revoked_at) WHERE revoked_at IS NOT NULL;
