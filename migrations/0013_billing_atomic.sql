-- Parenthesized CASE keeps D1 remote migration statement splitting inside the trigger.
-- Contract: usage_snapshot is a complete P01 UsageSnapshot. price_snapshot is
-- the exact immutable JSON string already stored on the request. fingerprint
-- is the service-computed opaque nonempty digest; SQL never recomputes prices.
-- D10 uniqueness/append-only protection remains in force for replay/REPLACE.
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
  -- Unknown inclusion is harmless only for an explicit zero counter. Excluded
  -- counters must be observed because they are additional to the base totals.
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
  -- Validate known inclusion/subset contradictions; missing optional counters
  -- remain unknown. B02 decides which missing dimensions affect the price.
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
