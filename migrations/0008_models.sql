-- No model or price seeds. Callers must explicitly provide every required value.
-- C08/B02 validate price/capability fields; SQL only requires JSON objects.
CREATE TABLE models (
  public_model_id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(public_model_id)) > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  sell_prices_json TEXT NOT NULL CHECK (
    CASE WHEN json_valid(sell_prices_json) THEN json_type(sell_prices_json) IS 'object' ELSE 0 END
  ),
  price_version INTEGER NOT NULL CHECK (typeof(price_version) = 'integer' AND price_version BETWEEN 1 AND 9007199254740991),
  -- Nonnegative integer units, never USD floating-point values or a reservation.
  admission_min_balance_units INTEGER NOT NULL CHECK (typeof(admission_min_balance_units) = 'integer' AND admission_min_balance_units BETWEEN 0 AND 9007199254740991),
  max_output_tokens INTEGER NOT NULL CHECK (typeof(max_output_tokens) = 'integer' AND max_output_tokens BETWEEN 1 AND 9007199254740991),
  default_output_tokens INTEGER NOT NULL CHECK (typeof(default_output_tokens) = 'integer' AND default_output_tokens BETWEEN 1 AND 9007199254740991 AND default_output_tokens <= max_output_tokens),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at BETWEEN 0 AND 9007199254740991 AND updated_at >= created_at)
);

CREATE INDEX idx_models_status_id ON models (status, public_model_id);

CREATE TABLE channel_models (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  public_model_id TEXT NOT NULL REFERENCES models(public_model_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  upstream_model TEXT NOT NULL CHECK (length(trim(upstream_model)) > 0),
  protocol TEXT NOT NULL CHECK (protocol IN ('chat', 'responses', 'messages')),
  capabilities_json TEXT NOT NULL CHECK (
    CASE WHEN json_valid(capabilities_json) THEN json_type(capabilities_json) IS 'object' ELSE 0 END
  ),
  config_version INTEGER NOT NULL CHECK (typeof(config_version) = 'integer' AND config_version BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (channel_id, public_model_id, protocol)
);

CREATE INDEX idx_channel_models_model_protocol_channel ON channel_models (public_model_id, protocol, channel_id);
