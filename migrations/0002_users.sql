-- Hash generation, registration consumption triggers and seeds live elsewhere.
-- All numeric values crossing the JavaScript/D1 boundary remain safe integers.
CREATE TABLE users (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(id)) > 0),
  -- SQLite lower() covers ASCII. Application code owns full email validation
  -- and Unicode normalization; storage rejects surrounding spaces/ASCII capitals.
  email_normalized TEXT NOT NULL UNIQUE CHECK (
    length(trim(email_normalized)) > 0 AND email_normalized = lower(trim(email_normalized))
  ),
  password_hash TEXT NOT NULL CHECK (length(trim(password_hash)) > 0),
  role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  email_verified_at INTEGER CHECK (
    email_verified_at IS NULL OR (typeof(email_verified_at) = 'integer' AND email_verified_at BETWEEN 0 AND 9007199254740991)
  ),
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  balance_units INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(balance_units) = 'integer' AND balance_units BETWEEN -9007199254740991 AND 9007199254740991
  ),
  concurrency_limit INTEGER NOT NULL CHECK (
    typeof(concurrency_limit) = 'integer' AND concurrency_limit BETWEEN 1 AND 9007199254740991
  ),
  rpm_limit INTEGER NOT NULL CHECK (
    typeof(rpm_limit) = 'integer' AND rpm_limit BETWEEN 1 AND 9007199254740991
  ),
  created_via TEXT NOT NULL CHECK (created_via IN ('registration', 'admin', 'bootstrap')),
  -- D05 owns the future registration_codes relationship; no forward FK here.
  registration_code_id TEXT CHECK (registration_code_id IS NULL OR length(trim(registration_code_id)) > 0),
  created_at INTEGER NOT NULL CHECK (
    typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991
  ),
  updated_at INTEGER NOT NULL CHECK (
    typeof(updated_at) = 'integer' AND updated_at BETWEEN 0 AND 9007199254740991
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(version) = 'integer' AND version BETWEEN 1 AND 9007199254740991
  )
);

CREATE INDEX idx_users_group_status ON users (group_id, status);
CREATE INDEX idx_users_status_created_id ON users (status, created_at, id);
