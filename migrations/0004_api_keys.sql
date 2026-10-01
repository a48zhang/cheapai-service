-- Store F13 hashToken(apiKey, token), never the full token.
CREATE TABLE api_keys (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(id)) > 0),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  key_hash TEXT NOT NULL UNIQUE CHECK (length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'),
  -- F13 exposes exactly its 8-character purpose prefix plus 8 base64url chars.
  display_prefix TEXT NOT NULL CHECK (
    length(display_prefix) = 16 AND substr(display_prefix, 1, 8) = 's2a_key_'
    AND substr(display_prefix, 9) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  -- User-facing label only; API code must never copy credentials into the name.
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  expires_at INTEGER CHECK (
    expires_at IS NULL OR (typeof(expires_at) = 'integer' AND expires_at BETWEEN 0 AND 9007199254740991 AND expires_at > created_at)
  ),
  -- SQL NULL inherits the user's model permissions; [] grants no models.
  -- Every use must still intersect these restrictions with current user access.
  -- API validation owns individual model identifier validation.
  allowed_models_json TEXT CHECK (
    allowed_models_json IS NULL OR CASE WHEN json_valid(allowed_models_json)
      THEN json_type(allowed_models_json) = 'array' ELSE 0 END
  ),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at BETWEEN 0 AND 9007199254740991),
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version BETWEEN 1 AND 9007199254740991)
);

CREATE INDEX idx_api_keys_user_status ON api_keys (user_id, status);
CREATE INDEX idx_api_keys_expires ON api_keys (expires_at) WHERE expires_at IS NOT NULL;
