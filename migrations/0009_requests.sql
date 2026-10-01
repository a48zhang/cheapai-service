-- Execution and billing states are independent. D13 owns settlement triggers;
-- this migration does not enforce authorization or cross-parent ownership.
CREATE TABLE requests (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(id)) > 0),
  user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  public_model_id TEXT NOT NULL REFERENCES models(public_model_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  upstream_model TEXT NOT NULL CHECK (length(trim(upstream_model)) > 0),
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
  error_message TEXT
);

CREATE INDEX idx_requests_user_created_id ON requests (user_id, created_at DESC, id);
CREATE INDEX idx_requests_channel_created_id ON requests (channel_id, created_at DESC, id);
CREATE INDEX idx_requests_billing_next_retry ON requests (billing_status, next_retry_at, id);
CREATE INDEX idx_requests_user_key_response ON requests (user_id, api_key_id, response_id) WHERE response_id IS NOT NULL;
