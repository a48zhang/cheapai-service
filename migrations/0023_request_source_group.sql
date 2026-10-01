-- Requests retain the group selected at admission and the trusted entry point.
-- A NULL group is intentional for pre-0023 history whose group cannot be
-- reconstructed from the then-current Key; new registrations always persist it.
ALTER TABLE requests ADD COLUMN group_id TEXT REFERENCES groups(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE requests ADD COLUMN source TEXT NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'web_chat'));

CREATE INDEX idx_requests_user_group_created_id
  ON requests (user_id, group_id, created_at DESC, id);
CREATE INDEX idx_requests_source_created_id
  ON requests (source, created_at DESC, id);
