ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS destruction_status text NOT NULL DEFAULT 'pending'
    CHECK (destruction_status IN ('pending','deleting','retry','destroyed')),
  ADD COLUMN IF NOT EXISTS destruction_claim_token uuid,
  ADD COLUMN IF NOT EXISTS destruction_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS destruction_attempts integer NOT NULL DEFAULT 0 CHECK (destruction_attempts >= 0),
  ADD COLUMN IF NOT EXISTS destruction_next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS destroyed_at timestamptz;

CREATE INDEX IF NOT EXISTS artifacts_retention_due_idx
  ON artifacts(retention_until, destruction_next_attempt_at)
  WHERE availability = 'available' AND retention_until IS NOT NULL AND destruction_status IN ('pending','retry','deleting');
