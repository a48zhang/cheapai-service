-- Channels now store the upstream key directly. Existing encrypted credentials
-- cannot be converted without the old keyring, so preserve their original bytes.
-- Such channels need the administrator to enter their upstream key again.
-- D1 keeps foreign keys enabled; defer checks while replacing the parent table.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE channels_plaintext (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(id)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  base_url TEXT NOT NULL CHECK (length(trim(base_url)) > 0),
  upstream_key TEXT CHECK (upstream_key IS NULL OR (typeof(upstream_key) = 'text' AND length(trim(upstream_key)) > 0)),
  -- Retained only to preserve credentials written before this migration.
  secret_ciphertext TEXT CHECK (
    secret_ciphertext IS NULL OR CASE WHEN json_valid(secret_ciphertext) THEN
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
  secret_key_version TEXT CHECK (secret_key_version IS NULL OR length(trim(secret_key_version)) > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  -- Priority is an explicit nonnegative integer, not a concurrency allowance.
  priority INTEGER NOT NULL CHECK (typeof(priority) = 'integer' AND priority BETWEEN 0 AND 9007199254740991),
  concurrency_limit INTEGER NOT NULL CHECK (typeof(concurrency_limit) = 'integer' AND concurrency_limit BETWEEN 1 AND 9007199254740991),
  rpm_limit INTEGER NOT NULL CHECK (typeof(rpm_limit) = 'integer' AND rpm_limit BETWEEN 1 AND 9007199254740991),
  config_version INTEGER NOT NULL CHECK (typeof(config_version) = 'integer' AND config_version BETWEEN 1 AND 9007199254740991),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at BETWEEN 0 AND 9007199254740991 AND updated_at >= created_at),
  CHECK ((secret_ciphertext IS NULL) = (secret_key_version IS NULL)),
  CHECK (upstream_key IS NOT NULL OR secret_ciphertext IS NOT NULL)
);

INSERT INTO channels_plaintext (id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
SELECT id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at FROM channels;
DROP TABLE channels;
ALTER TABLE channels_plaintext RENAME TO channels;
CREATE INDEX idx_channels_status_priority_id ON channels (status, priority, id);

-- Rebuilding a referenced parent leaves SQLite's deferred violation counter
-- set even after the table is restored. Check actual rows before clearing it.
SELECT CASE WHEN EXISTS(SELECT 1 FROM pragma_foreign_key_check)
  THEN json_extract('{}','channels_foreign_key_check_failed') ELSE 1 END;
PRAGMA defer_foreign_keys = OFF;
