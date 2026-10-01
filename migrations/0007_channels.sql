-- Channels contain encrypted C01 envelopes, never plaintext upstream keys.
-- API code performs encryption and URL policy validation; SQL checks structure.
CREATE TABLE channels (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(id)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  base_url TEXT NOT NULL CHECK (length(trim(base_url)) > 0),
  secret_ciphertext TEXT NOT NULL CHECK (
    CASE WHEN json_valid(secret_ciphertext) THEN
      json_type(secret_ciphertext) IS 'object'
      AND json_extract(secret_ciphertext, '$.algorithm') IS 'A256GCM'
      AND json_type(secret_ciphertext, '$.format_version') IS 'integer'
      AND json_extract(secret_ciphertext, '$.format_version') IS 1
      AND json_type(secret_ciphertext, '$.key_version') IS 'text'
      AND json_extract(secret_ciphertext, '$.key_version') IS secret_key_version
      AND json_type(secret_ciphertext, '$.nonce') IS 'text'
      AND length(json_extract(secret_ciphertext, '$.nonce')) > 0
      AND json_type(secret_ciphertext, '$.ciphertext') IS 'text'
      AND length(json_extract(secret_ciphertext, '$.ciphertext')) > 0
    ELSE 0 END
  ),
  secret_key_version TEXT NOT NULL CHECK (length(trim(secret_key_version)) > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  -- Priority is an explicit nonnegative integer, not a concurrency allowance.
  priority INTEGER NOT NULL CHECK (typeof(priority) = 'integer' AND priority BETWEEN 0 AND 9007199254740991),
  concurrency_limit INTEGER NOT NULL CHECK (typeof(concurrency_limit) = 'integer' AND concurrency_limit BETWEEN 1 AND 9007199254740991),
  rpm_limit INTEGER NOT NULL CHECK (typeof(rpm_limit) = 'integer' AND rpm_limit BETWEEN 1 AND 9007199254740991),
  config_version INTEGER NOT NULL CHECK (typeof(config_version) = 'integer' AND config_version BETWEEN 1 AND 9007199254740991),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at BETWEEN 0 AND 9007199254740991 AND updated_at >= created_at)
);

CREATE INDEX idx_channels_status_priority_id ON channels (status, priority, id);

CREATE TABLE channel_groups (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  group_id TEXT NOT NULL REFERENCES groups(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  PRIMARY KEY (channel_id, group_id)
);

CREATE INDEX idx_channel_groups_group_channel ON channel_groups (group_id, channel_id);
