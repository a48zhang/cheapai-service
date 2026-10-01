-- Group billing prices are immutable request facts once copied into a price
-- snapshot. Keep the configured value as decimal text so no SQLite/JavaScript
-- floating point conversion can change a multiplier such as 0.2.
ALTER TABLE groups ADD COLUMN billing_multiplier TEXT NOT NULL DEFAULT '1' CHECK (
  typeof(billing_multiplier) = 'text'
  AND length(billing_multiplier) BETWEEN 1 AND 64
  AND billing_multiplier = trim(billing_multiplier)
  AND billing_multiplier NOT GLOB '*[^0-9.]*'
  AND billing_multiplier NOT LIKE '%.%.%'
  AND billing_multiplier NOT LIKE '.%'
  AND billing_multiplier NOT LIKE '%.'
  AND (billing_multiplier = '0' OR billing_multiplier NOT GLOB '0[0-9]*')
  AND (instr(billing_multiplier, '.') = 0
    OR length(billing_multiplier) - instr(billing_multiplier, '.') BETWEEN 1 AND 18)
);
