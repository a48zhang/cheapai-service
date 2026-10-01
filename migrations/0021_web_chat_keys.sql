-- Per-user server-only web-chat identity.  SQLite cannot relax the old
-- NOT NULL/UNIQUE credential columns in place, so this migration replaces
-- the parent table in one D1 batch while preserving its name.  D1 executes a
-- migration batch atomically; deferred foreign keys keep existing requests
-- valid across DROP/RENAME and the guard below aborts any broken copy.
PRAGMA defer_foreign_keys=ON;

-- Existing names are recreated below.  The implicit UNIQUE index attached to
-- the old key_hash column disappears with the old table.
DROP INDEX idx_api_keys_user_status;
DROP INDEX idx_api_keys_expires;
DROP INDEX idx_api_keys_group;
DROP INDEX idx_api_keys_owner_creation_operation;
DROP TRIGGER api_keys_creation_identity_immutable;
DROP TRIGGER api_keys_default_group;
-- SQLite validates trigger bodies while dropping a referenced parent.  Keep
-- the complete D13 billing validation semantics by recreating this trigger
-- after the parent replacement below.
DROP TRIGGER billing_entries_validate_consumption;

CREATE TABLE api_keys_new (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(id)) > 0),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  kind TEXT NOT NULL DEFAULT 'api' CHECK (kind IN ('api','web_chat')),
  key_hash TEXT CHECK (
    (kind='web_chat' AND key_hash IS NULL)
    OR (kind='api' AND typeof(key_hash)='text' AND length(key_hash)=64 AND key_hash NOT GLOB '*[^0-9a-f]*')
  ),
  display_prefix TEXT CHECK (
    (kind='web_chat' AND display_prefix IS NULL)
    OR (kind='api' AND typeof(display_prefix)='text' AND length(display_prefix)=16
      AND substr(display_prefix,1,8)='s2a_key_'
      AND substr(display_prefix,9) NOT GLOB '*[^A-Za-z0-9_-]*')
  ),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  expires_at INTEGER CHECK (
    expires_at IS NULL OR (typeof(expires_at) = 'integer' AND expires_at BETWEEN 0 AND 9007199254740991 AND expires_at > created_at)
  ),
  allowed_models_json TEXT CHECK (
    allowed_models_json IS NULL OR CASE WHEN json_valid(allowed_models_json)
      THEN json_type(allowed_models_json) = 'array' ELSE 0 END
  ),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at BETWEEN 0 AND 9007199254740991),
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version BETWEEN 1 AND 9007199254740991),
  creation_operation_id TEXT CHECK (
    creation_operation_id IS NULL OR (
      typeof(creation_operation_id) = 'text'
      AND length(creation_operation_id) BETWEEN 1 AND 128
      AND creation_operation_id NOT GLOB '*[^A-Za-z0-9_.:-]*'
    )
  ),
  creation_fingerprint TEXT CHECK (
    (creation_operation_id IS NULL AND creation_fingerprint IS NULL)
    OR (
      creation_operation_id IS NOT NULL AND creation_fingerprint IS NOT NULL
      AND typeof(creation_fingerprint) = 'text'
      AND length(creation_fingerprint) = 64
      AND creation_fingerprint NOT GLOB '*[^0-9a-f]*'
    )
  ),
  group_id TEXT REFERENCES groups(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK (kind='api' OR (group_id IS NULL AND expires_at IS NULL AND allowed_models_json IS NULL))
);

INSERT INTO api_keys_new
  (id,user_id,kind,key_hash,display_prefix,name,status,expires_at,allowed_models_json,
   created_at,updated_at,version,creation_operation_id,creation_fingerprint,group_id)
SELECT id,user_id,'api',key_hash,display_prefix,name,status,expires_at,allowed_models_json,
  created_at,updated_at,version,creation_operation_id,creation_fingerprint,group_id
FROM api_keys;

DROP TABLE api_keys;
ALTER TABLE api_keys_new RENAME TO api_keys;

