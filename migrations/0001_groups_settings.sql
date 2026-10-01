-- Structural migration only. Default group/settings rows are seeded by D14.
-- Timestamps are explicit UTC Unix milliseconds; callers supply version/time.
CREATE TABLE groups (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(id)) > 0),
  name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0)
);

CREATE INDEX idx_groups_status_id ON groups (status, id);

CREATE TABLE settings (
  key TEXT NOT NULL PRIMARY KEY CHECK (length(trim(key)) > 0),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0)
);
