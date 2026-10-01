-- Only initialization data; reruns must never replace an administrator's values.
-- strftime('%s', 'now') is UTC Unix seconds; multiply to store milliseconds.
INSERT INTO groups (id, name, status, version, created_at, updated_at)
VALUES ('default', 'Default', 'active', 1,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000)
ON CONFLICT DO NOTHING;

INSERT INTO settings (key, value_json, version, updated_at)
VALUES ('registration', '{"registrationMode":"closed","emailVerificationEnabled":true}', 1,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000)
ON CONFLICT DO NOTHING;

INSERT INTO settings (key, value_json, version, updated_at)
VALUES ('default_group_id', '"default"', 1,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000)
ON CONFLICT DO NOTHING;

-- Other RuntimeConfig defaults stay in F10. No users, credentials or grants.
