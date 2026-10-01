-- A18 contract: generate/hash the password and verify submitted credentials before
-- ONE INSERT INTO users ... SELECT ... WHERE statement. Its WHERE must match the
-- submitted invitation hash and current challenge id/generation/code_mac plus
-- policy/state. Never split that final credential check from INSERT with network
-- work. These triggers cannot see a submitted code and DO NOT verify its HMAC.
-- A18 supplies server UTC milliseconds as created_at and, when verified, the
-- same email_verified_at. Expiration is also checked against database time.

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
