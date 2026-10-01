-- One mutable challenge slot per email/purpose, including after consumption.
-- Resends increment generation and replace the code MAC; no plaintext code.
CREATE TABLE email_challenges (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(id)) > 0),
  email_normalized TEXT NOT NULL CHECK (
    length(trim(email_normalized)) > 0 AND email_normalized = lower(trim(email_normalized))
  ),
  purpose TEXT NOT NULL CHECK (purpose = 'registration'),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (typeof(generation) = 'integer' AND generation BETWEEN 1 AND 9007199254740991),
  code_mac TEXT NOT NULL CHECK (length(code_mac) = 64 AND code_mac NOT GLOB '*[^0-9a-f]*'),
  expires_at INTEGER NOT NULL CHECK (
    typeof(expires_at) = 'integer' AND expires_at BETWEEN 0 AND 9007199254740991 AND expires_at > created_at
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 9007199254740991),
  send_status TEXT NOT NULL DEFAULT 'sending' CHECK (send_status IN ('sending', 'accepted', 'failed', 'unknown')),
  consumed_at INTEGER CHECK (
    consumed_at IS NULL OR (typeof(consumed_at) = 'integer' AND consumed_at BETWEEN 0 AND 9007199254740991)
  ),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at BETWEEN 0 AND 9007199254740991),
  -- Separate resend cooldown timestamp; never infer it from unrelated updates.
  send_requested_at INTEGER NOT NULL CHECK (typeof(send_requested_at) = 'integer' AND send_requested_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (email_normalized, purpose)
);

CREATE INDEX idx_email_challenges_expires ON email_challenges (expires_at);

-- A14 owns generation-conditioned delivery callbacks and resend policy.
-- D12 owns atomic registration consumption; attempts may be updated separately.
