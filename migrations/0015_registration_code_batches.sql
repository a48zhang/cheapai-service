-- Durable idempotency claim for invitation generation. Payload fingerprints
-- contain no invitation secret; registration_codes.operation_id stores this id.
CREATE TABLE registration_code_batches (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(id)) > 0),
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  operation_id TEXT NOT NULL CHECK (length(trim(operation_id)) > 0),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity BETWEEN 1 AND 100),
  expires_at INTEGER CHECK (
    expires_at IS NULL OR (typeof(expires_at) = 'integer' AND expires_at BETWEEN 0 AND 9007199254740991 AND expires_at > created_at)
  ),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (actor_id, operation_id)
);
