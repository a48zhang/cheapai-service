-- Preserve existing ledger facts and accounting triggers; add a distinct image charge.
CREATE TABLE billing_entries_images (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(id)) > 0),
  operation_id TEXT NOT NULL UNIQUE CHECK (length(trim(operation_id)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('consumption', 'adjustment', 'grant', 'image_generation')),
  user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  image_generation_id TEXT REFERENCES image_generations(id) ON DELETE RESTRICT,
  request_id TEXT REFERENCES requests(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  delta_units INTEGER NOT NULL CHECK (typeof(delta_units) = 'integer' AND delta_units BETWEEN -9007199254740991 AND 9007199254740991),
  fingerprint TEXT NOT NULL CHECK (length(trim(fingerprint)) > 0),
  usage_snapshot TEXT CHECK (
    usage_snapshot IS NULL OR CASE WHEN json_valid(usage_snapshot) THEN json_type(usage_snapshot) IS 'object' ELSE 0 END
  ),
  price_snapshot TEXT CHECK (
    price_snapshot IS NULL OR CASE WHEN json_valid(price_snapshot) THEN json_type(price_snapshot) IS 'object' ELSE 0 END
  ),
  created_by TEXT REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  reason TEXT CHECK (reason IS NULL OR length(trim(reason)) > 0),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
  CHECK (kind <> 'consumption' OR (request_id IS NOT NULL AND delta_units <= 0 AND usage_snapshot IS NOT NULL AND price_snapshot IS NOT NULL)),
  CHECK (kind <> 'grant' OR delta_units > 0),
  CHECK (kind IN ('consumption','image_generation') OR reason IS NOT NULL),
  CHECK ((kind = 'image_generation' AND image_generation_id IS NOT NULL AND request_id IS NULL AND delta_units<=0 AND price_snapshot IS NOT NULL AND usage_snapshot IS NOT NULL) OR (kind <> 'image_generation' AND image_generation_id IS NULL))
);

INSERT INTO billing_entries_images (rowid,id,operation_id,kind,user_id,request_id,currency,delta_units,fingerprint,usage_snapshot,price_snapshot,created_by,reason,created_at) SELECT rowid,id,operation_id,kind,user_id,request_id,currency,delta_units,fingerprint,usage_snapshot,price_snapshot,created_by,reason,created_at FROM billing_entries;

DROP TABLE billing_entries;

ALTER TABLE billing_entries_images RENAME TO billing_entries;

CREATE UNIQUE INDEX idx_billing_entries_consumption_request ON billing_entries (request_id) WHERE kind = 'consumption';

CREATE INDEX idx_billing_entries_user_created_id ON billing_entries (user_id, created_at DESC, id);

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

CREATE TRIGGER billing_entries_no_delete
BEFORE DELETE ON billing_entries
BEGIN
  SELECT RAISE(ABORT, 'billing_entries_append_only');
END;

CREATE TRIGGER billing_entries_no_replace
BEFORE INSERT ON billing_entries
WHEN EXISTS (
  SELECT 1 FROM billing_entries
  WHERE id = NEW.id OR operation_id = NEW.operation_id
    OR (NEW.kind = 'consumption' AND kind = 'consumption' AND request_id = NEW.request_id)
)
BEGIN
  SELECT RAISE(ABORT, 'billing_entries_append_only');
END;

CREATE TRIGGER billing_entries_no_update
BEFORE UPDATE ON billing_entries
BEGIN
  SELECT RAISE(ABORT, 'billing_entries_append_only');
END;

CREATE TRIGGER billing_entries_validate_balance
BEFORE INSERT ON billing_entries
BEGIN
  SELECT (CASE WHEN NEW.currency IS NOT 'USD'
    OR typeof(NEW.delta_units) <> 'integer'
    OR NEW.delta_units NOT BETWEEN -9007199254740991 AND 9007199254740991
    THEN RAISE(ABORT, 'billing_invalid_amount') END);
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM users WHERE id = NEW.user_id
      AND typeof(balance_units) = 'integer'
      AND balance_units + NEW.delta_units BETWEEN -9007199254740991 AND 9007199254740991
    ) THEN RAISE(ABORT, 'billing_balance_unavailable_or_overflow') END);
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

CREATE UNIQUE INDEX idx_billing_entries_image_generation ON billing_entries(image_generation_id) WHERE kind='image_generation';

CREATE TRIGGER billing_entries_validate_image
BEFORE INSERT ON billing_entries WHEN NEW.kind='image_generation'
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM image_generations j WHERE j.id=NEW.image_generation_id
    AND j.user_id=NEW.user_id AND j.status='completed' AND j.billing_status='pending'
    AND j.price_units=-NEW.delta_units AND j.price_snapshot=NEW.price_snapshot
    AND NEW.operation_id='image:'||j.id
    AND json_extract(NEW.usage_snapshot,'$.images')=1
  ) THEN RAISE(ABORT,'billing_image_mismatch_or_settled') END);
END;

CREATE TRIGGER billing_entries_apply_image
AFTER INSERT ON billing_entries WHEN NEW.kind='image_generation'
BEGIN
  UPDATE image_generations SET billing_status='settled',updated_at=max(updated_at,NEW.created_at)
    WHERE id=NEW.image_generation_id AND user_id=NEW.user_id AND billing_status='pending';
  SELECT (CASE WHEN changes()<>1 THEN RAISE(ABORT,'billing_image_update_missing') END);
END;
