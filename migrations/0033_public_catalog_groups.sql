-- Publishing a group's name, inventory and effective prices is explicit.
-- Existing account access and billing are unchanged.
ALTER TABLE groups ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0,1));
