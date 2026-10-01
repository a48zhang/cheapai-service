-- Legacy Keys keep NULL creation metadata. New idempotent creates use a scoped
-- operation ID plus a canonical request SHA-256 fingerprint, never the secret.
ALTER TABLE api_keys ADD COLUMN creation_operation_id TEXT CHECK (
  creation_operation_id IS NULL OR (
    typeof(creation_operation_id) = 'text'
    AND length(creation_operation_id) BETWEEN 1 AND 128
    AND creation_operation_id NOT GLOB '*[^A-Za-z0-9_.:-]*'
  )
);

ALTER TABLE api_keys ADD COLUMN creation_fingerprint TEXT CHECK (
  (creation_operation_id IS NULL AND creation_fingerprint IS NULL)
  OR (
    creation_operation_id IS NOT NULL AND creation_fingerprint IS NOT NULL
    AND typeof(creation_fingerprint) = 'text'
    AND length(creation_fingerprint) = 64
    AND creation_fingerprint NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE UNIQUE INDEX idx_api_keys_owner_creation_operation
  ON api_keys (user_id, creation_operation_id)
  WHERE creation_operation_id IS NOT NULL;

-- Updates may change display/name/expiry/status/restrictions, but may not move a
-- Key to another owner or rewrite/erase its original idempotency identity.
-- IS NOT is null-safe and also protects legacy NULL pairs from reassignment.
CREATE TRIGGER api_keys_creation_identity_immutable
BEFORE UPDATE OF user_id, creation_operation_id, creation_fingerprint ON api_keys
WHEN NEW.user_id IS NOT OLD.user_id
  OR NEW.creation_operation_id IS NOT OLD.creation_operation_id
  OR NEW.creation_fingerprint IS NOT OLD.creation_fingerprint
BEGIN
  SELECT RAISE(ABORT, 'api_key_creation_identity_immutable');
END;