CREATE TRIGGER billing_entries_validate_consumption
BEFORE INSERT ON billing_entries
WHEN NEW.kind = 'consumption'
BEGIN
  SELECT (CASE WHEN NEW.delta_units > 0 OR NEW.request_id IS NULL
    THEN RAISE(ABORT, 'billing_invalid_consumption') END);
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM requests r JOIN api_keys k ON k.id = r.api_key_id
    WHERE r.id = NEW.request_id AND r.user_id = NEW.user_id AND k.user_id = NEW.user_id
      AND r.billing_status <> 'settled'
      AND r.price_snapshot = NEW.price_snapshot
      AND (r.fingerprint IS NULL OR r.fingerprint = NEW.fingerprint)
    ) THEN RAISE(ABORT, 'billing_request_mismatch_or_settled') END);
  SELECT (CASE WHEN NEW.usage_snapshot IS NULL OR NOT json_valid(NEW.usage_snapshot)
    THEN RAISE(ABORT, 'billing_usage_invalid') END);
  SELECT (CASE WHEN json_type(NEW.usage_snapshot) IS NOT 'object'
    OR json_extract(NEW.usage_snapshot, '$.quality') IS NOT 'complete'
    OR json_extract(NEW.usage_snapshot, '$.protocol') IS NOT (SELECT upstream_protocol FROM requests WHERE id = NEW.request_id)
    OR json_type(NEW.usage_snapshot, '$.counts') IS NOT 'object'
    OR json_type(NEW.usage_snapshot, '$.counts.inputTokens') IS NOT 'integer'
    OR json_type(NEW.usage_snapshot, '$.counts.outputTokens') IS NOT 'integer'
    OR json_type(NEW.usage_snapshot, '$.semantics') IS NOT 'object'
    OR json_type(NEW.usage_snapshot, '$.issues') IS NOT 'array'
    OR json_array_length(NEW.usage_snapshot, '$.issues') IS NOT 0
    OR json_type(NEW.usage_snapshot, '$.sources') IS NOT 'array'
    OR COALESCE(json_array_length(NEW.usage_snapshot, '$.sources'), 0) < 1
    THEN RAISE(ABORT, 'billing_usage_incomplete') END);
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.usage_snapshot, '$.counts') c
    WHERE c.key NOT IN ('inputTokens','outputTokens','totalTokens','cacheReadTokens','cacheWriteTokens','cacheWrite5mTokens','cacheWrite1hTokens','reasoningTokens')
      OR c.type <> 'integer' OR c.atom NOT BETWEEN 0 AND 9007199254740991
    ) THEN RAISE(ABORT, 'billing_usage_counts_invalid') END);
  SELECT (CASE WHEN
    COALESCE(json_extract(NEW.usage_snapshot, '$.semantics.cacheRead'), '') NOT IN ('included_in_input','excluded_from_input','unknown')
    OR COALESCE(json_extract(NEW.usage_snapshot, '$.semantics.cacheWrite'), '') NOT IN ('included_in_input','excluded_from_input','unknown')
    OR COALESCE(json_extract(NEW.usage_snapshot, '$.semantics.reasoning'), '') NOT IN ('included_in_output','excluded_from_output','unknown')
    OR COALESCE(json_extract(NEW.usage_snapshot, '$.semantics.cacheWriteTtl'), '') NOT IN ('subsets_of_cache_write','unknown')
    THEN RAISE(ABORT, 'billing_usage_semantics_invalid') END);
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.usage_snapshot, '$.sources') s
    WHERE CASE WHEN s.type = 'object' THEN
      json_extract(s.value, '$.protocol') IS NOT json_extract(NEW.usage_snapshot, '$.protocol')
      OR json_type(s.value, '$.path') IS NOT 'text'
      OR length(trim(COALESCE(json_extract(s.value, '$.path'), ''))) = 0
    ELSE 1 END
    ) THEN RAISE(ABORT, 'billing_usage_sources_invalid') END);
  SELECT (CASE WHEN
    (json_extract(NEW.usage_snapshot, '$.semantics.cacheRead') = 'unknown'
      AND json_extract(NEW.usage_snapshot, '$.counts.cacheReadTokens') IS NOT 0)
    OR (json_extract(NEW.usage_snapshot, '$.semantics.cacheWrite') = 'unknown'
      AND json_extract(NEW.usage_snapshot, '$.counts.cacheWriteTokens') IS NOT 0)
    OR (json_extract(NEW.usage_snapshot, '$.semantics.reasoning') = 'unknown'
      AND json_extract(NEW.usage_snapshot, '$.counts.reasoningTokens') IS NOT 0)
    OR (json_extract(NEW.usage_snapshot, '$.semantics.cacheRead') = 'excluded_from_input'
      AND json_type(NEW.usage_snapshot, '$.counts.cacheReadTokens') IS NOT 'integer')
    OR (json_extract(NEW.usage_snapshot, '$.semantics.cacheWrite') = 'excluded_from_input'
      AND json_type(NEW.usage_snapshot, '$.counts.cacheWriteTokens') IS NOT 'integer')
    OR (json_extract(NEW.usage_snapshot, '$.semantics.reasoning') = 'excluded_from_output'
      AND json_type(NEW.usage_snapshot, '$.counts.reasoningTokens') IS NOT 'integer')
    THEN RAISE(ABORT, 'billing_usage_semantics_unknown') END);
  SELECT (CASE WHEN
    (CASE WHEN json_extract(NEW.usage_snapshot, '$.semantics.cacheRead') = 'included_in_input'
      THEN COALESCE(json_extract(NEW.usage_snapshot, '$.counts.cacheReadTokens'), 0) ELSE 0 END)
    + (CASE WHEN json_extract(NEW.usage_snapshot, '$.semantics.cacheWrite') = 'included_in_input'
      THEN COALESCE(json_extract(NEW.usage_snapshot, '$.counts.cacheWriteTokens'), 0) ELSE 0 END)
    > json_extract(NEW.usage_snapshot, '$.counts.inputTokens')
    OR (json_extract(NEW.usage_snapshot, '$.semantics.reasoning') = 'included_in_output'
      AND json_extract(NEW.usage_snapshot, '$.counts.reasoningTokens') > json_extract(NEW.usage_snapshot, '$.counts.outputTokens'))
    OR (json_extract(NEW.usage_snapshot, '$.semantics.cacheWriteTtl') = 'subsets_of_cache_write'
      AND COALESCE(json_extract(NEW.usage_snapshot, '$.counts.cacheWrite5mTokens'), 0)
        + COALESCE(json_extract(NEW.usage_snapshot, '$.counts.cacheWrite1hTokens'), 0)
        > json_extract(NEW.usage_snapshot, '$.counts.cacheWriteTokens'))
    THEN RAISE(ABORT, 'billing_usage_subsets_invalid') END);
