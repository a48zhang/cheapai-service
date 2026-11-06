-- NULL snapshots identify legacy request-bound generations: never enqueue those.
ALTER TABLE image_generations ADD COLUMN execution_snapshot TEXT;
ALTER TABLE image_generations ADD COLUMN started_at INTEGER;
CREATE INDEX idx_image_generations_pending ON image_generations(status, billing_status, created_at);
