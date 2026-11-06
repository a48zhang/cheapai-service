-- This records our inability to deliver, not an assertion about upstream execution.
UPDATE image_generations SET status='failed',error='delivery_failed'
WHERE status='unknown';
UPDATE image_generations SET error='delivery_failed' WHERE error='result_unknown';

-- Preserve the referenced table/ledger without rebuilding foreign keys.
CREATE TRIGGER image_generations_valid_state_insert
BEFORE INSERT ON image_generations
WHEN NEW.status NOT IN ('generating','completed','failed')
  OR NEW.error='result_unknown'
  OR (NEW.status='failed' AND NEW.billing_status<>'unbilled')
BEGIN SELECT RAISE(ABORT,'image_delivery_state_invalid'); END;
CREATE TRIGGER image_generations_valid_state_update
BEFORE UPDATE ON image_generations
WHEN NEW.status NOT IN ('generating','completed','failed')
  OR NEW.error='result_unknown'
  OR (NEW.status='failed' AND NEW.billing_status<>'unbilled')
BEGIN SELECT RAISE(ABORT,'image_delivery_state_invalid'); END;
CREATE TRIGGER image_generations_failed_is_final
BEFORE UPDATE ON image_generations
WHEN OLD.status='failed' AND NEW.status<>'failed'
BEGIN SELECT RAISE(ABORT,'image_delivery_failure_is_final'); END;
