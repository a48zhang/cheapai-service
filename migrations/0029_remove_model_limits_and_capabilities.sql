-- Provider output budgets belong to individual requests. Model/channel metadata
-- no longer imposes output ceilings or a model-specific balance threshold.
-- SQLite drops these column-local checks with their columns. Rows, indexes,
-- foreign keys, version counters and historical request snapshots stay intact.
ALTER TABLE models DROP COLUMN max_output_tokens;
ALTER TABLE models DROP COLUMN admission_min_balance_units;
ALTER TABLE channel_models DROP COLUMN capabilities_json;
