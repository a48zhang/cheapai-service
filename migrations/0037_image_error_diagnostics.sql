-- Owner-visible provider failure evidence; does not change delivery or billing policy.
ALTER TABLE image_generations ADD COLUMN error_diagnostic TEXT;
