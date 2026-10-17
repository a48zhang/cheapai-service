-- Upstream model names are opaque strings in mappings and request evidence.

-- Replace both tables while preserving rows, keys, indexes and billing triggers.

PRAGMA defer_foreign_keys = ON;

DROP TRIGGER billing_entries_apply_atomically;

DROP TRIGGER billing_entries_validate_consumption;

CREATE TABLE channel_models_opaque (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  public_model_id TEXT NOT NULL REFERENCES models(public_model_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  upstream_model TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('chat', 'responses', 'messages')),
  capabilities_json TEXT NOT NULL CHECK (
    CASE WHEN json_valid(capabilities_json) THEN json_type(capabilities_json) IS 'object' ELSE 0 END
  ),
  config_version INTEGER NOT NULL CHECK (typeof(config_version) = 'integer' AND config_version BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (channel_id, public_model_id, protocol)
);

INSERT INTO channel_models_opaque (channel_id,public_model_id,upstream_model,protocol,capabilities_json,config_version)
SELECT channel_id,public_model_id,upstream_model,protocol,capabilities_json,config_version FROM channel_models;

DROP TABLE channel_models;

ALTER TABLE channel_models_opaque RENAME TO channel_models;

CREATE INDEX idx_channel_models_model_protocol_channel ON channel_models (public_model_id, protocol, channel_id);

CREATE TABLE requests_opaque (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(id)) > 0),
  user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  public_model_id TEXT NOT NULL REFERENCES models(public_model_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  upstream_model TEXT NOT NULL,
  downstream_protocol TEXT NOT NULL CHECK (downstream_protocol IN ('chat', 'responses', 'messages')),
  upstream_protocol TEXT NOT NULL CHECK (upstream_protocol IN ('chat', 'responses', 'messages')),
  price_snapshot TEXT NOT NULL CHECK (
    CASE WHEN json_valid(price_snapshot) THEN json_type(price_snapshot) IS 'object' ELSE 0 END
  ),
  execution_status TEXT NOT NULL DEFAULT 'admitted' CHECK (execution_status IN ('admitted', 'succeeded', 'failed', 'cancelled', 'abandoned')),
  billing_status TEXT NOT NULL DEFAULT 'awaiting_usage' CHECK (billing_status IN ('awaiting_usage', 'settled', 'not_chargeable', 'settlement_pending', 'usage_unknown')),
  usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  usage_quality TEXT NOT NULL DEFAULT 'missing' CHECK (usage_quality IN ('complete', 'partial', 'missing', 'invalid')),
  cost_units INTEGER CHECK (cost_units IS NULL OR (typeof(cost_units) = 'integer' AND cost_units BETWEEN 0 AND 9007199254740991)),
  fingerprint TEXT CHECK (fingerprint IS NULL OR length(trim(fingerprint)) > 0),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(retry_count) = 'integer' AND retry_count BETWEEN 0 AND 9007199254740991),
  next_retry_at INTEGER CHECK (next_retry_at IS NULL OR (typeof(next_retry_at) = 'integer' AND next_retry_at BETWEEN 0 AND 9007199254740991)),
  upstream_request_id TEXT CHECK (upstream_request_id IS NULL OR length(trim(upstream_request_id)) > 0),
  response_id TEXT CHECK (response_id IS NULL OR length(trim(response_id)) > 0),
  -- At most two generation attempt summaries and 16 KiB of JSON text. Detailed
  -- attempt fields/redaction are checked by the gateway, not interpreted here.
  attempts_json TEXT NOT NULL DEFAULT '[]' CHECK (
    CASE WHEN json_valid(attempts_json) THEN
      json_type(attempts_json) IS 'array' AND json_array_length(attempts_json) <= 2
      AND length(CAST(attempts_json AS BLOB)) <= 16384
    ELSE 0 END
  ),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
  started_at INTEGER CHECK (started_at IS NULL OR (typeof(started_at) = 'integer' AND started_at BETWEEN 0 AND 9007199254740991)),
  finished_at INTEGER CHECK (finished_at IS NULL OR (typeof(finished_at) = 'integer' AND finished_at BETWEEN 0 AND 9007199254740991)),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at BETWEEN 0 AND 9007199254740991),
  error_code TEXT,
  error_message TEXT,
  group_id TEXT REFERENCES groups(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source TEXT NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'web_chat'))
);

INSERT INTO requests_opaque (id,user_id,api_key_id,channel_id,public_model_id,upstream_model,downstream_protocol,upstream_protocol,price_snapshot,execution_status,billing_status,usage_json,usage_quality,cost_units,fingerprint,retry_count,next_retry_at,upstream_request_id,response_id,attempts_json,created_at,started_at,finished_at,updated_at,error_code,error_message,group_id,source)
SELECT id,user_id,api_key_id,channel_id,public_model_id,upstream_model,downstream_protocol,upstream_protocol,price_snapshot,execution_status,billing_status,usage_json,usage_quality,cost_units,fingerprint,retry_count,next_retry_at,upstream_request_id,response_id,attempts_json,created_at,started_at,finished_at,updated_at,error_code,error_message,group_id,source FROM requests;

DROP TABLE requests;

ALTER TABLE requests_opaque RENAME TO requests;

CREATE INDEX idx_requests_billing_next_retry ON requests (billing_status, next_retry_at, id);

CREATE INDEX idx_requests_channel_created_id ON requests (channel_id, created_at DESC, id);

CREATE INDEX idx_requests_source_created_id
  ON requests (source, created_at DESC, id);

CREATE INDEX idx_requests_user_created_id ON requests (user_id, created_at DESC, id);

CREATE INDEX idx_requests_user_group_created_id
  ON requests (user_id, group_id, created_at DESC, id);

CREATE INDEX idx_requests_user_key_response ON requests (user_id, api_key_id, response_id) WHERE response_id IS NOT NULL;

CREATE TRIGGER billing_entries_apply_atomically
AFTER INSERT ON billing_entries
BEGIN
  -- SQL integer addition is exact here; input/result bounds are below int64.
  -- Do not reject an already incurred charge merely because balance becomes negative.
  UPDATE users SET balance_units = balance_units + NEW.delta_units,
    updated_at = max(updated_at, NEW.created_at)
  WHERE id = NEW.user_id AND balance_units + NEW.delta_units BETWEEN -9007199254740991 AND 9007199254740991;
  SELECT (CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'billing_balance_update_missing') END);

  UPDATE requests SET usage_json = NEW.usage_snapshot, usage_quality = 'complete',
    cost_units = -NEW.delta_units, billing_status = 'settled', fingerprint = NEW.fingerprint,
    updated_at = max(updated_at, NEW.created_at)
  WHERE NEW.kind = 'consumption' AND id = NEW.request_id AND user_id = NEW.user_id
    AND billing_status <> 'settled' AND price_snapshot = NEW.price_snapshot
    AND (fingerprint IS NULL OR fingerprint = NEW.fingerprint);
  SELECT (CASE WHEN NEW.kind = 'consumption' AND changes() <> 1
    THEN RAISE(ABORT, 'billing_request_update_missing') END);
END;

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

-- Match the parent-replacement foreign-key validation used by migration 0025.

SELECT CASE WHEN EXISTS(SELECT 1 FROM pragma_foreign_key_check)
  THEN json_extract('{}','upstream_model_foreign_key_check_failed') ELSE 1 END;

PRAGMA defer_foreign_keys = OFF;
