-- Web chat history and generation state. Requests remain independent so
-- deleting a conversation never deletes billing or request evidence.
CREATE TABLE chat_conversations (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(id)) > 0 AND length(id) <= 128 AND id NOT GLOB '*[^A-Za-z0-9_.:/-]*'),
  user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  title TEXT NOT NULL DEFAULT '' CHECK (length(CAST(title AS BLOB)) <= 1024 AND instr(title, char(0)) = 0),
  group_id TEXT REFERENCES groups(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  model_id TEXT REFERENCES models(public_model_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version BETWEEN 1 AND 9007199254740991),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at BETWEEN 0 AND 9007199254740991)
);

CREATE INDEX idx_chat_conversations_user_updated_id
  ON chat_conversations (user_id, updated_at DESC, id);

CREATE TABLE chat_messages (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(id)) > 0 AND length(id) <= 128 AND id NOT GLOB '*[^A-Za-z0-9_.:/-]*'),
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  turn_index INTEGER NOT NULL CHECK (typeof(turn_index) = 'integer' AND turn_index >= 1 AND turn_index <= 9007199254740991),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL CHECK (length(CAST(content AS BLOB)) <= 1048576 AND instr(content, char(0)) = 0),
  status TEXT NOT NULL CHECK (status IN ('generating', 'completed', 'stopped', 'failed')),
  variant INTEGER NOT NULL DEFAULT 1 CHECK (typeof(variant) = 'integer' AND variant >= 1 AND variant <= 9007199254740991),
  selected INTEGER NOT NULL DEFAULT 1 CHECK (selected IN (0, 1)),
  operation_id TEXT CHECK (operation_id IS NULL OR (length(operation_id) BETWEEN 1 AND 128 AND operation_id NOT GLOB '*[^A-Za-z0-9_.:-]*')),
  request_id TEXT REFERENCES requests(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  group_id TEXT REFERENCES groups(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  model_id TEXT REFERENCES models(public_model_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at BETWEEN 0 AND 9007199254740991),
  CHECK (
    (role = 'user' AND status = 'completed' AND variant = 1 AND selected = 1
      AND request_id IS NULL AND group_id IS NULL AND model_id IS NULL)
    OR
    (role = 'assistant' AND (status = 'generating' OR status = 'completed' OR status = 'stopped' OR status = 'failed'))
  ),
  UNIQUE (conversation_id, operation_id, role)
);

-- There is one user row per turn, one selected assistant version per turn, and
-- at most one in-flight assistant in a conversation. NULL operation IDs are
-- intentionally allowed for imported/legacy rows, while new writes always
-- provide one.
CREATE UNIQUE INDEX idx_chat_messages_user_turn
  ON chat_messages (conversation_id, turn_index) WHERE role = 'user';
CREATE UNIQUE INDEX idx_chat_messages_selected_assistant
  ON chat_messages (conversation_id, turn_index) WHERE role = 'assistant' AND selected = 1;
CREATE UNIQUE INDEX idx_chat_messages_generating_conversation
  ON chat_messages (conversation_id) WHERE role = 'assistant' AND status = 'generating';
CREATE UNIQUE INDEX idx_chat_messages_request
  ON chat_messages (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX idx_chat_messages_conversation_turn
  ON chat_messages (conversation_id, turn_index, role, variant);
CREATE INDEX idx_chat_messages_operation
  ON chat_messages (conversation_id, operation_id) WHERE operation_id IS NOT NULL;
