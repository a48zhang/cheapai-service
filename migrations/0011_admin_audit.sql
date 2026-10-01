-- O01 must redact credentials before storage; DDL validates shape, not secrets.
-- Business transactions own idempotency. One operation may audit many targets.
CREATE TABLE admin_audit (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(id)) > 0),
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  action TEXT NOT NULL CHECK (length(trim(action)) > 0),
  target_type TEXT NOT NULL CHECK (length(trim(target_type)) > 0),
  target_id TEXT NOT NULL CHECK (length(trim(target_id)) > 0),
  redacted_change_json TEXT NOT NULL CHECK (
    CASE WHEN json_valid(redacted_change_json)
      THEN json_type(redacted_change_json) = 'object' ELSE 0 END
  ),
  operation_id TEXT NOT NULL CHECK (length(trim(operation_id)) > 0),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991)
);

CREATE INDEX idx_admin_audit_actor_created ON admin_audit (actor_id, created_at, id);
CREATE INDEX idx_admin_audit_target_created ON admin_audit (target_type, target_id, created_at);
CREATE INDEX idx_admin_audit_operation ON admin_audit (operation_id);
