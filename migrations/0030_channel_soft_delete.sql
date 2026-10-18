-- Keep channel identity for request history and billing references.
ALTER TABLE channels ADD COLUMN deleted_at INTEGER CHECK (
  deleted_at IS NULL OR (typeof(deleted_at) = 'integer' AND deleted_at BETWEEN 0 AND 9007199254740991)
);
CREATE TRIGGER channels_deleted_stays_disabled BEFORE UPDATE ON channels
WHEN OLD.deleted_at IS NOT NULL AND (NEW.deleted_at IS NULL OR NEW.status != 'disabled')
BEGIN SELECT RAISE(ABORT, 'channel_write_conflict'); END;
CREATE TRIGGER channel_models_live_parent BEFORE INSERT ON channel_models
WHEN EXISTS (SELECT 1 FROM channels WHERE id=NEW.channel_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'model_mapping_conflict'); END;
CREATE TRIGGER channel_groups_live_parent BEFORE INSERT ON channel_groups
WHEN EXISTS (SELECT 1 FROM channels WHERE id=NEW.channel_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'group_write_conflict'); END;
