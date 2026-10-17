-- Remove invitation issuance quantity/expiry policy while preserving credentials,
-- durable idempotency claims, references and atomic registration consumption.
DROP TRIGGER users_registration_guard;
DROP TRIGGER users_registration_consume;

CREATE TABLE registration_code_batches_unbounded (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(id)) > 0),
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  operation_id TEXT NOT NULL CHECK (length(trim(operation_id)) > 0),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity >= 1),
  expires_at INTEGER CHECK (
    expires_at IS NULL OR (typeof(expires_at) = 'integer' AND expires_at BETWEEN 0 AND 9007199254740991)
  ),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (actor_id, operation_id)
);

INSERT INTO registration_code_batches_unbounded
  (id,actor_id,operation_id,fingerprint,quantity,expires_at,created_at)
SELECT id,actor_id,operation_id,fingerprint,quantity,expires_at,created_at FROM registration_code_batches;
DROP TABLE registration_code_batches;
ALTER TABLE registration_code_batches_unbounded RENAME TO registration_code_batches;

CREATE TABLE registration_codes_unbounded (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(id)) > 0),
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
  display_prefix TEXT NOT NULL CHECK (
    length(display_prefix) = 19 AND substr(display_prefix, 1, 11) = 's2a_invite_'
    AND substr(display_prefix, 12) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  expires_at INTEGER CHECK (
    expires_at IS NULL OR (typeof(expires_at) = 'integer' AND expires_at BETWEEN 0 AND 9007199254740991)
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

INSERT INTO registration_codes_unbounded
  (id,code_hash,display_prefix,expires_at,revoked_at,used_by,used_at,created_by,created_at,operation_id,ordinal)
SELECT id,code_hash,display_prefix,expires_at,revoked_at,used_by,used_at,created_by,created_at,operation_id,ordinal FROM registration_codes;
DROP TABLE registration_codes;
ALTER TABLE registration_codes_unbounded RENAME TO registration_codes;

CREATE INDEX idx_registration_codes_creator_created ON registration_codes (created_by, created_at, id);
CREATE INDEX idx_registration_codes_used_by ON registration_codes (used_by) WHERE used_by IS NOT NULL;
CREATE INDEX idx_registration_codes_expires ON registration_codes (expires_at) WHERE expires_at IS NOT NULL;

CREATE TRIGGER users_registration_guard
BEFORE INSERT ON users
WHEN NEW.created_via = 'registration'
BEGIN
  SELECT RAISE(ABORT, 'registration_policy_rejected') WHERE
    NEW.role != 'user' OR NEW.balance_units != 0 OR NOT EXISTS (
      SELECT 1 FROM settings WHERE key = 'registration'
        AND json_type(value_json) = 'object'
        AND json_extract(value_json, '$.registrationMode') IN ('open', 'invite')
        AND json_type(value_json, '$.emailVerificationEnabled') IN ('true', 'false')
    ) OR NOT EXISTS (
      SELECT 1 FROM settings s JOIN groups g ON g.id = json_extract(s.value_json, '$')
      WHERE s.key = 'default_group_id' AND json_type(s.value_json) = 'text'
        AND g.id = NEW.group_id AND g.status = 'active'
    );

  SELECT RAISE(ABORT, 'registration_invitation_rejected') WHERE
    (SELECT json_extract(value_json, '$.registrationMode') FROM settings WHERE key = 'registration') = 'open'
      AND NEW.registration_code_id IS NOT NULL;

  SELECT RAISE(ABORT, 'registration_invitation_rejected') WHERE
    (SELECT json_extract(value_json, '$.registrationMode') FROM settings WHERE key = 'registration') = 'invite'
    AND NOT EXISTS (
      SELECT 1 FROM registration_codes WHERE id = NEW.registration_code_id
        AND used_by IS NULL AND used_at IS NULL AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER))
    );

  SELECT RAISE(ABORT, 'registration_email_rejected') WHERE
    (SELECT json_extract(value_json, '$.emailVerificationEnabled') FROM settings WHERE key = 'registration') = 0
      AND NEW.email_verified_at IS NOT NULL;

  SELECT RAISE(ABORT, 'registration_email_rejected') WHERE
    (SELECT json_extract(value_json, '$.emailVerificationEnabled') FROM settings WHERE key = 'registration') = 1
    AND (NEW.email_verified_at IS NULL OR NEW.email_verified_at != NEW.created_at OR NOT EXISTS (
      SELECT 1 FROM email_challenges WHERE email_normalized = NEW.email_normalized AND purpose = 'registration'
        AND send_status = 'accepted' AND consumed_at IS NULL AND attempts < 5
        AND expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    ));
END;

CREATE TRIGGER users_registration_consume
AFTER INSERT ON users
WHEN NEW.created_via = 'registration'
BEGIN
  UPDATE registration_codes SET used_by = NEW.id, used_at = NEW.created_at
  WHERE id = NEW.registration_code_id AND used_by IS NULL AND used_at IS NULL AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER))
    AND (SELECT json_extract(value_json, '$.registrationMode') FROM settings WHERE key = 'registration') = 'invite';
  SELECT RAISE(ABORT, 'registration_invitation_consumption_failed') WHERE
    (SELECT json_extract(value_json, '$.registrationMode') FROM settings WHERE key = 'registration') = 'invite'
      AND changes() != 1;

  UPDATE email_challenges SET consumed_at = NEW.created_at, updated_at = NEW.created_at
  WHERE email_normalized = NEW.email_normalized AND purpose = 'registration'
    AND send_status = 'accepted' AND consumed_at IS NULL AND attempts < 5
    AND expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND (SELECT json_extract(value_json, '$.emailVerificationEnabled') FROM settings WHERE key = 'registration') = 1;
  SELECT RAISE(ABORT, 'registration_email_consumption_failed') WHERE
    (SELECT json_extract(value_json, '$.emailVerificationEnabled') FROM settings WHERE key = 'registration') = 1
      AND changes() != 1;
END;
