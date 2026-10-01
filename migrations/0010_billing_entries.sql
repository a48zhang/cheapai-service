-- Immutable accounting facts. D13 owns the separate INSERT accounting effects.
-- USD uses 100,000,000 units per dollar; all values round-trip through D1 safely.
CREATE TABLE billing_entries (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(id)) > 0),
  operation_id TEXT NOT NULL UNIQUE CHECK (length(trim(operation_id)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('consumption', 'adjustment', 'grant')),
  user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
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
  CHECK (kind = 'consumption' OR reason IS NOT NULL)
);

-- Adjustments can reference the same request many times with new operation IDs.
CREATE UNIQUE INDEX idx_billing_entries_consumption_request ON billing_entries (request_id) WHERE kind = 'consumption';
CREATE INDEX idx_billing_entries_user_created_id ON billing_entries (user_id, created_at DESC, id);

CREATE TRIGGER billing_entries_no_update
BEFORE UPDATE ON billing_entries
BEGIN
  SELECT RAISE(ABORT, 'billing_entries_append_only');
END;

CREATE TRIGGER billing_entries_no_delete
BEFORE DELETE ON billing_entries
BEGIN
  SELECT RAISE(ABORT, 'billing_entries_append_only');
END;

-- REPLACE may delete a conflicting row without firing DELETE triggers when
-- recursive_triggers is off. Reject conflicts before that implicit deletion.
-- This complements UNIQUE constraints; it is not an application prefetch lock.
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
