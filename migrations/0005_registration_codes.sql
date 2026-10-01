-- Plaintext invitation secrets are returned once by application code, never stored.
-- No credit balance or automatic grant is attached to a registration code.
CREATE TABLE registration_codes (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(id)) > 0),
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
  display_prefix TEXT NOT NULL CHECK (
    length(display_prefix) = 19 AND substr(display_prefix, 1, 11) = 's2a_invite_'
    AND substr(display_prefix, 12) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  expires_at INTEGER CHECK (
    expires_at IS NULL OR (typeof(expires_at) = 'integer' AND expires_at BETWEEN 0 AND 9007199254740991 AND expires_at > created_at)
  ),
  revoked_at INTEGER CHECK (
    revoked_at IS NULL OR (typeof(revoked_at) = 'integer' AND revoked_at BETWEEN 0 AND 9007199254740991)
  ),
  used_by TEXT REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  used_at INTEGER CHECK (
    used_at IS NULL OR (typeof(used_at) = 'integer' AND used_at BETWEEN 0 AND 9007199254740991)
  ),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
  operation_id TEXT NOT NULL CHECK (length(trim(operation_id)) > 0),
  -- Zero-based position within the generation operation; no secret in the map.
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal BETWEEN 0 AND 9007199254740991),
  UNIQUE (operation_id, ordinal),
  CHECK ((used_by IS NULL AND used_at IS NULL) OR (used_by IS NOT NULL AND used_at IS NOT NULL))
);

CREATE INDEX idx_registration_codes_creator_created ON registration_codes (created_by, created_at, id);
CREATE INDEX idx_registration_codes_used_by ON registration_codes (used_by) WHERE used_by IS NOT NULL;
CREATE INDEX idx_registration_codes_expires ON registration_codes (expires_at) WHERE expires_at IS NOT NULL;

-- users.registration_code_id remains a nullable provenance identifier for now.
-- D12 owns atomic registration/consumption validation; no forward/cyclic insert
-- requirement or blanket prohibition on updating used codes is introduced here.
