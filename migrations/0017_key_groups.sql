-- Existing primary membership remains the default grant. Additional grants are
-- managed explicitly; keys select a group, never an arbitrary collection of models.
CREATE TABLE user_group_access (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
  PRIMARY KEY(user_id,group_id)
);
CREATE INDEX idx_user_group_access_group ON user_group_access(group_id,user_id);
INSERT INTO user_group_access(user_id,group_id,created_at) SELECT id,group_id,created_at FROM users;
ALTER TABLE api_keys ADD COLUMN group_id TEXT REFERENCES groups(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
UPDATE api_keys SET group_id=(SELECT group_id FROM users WHERE users.id=api_keys.user_id),
  allowed_models_json=CASE WHEN json_array_length(allowed_models_json)=0 THEN NULL ELSE allowed_models_json END;
CREATE INDEX idx_api_keys_group ON api_keys(group_id,status);
CREATE TRIGGER users_default_group_access AFTER INSERT ON users
BEGIN
  INSERT INTO user_group_access(user_id,group_id,created_at) VALUES(NEW.id,NEW.group_id,NEW.created_at);
END;
-- Supports old trusted import fixtures and callers during a rolling deployment.
CREATE TRIGGER api_keys_default_group AFTER INSERT ON api_keys WHEN NEW.group_id IS NULL
BEGIN
  UPDATE api_keys SET group_id=(SELECT group_id FROM users WHERE id=NEW.user_id) WHERE id=NEW.id;
END;