END;

CREATE UNIQUE INDEX idx_api_keys_key_hash ON api_keys(key_hash) WHERE key_hash IS NOT NULL;
CREATE UNIQUE INDEX idx_api_keys_owner_creation_operation
  ON api_keys (user_id, creation_operation_id)
  WHERE creation_operation_id IS NOT NULL;
CREATE UNIQUE INDEX idx_api_keys_user_web_chat ON api_keys(user_id) WHERE kind='web_chat';
CREATE INDEX idx_api_keys_user_status ON api_keys (user_id, status);
CREATE INDEX idx_api_keys_expires ON api_keys (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_api_keys_group ON api_keys(group_id,status);
CREATE INDEX idx_api_keys_kind_user_status ON api_keys(kind,user_id,status);

-- Creation identity remains immutable for both kinds.  A virtual key has no
-- creation operation today, but retaining this guard protects future imports.
CREATE TRIGGER api_keys_creation_identity_immutable
BEFORE UPDATE OF user_id, creation_operation_id, creation_fingerprint ON api_keys
WHEN NEW.user_id IS NOT OLD.user_id
  OR NEW.creation_operation_id IS NOT OLD.creation_operation_id
  OR NEW.creation_fingerprint IS NOT OLD.creation_fingerprint
BEGIN
  SELECT RAISE(ABORT, 'api_key_creation_identity_immutable');
END;

-- Legacy API imports may omit group_id; the old compatibility behavior remains
-- available only to ordinary API rows and never mutates a virtual identity.
CREATE TRIGGER api_keys_default_group AFTER INSERT ON api_keys
WHEN NEW.kind='api' AND NEW.group_id IS NULL
BEGIN
  UPDATE api_keys SET group_id=(SELECT group_id FROM users WHERE id=NEW.user_id) WHERE id=NEW.id;
END;

CREATE TRIGGER api_keys_web_chat_group_insert
BEFORE INSERT ON api_keys
WHEN NEW.kind='web_chat' AND NEW.group_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'web_chat_group_must_be_null');
END;

CREATE TRIGGER api_keys_web_chat_group_update
BEFORE UPDATE OF kind,group_id ON api_keys
WHEN NEW.kind='web_chat' AND NEW.group_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'web_chat_group_must_be_null');
END;

CREATE TRIGGER api_keys_web_chat_fields_insert
BEFORE INSERT ON api_keys
WHEN NEW.kind='web_chat' AND (NEW.expires_at IS NOT NULL OR NEW.allowed_models_json IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT,'web_chat_fields_must_be_null');
END;

CREATE TRIGGER api_keys_web_chat_fields_update
BEFORE UPDATE OF kind,expires_at,allowed_models_json ON api_keys
WHEN NEW.kind='web_chat' AND (NEW.expires_at IS NOT NULL OR NEW.allowed_models_json IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT,'web_chat_fields_must_be_null');
END;

-- Do not silently accept a broken parent replacement.  This expression throws
-- only when SQLite reports an actual FK violation; otherwise it is a no-op.
SELECT CASE WHEN EXISTS(SELECT 1 FROM pragma_foreign_key_check)
  THEN json_extract('{}','api_keys_foreign_key_check_failed') ELSE 1 END;
PRAGMA defer_foreign_keys=OFF;
