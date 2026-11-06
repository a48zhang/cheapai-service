-- Delivery status does not decide billing. Preserve existing ledger and price facts.
UPDATE image_generations SET status='failed',error='delivery_failed'
WHERE status='unknown';
UPDATE image_generations SET error='delivery_failed' WHERE error='result_unknown';

-- Preserve the referenced table/ledger without rebuilding foreign keys.
CREATE TRIGGER image_generations_valid_state_insert
BEFORE INSERT ON image_generations
WHEN NEW.status NOT IN ('generating','completed','failed')
  OR NEW.error='result_unknown'
BEGIN SELECT RAISE(ABORT,'image_delivery_state_invalid'); END;
CREATE TRIGGER image_generations_valid_state_update
BEFORE UPDATE ON image_generations
WHEN NEW.status NOT IN ('generating','completed','failed')
  OR NEW.error='result_unknown'
BEGIN SELECT RAISE(ABORT,'image_delivery_state_invalid'); END;
